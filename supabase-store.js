// 項目の保存（Supabase 版）。store.js の LocalStore と同じ形の関数を持つ。
(function (root) {
  'use strict';

  function fromRow(r) {
    return {
      id: r.id,
      content: r.content,
      action: r.action || '',
      progress: r.progress || '',
      assignee: r.assignee || '',
      due: r.due || null,
      status: r.status,
      priority: r.priority || null,
      attachments: r.attachments || [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  const COLUMNS = {
    id: 'id', content: 'content', action: 'action', progress: 'progress', assignee: 'assignee', due: 'due',
    status: 'status', priority: 'priority', attachments: 'attachments',
    createdAt: 'created_at', updatedAt: 'updated_at',
  };

  function toRow(fields) {
    const row = {};
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (key in fields) row[column] = fields[key];
    }
    return row;
  }

  function unwrap({ data, error }) {
    if (error) throw new Error(error.message || '通信に失敗しました');
    return data;
  }

  // 「進捗」の列をまだ Supabase に追加していない場合（supabase/add-progress.sql が未実行）でも、
  // 進捗が空なら今までどおり保存できるようにする。進捗に文字があるときは、黙って捨てずに失敗させる。
  async function send(row, run) {
    const result = await run(row);
    if (result.error && result.error.code === 'PGRST204' && 'progress' in row && !row.progress) {
      const rest = { ...row };
      delete rest.progress;
      return unwrap(await run(rest));
    }
    return unwrap(result);
  }

  root.createRemoteStore = function (config) {
    const client = root.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    const table = () => client.from('items');
    const subscriptions = () => client.from('push_subscriptions');
    const reportUrl = `${config.supabaseUrl}/functions/v1/report`;

    async function callReport(init) {
      const response = await fetch(reportUrl, init);
      if (!response.ok) throw new Error(`通知のプログラムが応答しません（${response.status}）`);
      return response.json();
    }

    async function postReport(body) {
      const { data } = await client.auth.getSession();
      return callReport({
        method: 'POST',
        headers: {
          apikey: config.supabaseKey,
          Authorization: `Bearer ${data.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }

    return {
      remote: true,

      async list() {
        return unwrap(await table().select('*')).map(fromRow);
      },

      async add(fields) {
        const { content, action, progress, assignee, due } = fields;
        const row = toRow({ content, action, progress, assignee, due });
        if (fields.attachments && fields.attachments.length) row.attachments = fields.attachments;
        return fromRow(await send(row, (r) => table().insert(r).select().single()));
      },

      async update(id, patch) {
        const row = { ...toRow(patch), updated_at: new Date().toISOString() };
        delete row.id;
        return fromRow(await send(row, (r) => table().update(r).eq('id', id).select().single()));
      },

      async remove(id) {
        unwrap(await table().delete().eq('id', id));
      },

      async restore(item) {
        await send(toRow(item), (r) => table().upsert(r));
      },

      // 別の端末での変更は、ページに戻ってきたときに読み直す
      onChange(callback) {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') callback();
        });
      },

      // ---- 通知 ----
      async pushPublicKey() {
        return (await callReport({ headers: { apikey: config.supabaseKey } })).publicKey;
      },

      async savePushSubscription(sub) {
        unwrap(await subscriptions().upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
      },

      async removePushSubscription(endpoint) {
        unwrap(await subscriptions().delete().eq('endpoint', endpoint));
      },

      // ログイン中の本人の端末に、今の内容をすぐ送る
      sendTestReport() {
        return postReport({});
      },

      // 通知で届いた回の報告の中身（view は '2026-11-14-morning' の形、または 'now'）
      viewReport(view) {
        return postReport({ view });
      },

      // ---- メールとドライブの連携 ----
      // まだ片づけていない候補（新しい順）。連携の準備がまだなら（表がなければ）0件として扱う
      async listCandidates() {
        const { data, error } = await client.from('mail_candidates').select('*').eq('status', 'new').order('received_at', { ascending: false });
        if (error) {
          console.warn('メールの候補を読めませんでした', error.message);
          return [];
        }
        return data.map((r) => ({
          id: r.id,
          sender: r.sender || '',
          subject: r.subject || '',
          excerpt: r.excerpt || '',
          mailUrl: r.mail_url || '',
          attachments: r.attachments || [],
          receivedAt: r.received_at,
        }));
      },

      // 候補を片づける。status は 'added'（追加した）/ 'dismissed'（追加しない）/ 'new'（元に戻す）
      async resolveCandidate(id, status, itemId) {
        unwrap(await client.from('mail_candidates').update({ status, item_id: itemId || null }).eq('id', id));
      },

      // 連携の状態。準備がまだ（SQL を実行していない）なら null
      async mailLink() {
        const { data, error } = await client.from('mail_links').select('created_at,last_seen_at').maybeSingle();
        if (error) return null;
        return data ? { linked: true, createdAt: data.created_at, lastSeenAt: data.last_seen_at } : { linked: false };
      },

      // 合言葉を作る（作り直すと、前の合言葉は使えなくなる）
      async createMailToken() {
        return unwrap(await client.rpc('create_mail_token'));
      },

      async removeMailLink() {
        const { data } = await client.auth.getSession();
        unwrap(await client.from('mail_links').delete().eq('user_id', data.session.user.id));
      },

      // ---- ログイン ----
      async isSignedIn() {
        const { data } = await client.auth.getSession();
        return Boolean(data.session);
      },

      async signIn(email, password) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },

      async signOut() {
        await client.auth.signOut();
      },

      onSignedOut(callback) {
        client.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') callback();
        });
      },
    };
  };
})(window);

// 項目の保存（Supabase 版）。store.js の LocalStore と同じ形の関数を持つ。
(function (root) {
  'use strict';

  function fromRow(r) {
    return {
      id: r.id,
      content: r.content,
      category: r.category || '',
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
    id: 'id', content: 'content', category: 'category', action: 'action', progress: 'progress', assignee: 'assignee', due: 'due',
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
    if (result.error && result.error.code === 'PGRST204') {
      // 「カテゴリ」も同じ（supabase/add-category.sql が未実行）。空なら外して保存し、文字があるときは理由を伝える
      const rest = { ...row };
      for (const column of ['progress', 'category']) {
        if (column in rest && !rest[column]) delete rest[column];
      }
      if (rest.category) {
        const error = new Error('カテゴリの列がまだありません');
        error.userMessage = 'カテゴリを使うには、先に Supabase で supabase/add-category.sql を実行してください。';
        throw error;
      }
      if (Object.keys(rest).length < Object.keys(row).length) return unwrap(await run(rest));
    }
    return unwrap(result);
  }

  // この端末で使ったアカウント。パスワードは保存しない。保存するのは、ログインした状態を保つための鍵だけ
  // （ログインしたままにしているのと同じ扱い。ほかの人と共有する端末では、使い終わったらログアウトする）
  const ACCOUNTS_KEY = 'higayaibin.accounts.v1';

  function readAccounts() {
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch (e) {
      return {};
    }
  }

  function writeAccounts(accounts) {
    try {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    } catch (e) {
      console.error(e);
    }
  }

  function rememberAccount(session) {
    if (!session || !session.user || !session.user.email || !session.refresh_token) return;
    const accounts = readAccounts();
    accounts[session.user.email] = { access_token: session.access_token, refresh_token: session.refresh_token };
    writeAccounts(accounts);
  }

  function forgetAccount(email) {
    const accounts = readAccounts();
    delete accounts[email];
    writeAccounts(accounts);
  }

  root.createRemoteStore = function (config) {
    const client = root.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    // ログインしたとき・鍵が新しくなったときに、この端末のアカウントの一覧へ覚えておく
    client.auth.onAuthStateChange((event, session) => rememberAccount(session));
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
        const { content, category, action, progress, assignee, due } = fields;
        const row = toRow({ content, category: category || '', action, progress, assignee, due });
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

      // 新規登録。すぐ使える状態になったら { signedIn: true }、確認のメールが必要なら { signedIn: false }
      async signUp(email, password) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        // 登録済みのアドレスだと、Supabase は中身が空の利用者を返す
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('User already registered');
        }
        return { signedIn: Boolean(data.session) };
      },

      async currentEmail() {
        const { data } = await client.auth.getSession();
        return data.session && data.session.user ? data.session.user.email || '' : '';
      },

      // この端末で使ったアカウント（メールアドレス）
      savedAccounts() {
        return Object.keys(readAccounts());
      },

      forgetAccount,

      // パスワードを入れ直さずに、覚えているアカウントへ切り替える。
      // 鍵が古くて使えなくなっていたら失敗する（そのときは、パスワードでログインし直す）
      async switchTo(email) {
        const tokens = readAccounts()[email];
        if (!tokens) throw new Error('このアカウントは覚えていません');
        const { data, error } = await client.auth.setSession(tokens);
        if (error || !data.session) {
          forgetAccount(email);
          throw error || new Error('切り替えられませんでした');
        }
      },

      // この端末だけログアウトする（ほかの端末はログインしたまま）
      async signOut() {
        const { data } = await client.auth.getSession();
        if (data.session && data.session.user) forgetAccount(data.session.user.email);
        await client.auth.signOut({ scope: 'local' });
      },

      onSignedOut(callback) {
        client.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') callback();
        });
      },
    };
  };
})(window);

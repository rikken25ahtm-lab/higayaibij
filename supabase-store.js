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

    return {
      remote: true,

      async list() {
        return unwrap(await table().select('*')).map(fromRow);
      },

      async add(fields) {
        const { content, action, progress, assignee, due } = fields;
        const row = toRow({ content, action, progress, assignee, due });
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

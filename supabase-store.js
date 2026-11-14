// 項目の保存（Supabase 版）。store.js の LocalStore と同じ形の関数を持つ。
(function (root) {
  'use strict';

  function fromRow(r) {
    return {
      id: r.id,
      content: r.content,
      action: r.action || '',
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
    id: 'id', content: 'content', action: 'action', assignee: 'assignee', due: 'due',
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

  root.createRemoteStore = function (config) {
    const client = root.supabase.createClient(config.supabaseUrl, config.supabaseKey);
    const table = () => client.from('items');

    return {
      remote: true,

      async list() {
        return unwrap(await table().select('*')).map(fromRow);
      },

      async add(fields) {
        const { content, action, assignee, due } = fields;
        return fromRow(unwrap(await table().insert(toRow({ content, action, assignee, due })).select().single()));
      },

      async update(id, patch) {
        const row = { ...toRow(patch), updated_at: new Date().toISOString() };
        delete row.id;
        return fromRow(unwrap(await table().update(row).eq('id', id).select().single()));
      },

      async remove(id) {
        unwrap(await table().delete().eq('id', id));
      },

      async restore(item) {
        unwrap(await table().upsert(toRow(item)));
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

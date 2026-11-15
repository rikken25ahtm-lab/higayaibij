// 項目の保存（端末内版）。config.js が空のときに使う。
// この端末のブラウザ（localStorage）に保存する。Supabase 版は supabase-store.js。
(function (root) {
  'use strict';

  const KEY = 'higayaibin.items.v1';
  const PROJECTS_KEY = 'higayaibin.projects.v1';

  function readProjects() {
    try {
      const list = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function writeProjects(list) {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  }

  function readAll() {
    try {
      const raw = localStorage.getItem(KEY);
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      console.error('保存データを読めませんでした', e);
      return [];
    }
  }

  function writeAll(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
  }

  function newId() {
    if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  const LocalStore = {
    remote: false,

    async list() {
      return readAll();
    },

    // fields: { content, action, progress, assignee, due, attachments }
    async add(fields) {
      const now = new Date().toISOString();
      const item = {
        id: newId(),
        content: fields.content,
        projectId: fields.projectId || null, // どのプロジェクトの項目か（null は「プロジェクトなし」）
        category: fields.category || '',
        action: fields.action || '',
        progress: fields.progress || '',
        assignee: fields.assignee || '',
        due: fields.due || null, // 'YYYY-MM-DD'
        status: 'open', // 'open' | 'done'
        priority: null, // 使っていない（直近は、期限から自動で決める）
        repeat: fields.repeat || '', // 繰り返し：'' | 'daily' | 'weekly' | 'monthly' | 'yearly'
        notes: fields.notes || [], // メモ [{ at, text }]
        attachments: fields.attachments || [], // ドライブのリンク [{ name, url }]
        createdAt: now,
        updatedAt: now,
      };
      const items = readAll();
      items.push(item);
      writeAll(items);
      return item;
    },

    async update(id, patch) {
      const items = readAll();
      const index = items.findIndex((i) => i.id === id);
      if (index === -1) throw new Error('項目が見つかりません');
      items[index] = { ...items[index], ...patch, id, updatedAt: new Date().toISOString() };
      writeAll(items);
      return items[index];
    },

    // ---- プロジェクト ----
    async listProjects() {
      return readProjects();
    },

    async addProject(name) {
      const project = { id: newId(), name, createdAt: new Date().toISOString() };
      writeProjects([...readProjects(), project]);
      return project;
    },

    async renameProject(id, name) {
      writeProjects(readProjects().map((p) => (p.id === id ? { ...p, name } : p)));
    },

    // プロジェクトをなくす。中の項目は消さず、「プロジェクトなし」にする
    async removeProject(id) {
      writeProjects(readProjects().filter((p) => p.id !== id));
      writeAll(readAll().map((i) => (i.projectId === id ? { ...i, projectId: null } : i)));
    },

    // カテゴリの名前を変える（to が空なら、そのカテゴリをなくす）。項目は消えない
    async renameCategory(from, to) {
      writeAll(readAll().map((i) => ((i.category || '') === from ? { ...i, category: to } : i)));
    },

    async remove(id) {
      writeAll(readAll().filter((i) => i.id !== id));
    },

    // 削除の「元に戻す」用。項目をそのまま戻す。
    async restore(item) {
      const items = readAll().filter((i) => i.id !== item.id);
      items.push(item);
      writeAll(items);
    },

    // 別のタブ・ウィンドウで変更されたときに呼ばれる
    onChange(callback) {
      root.addEventListener('storage', (e) => {
        if (e.key === KEY) callback();
      });
    },
  };

  root.LocalStore = LocalStore;
})(window);

(function () {
  'use strict';

  const { toDateKey, dueLevel, dueLabel, sortOpen, sortDone, summarize, parsePaste, PROGRESS_CHOICES } = window.Logic;
  const config = window.HIGAYAIBIN_CONFIG || {};
  const Store =
    config.supabaseUrl && config.supabaseKey ? window.createRemoteStore(config) : window.LocalStore;

  const $ = (id) => document.getElementById(id);
  const addForm = $('add-form');
  const openList = $('open-list');
  const doneList = $('done-list');
  const doneBlock = $('done-block');
  const toast = $('toast');

  let items = [];
  let editingId = null;
  let toastTimer = null;
  let undoAction = null;

  // 小さな DOM ヘルパー。文字は必ず textContent で入れる（HTMLとして解釈させない）。
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value != null) node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child != null) node.append(child);
    }
    return node;
  }

  function readForm(form) {
    const data = new FormData(form);
    return {
      content: String(data.get('content') || '').trim(),
      action: String(data.get('action') || '').trim(),
      progress: String(data.get('progress') || '').trim(),
      assignee: String(data.get('assignee') || '').trim(),
      due: String(data.get('due') || '') || null,
    };
  }

  async function reload() {
    items = await Store.list();
    render();
  }

  function render() {
    const today = toDateKey(new Date());
    const open = sortOpen(items.filter((i) => i.status !== 'done'));
    const done = sortDone(items.filter((i) => i.status === 'done'));

    openList.replaceChildren(...open.map((item) => renderItem(item, today)));
    doneList.replaceChildren(...done.map((item) => renderItem(item, today)));

    $('open-count').textContent = open.length ? `${open.length}件` : '';
    $('done-count').textContent = `${done.length}件`;
    $('empty').hidden = open.length > 0;
    $('empty').textContent = done.length
      ? '残っているやることはありません。'
      : 'まだ項目がありません。上のフォームから追加してください。';
    doneBlock.hidden = done.length === 0;

    renderSummary(summarize(items, today));
    renderAssignees();
  }

  function renderSummary(counts) {
    const parts = [
      ['overdue', '期限切れ', counts.overdue],
      ['today', '今日', counts.today],
      ['soon', '3日以内', counts.soon],
    ];
    $('summary').replaceChildren(
      ...parts.map(([level, label, n]) =>
        el('li', { class: `pill ${n ? level : 'zero'}` }, `${label} `, el('strong', null, String(n)))
      )
    );
  }

  // これまでに入力した担当者を候補に出す
  function renderAssignees() {
    const names = [...new Set(items.map((i) => i.assignee).filter(Boolean))];
    $('assignees').replaceChildren(...names.map((name) => el('option', { value: name })));
  }

  function renderItem(item, today) {
    if (item.id === editingId) return renderEditor(item);

    const isDone = item.status === 'done';
    const level = isDone ? 'none' : dueLevel(item.due, today);

    return el(
      'li',
      { class: `item ${isDone ? 'done' : level}`, 'data-id': item.id },
      el('button', {
        type: 'button',
        class: 'check',
        'aria-pressed': String(isDone),
        'aria-label': isDone ? `「${item.content}」を未完了に戻す` : `「${item.content}」を完了にする`,
        onclick: () => toggleDone(item),
      }),
      el(
        'div',
        { class: 'body' },
        el('p', { class: 'content' }, item.content),
        item.action ? el('p', { class: 'action' }, item.action) : null,
        el(
          'p',
          { class: 'meta' },
          item.due || !isDone ? el('span', { class: `due ${level}` }, dueLabel(item.due, today)) : null,
          item.progress && !isDone ? el('span', { class: 'progress' }, item.progress) : null,
          item.assignee ? el('span', { class: 'assignee' }, `担当：${item.assignee}`) : null
        )
      ),
      el(
        'div',
        { class: 'tools' },
        el('button', { type: 'button', class: 'btn small', onclick: () => startEdit(item.id) }, '編集'),
        el('button', { type: 'button', class: 'btn small danger', onclick: () => removeItem(item) }, '削除')
      )
    );
  }

  function renderEditor(item) {
    const field = (label, control) => el('label', { class: 'field' }, el('span', null, label), control);
    const content = el('input', { name: 'content', type: 'text', required: true, maxlength: 200 });
    const action = el('textarea', { name: 'action', rows: 2, maxlength: 500 });
    // 3択になる前に自由に書いた進捗が残っている項目は、その文も選べるようにして消さない
    const choices = PROGRESS_CHOICES.includes(item.progress) || !item.progress ? PROGRESS_CHOICES : [item.progress, ...PROGRESS_CHOICES];
    const progress = el(
      'select',
      { name: 'progress' },
      el('option', { value: '' }, '（選ばない）'),
      ...choices.map((c) => el('option', { value: c }, c))
    );
    const assignee = el('input', { name: 'assignee', type: 'text', maxlength: 50, list: 'assignees' });
    const due = el('input', { name: 'due', type: 'date' });
    content.value = item.content;
    action.value = item.action;
    progress.value = item.progress || '';
    assignee.value = item.assignee;
    due.value = item.due || '';

    const form = el(
      'form',
      {
        class: 'item-form',
        autocomplete: 'off',
        onsubmit: async (e) => {
          e.preventDefault();
          const fields = readForm(form);
          if (!fields.content) return;
          await Store.update(item.id, fields);
          editingId = null;
          await reload();
        },
        onkeydown: (e) => {
          if (e.key === 'Escape') cancelEdit();
        },
      },
      field('内容', content),
      field('必要な対応', action),
      field('進捗', progress),
      el('div', { class: 'field-row' }, field('誰に任せるか', assignee), field('期限', due)),
      el(
        'div',
        { class: 'form-actions' },
        el('button', { type: 'button', class: 'btn', onclick: cancelEdit }, 'やめる'),
        el('button', { type: 'submit', class: 'btn primary' }, '保存する')
      )
    );
    return el('li', { class: 'item editing', 'data-id': item.id }, form);
  }

  function startEdit(id) {
    editingId = id;
    render();
    const input = document.querySelector('.item.editing input[name="content"]');
    if (input) input.focus();
  }

  function cancelEdit() {
    editingId = null;
    render();
  }

  async function toggleDone(item) {
    const wasDone = item.status === 'done';
    await Store.update(item.id, { status: wasDone ? 'open' : 'done' });
    await reload();
    if (!wasDone) {
      showToast('完了にしました', async () => {
        await Store.update(item.id, { status: 'open' });
        await reload();
      });
    }
  }

  async function removeItem(item) {
    await Store.remove(item.id);
    if (editingId === item.id) editingId = null;
    await reload();
    showToast('削除しました', async () => {
      await Store.restore(item);
      await reload();
    });
  }

  function showToast(text, undo) {
    $('toast-text').textContent = text;
    undoAction = undo;
    $('toast-undo').hidden = !undo;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    toast.hidden = true;
    undoAction = null;
  }

  $('toast-undo').addEventListener('click', async () => {
    const undo = undoAction;
    hideToast();
    if (undo) await undo();
  });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readForm(addForm);
    if (!fields.content) return;
    await Store.add(fields);
    addForm.reset();
    addForm.classList.remove('expanded');
    await reload();
    addForm.elements.content.focus();
  });

  // スマホでは一覧を上に見せたいので、「内容」に触れるまで残りの欄をたたんでおく
  addForm.addEventListener('focusin', () => addForm.classList.add('expanded'));

  // ---- AIの要約を貼り付けて追加 ----
  const pasteText = $('paste-text');
  const pasteAdd = $('paste-add');
  let candidates = [];

  $('prompt-text').value = [
    'これから話す用件を、やることリスト用に整理してください。',
    '次の形だけで出力し、前置きや説明は書かないでください。',
    'どの欄も、要点だけを短い言葉で書いてください。',
    '用件が複数あるときは、1件ごとに空行で区切って、同じ形を繰り返してください。',
    'わからない欄は「なし」と書いてください。',
    '期限は「2026-11-20」のように、年-月-日の数字で書いてください。',
    '',
    '内容：（何をするか。15文字くらいまで）',
    '対応：（次にやる行動を1つ。短く）',
    '進捗：（「まだ」「途中」「返事待ち」のどれか1つ）',
    '担当：（誰に任せるか）',
    '期限：（年-月-日）',
  ].join('\n');

  $('prompt-copy').addEventListener('click', async () => {
    const box = $('prompt-text');
    try {
      await navigator.clipboard.writeText(box.value);
      showToast('お願い文をコピーしました', null);
    } catch (err) {
      // コピーが許可されていない環境：選択した状態にして、手でコピーしてもらう
      box.focus();
      box.select();
      showToast('文を選択しました。そのままコピーしてください。', null);
    }
  });

  function renderCandidates() {
    const today = toDateKey(new Date());
    candidates = parsePaste(pasteText.value, today);
    const ready = candidates.filter((c) => c.content);
    const row = (label, value, cls) => (value ? el('p', { class: cls || '' }, el('span', null, label), value) : null);

    $('candidates').replaceChildren(
      ...candidates.map((c) =>
        el(
          'li',
          { class: `candidate ${c.content ? '' : 'invalid'}` },
          el('p', { class: 'content' }, c.content || '「内容」がありません（この候補は追加されません）'),
          row('対応', c.action),
          row('進捗', c.progress),
          row('担当', c.assignee),
          c.due ? row('期限', dueLabel(c.due, today)) : null,
          c.dueUnreadable
            ? el('p', { class: 'warn' }, `期限「${c.dueText}」は日付として読めませんでした。期限なしで追加されます。`)
            : null
        )
      )
    );

    const hint = $('paste-hint');
    hint.hidden = !(pasteText.value.trim() && candidates.length === 0);
    hint.textContent = '項目を読み取れませんでした。「内容：…」の形になっているか確認してください。';
    pasteAdd.hidden = ready.length === 0;
    pasteAdd.textContent = `この${ready.length}件を追加する`;
  }

  pasteText.addEventListener('input', renderCandidates);

  pasteAdd.addEventListener('click', async () => {
    const ready = candidates.filter((c) => c.content);
    if (!ready.length) return;
    pasteAdd.disabled = true;
    const added = [];
    try {
      for (const c of ready) {
        const { content, action, progress, assignee, due } = c;
        added.push(await Store.add({ content, action, progress, assignee, due }));
      }
      pasteText.value = '';
      renderCandidates();
      $('paste').open = false;
    } finally {
      pasteAdd.disabled = false;
      await reload();
    }
    showToast(`${added.length}件を追加しました`, async () => {
      for (const item of added) await Store.remove(item.id);
      await reload();
    });
  });

  Store.onChange(() => {
    if (!editingId && !$('main').hidden) reload();
  });

  // 開きっぱなしで日付が変わっても、期限の表示を正しく保つ
  let lastDay = toDateKey(new Date());
  function refreshIfNewDay() {
    const now = toDateKey(new Date());
    if (now !== lastDay) {
      lastDay = now;
      if (!editingId) render();
    }
  }
  document.addEventListener('visibilitychange', refreshIfNewDay);
  setInterval(refreshIfNewDay, 60000);

  // 保存や読み込みに失敗したら、黙って進まずに知らせる
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    showToast('うまく保存・読み込みできませんでした。通信を確認してください。', null);
  });

  // ---- ログイン（Supabase を使うときだけ） ----
  function showLogin() {
    items = [];
    editingId = null;
    $('main').hidden = true;
    $('summary').hidden = true;
    $('logout').hidden = true;
    $('login').hidden = false;
  }

  let notifyReady = false;

  async function showMain() {
    $('login').hidden = true;
    $('main').hidden = false;
    $('summary').hidden = false;
    $('logout').hidden = !Store.remote;
    $('local-note').hidden = Store.remote;
    await reload();
    if (!notifyReady) {
      notifyReady = true;
      window.Notify.init(Store, showToast);
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const error = $('login-error');
    error.hidden = true;
    try {
      await Store.signIn(form.elements.email.value.trim(), form.elements.password.value);
    } catch (err) {
      console.error(err);
      error.textContent = 'ログインできませんでした。メールアドレスとパスワードを確認してください。';
      error.hidden = false;
      return;
    }
    form.reset();
    await showMain();
  });

  $('logout').addEventListener('click', async () => {
    await window.Notify.beforeSignOut();
    await Store.signOut();
  });

  async function start() {
    if (!Store.remote) return showMain();
    Store.onSignedOut(showLogin);
    if (await Store.isSignedIn()) return showMain();
    showLogin();
  }

  start();
})();

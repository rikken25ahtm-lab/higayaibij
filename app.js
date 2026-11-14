(function () {
  'use strict';

  const { toDateKey, dueLevel, dueLabel, sortOpen, sortDone, summarize } = window.Logic;
  const Store = window.Store;

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
    const assignee = el('input', { name: 'assignee', type: 'text', maxlength: 50, list: 'assignees' });
    const due = el('input', { name: 'due', type: 'date' });
    content.value = item.content;
    action.value = item.action;
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

  Store.onChange(reload);

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

  reload();
})();

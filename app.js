(function () {
  'use strict';

  const {
    toDateKey, dueLevel, dueLabel, sortOpen, sortDone, summarize, parsePaste, PROGRESS_CHOICES,
    senderName, cleanSubject, safeLinks, mergeLinks, candidateLinks, mailTime, categoriesOf, inCategory,
  } = window.Logic;
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
  let mails = []; // メールからの候補（まだ片づけていないもの）
  let editingId = null;
  let mailEditingId = null; // 「やることに追加」を開いている候補
  let toastTimer = null;
  let undoAction = null;
  let reportIds = new Set(); // 開いている報告に出てくる項目（一覧で目印をつける）

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

  // ---- カテゴリ ----
  const NEW_CATEGORY = '__new__'; // 選択肢「＋ 新しいカテゴリを作る」
  const CATEGORY_KEY = 'higayaibin.category.v1';
  let activeCategory = null; // 絞り込み中のカテゴリ。null は「すべて」、'' は「カテゴリなし」
  try {
    activeCategory = JSON.parse(localStorage.getItem(CATEGORY_KEY) || 'null');
  } catch (e) {
    activeCategory = null;
  }

  function setCategory(value) {
    activeCategory = value;
    try {
      localStorage.setItem(CATEGORY_KEY, JSON.stringify(value));
    } catch (e) { /* 覚えられなくても、絞り込みは動く */ }
    editingId = null;
    render();
  }

  // カテゴリの選択肢を入れる。いま選んでいる値は保つ
  function fillCategories(select, value) {
    const known = categoriesOf(items);
    const list = value && value !== NEW_CATEGORY && !known.includes(value) ? [value, ...known] : known;
    select.replaceChildren(
      el('option', { value: '' }, '（なし）'),
      ...list.map((c) => el('option', { value: c }, c)),
      el('option', { value: NEW_CATEGORY }, '＋ 新しいカテゴリを作る')
    );
    select.value = value || '';
  }

  // 「＋ 新しいカテゴリを作る」を選んだら、名前を書く欄を出す
  function wireCategory(select, input) {
    const sync = () => {
      const isNew = select.value === NEW_CATEGORY;
      input.hidden = !isNew;
      input.required = isNew;
      return isNew;
    };
    select.addEventListener('change', () => {
      if (sync()) input.focus();
    });
    sync();
  }

  function categoryField(value) {
    const select = el('select', { name: 'category' });
    const input = el('input', { name: 'categoryNew', type: 'text', maxlength: 50, placeholder: '例：家のこと', hidden: true });
    fillCategories(select, value);
    wireCategory(select, input);
    return el('label', { class: 'field' }, el('span', null, 'カテゴリ'), select, input);
  }

  wireCategory(addForm.elements.category, addForm.elements.categoryNew);
  let addCategoryChosen = false; // 追加フォームのカテゴリを、自分で選んだか
  addForm.elements.category.addEventListener('change', () => { addCategoryChosen = true; });

  function readForm(form) {
    const data = new FormData(form);
    const picked = String(data.get('category') || '');
    return {
      content: String(data.get('content') || '').trim(),
      category: picked === NEW_CATEGORY ? String(data.get('categoryNew') || '').trim().slice(0, 50) : picked,
      action: String(data.get('action') || '').trim(),
      progress: String(data.get('progress') || '').trim(),
      assignee: String(data.get('assignee') || '').trim(),
      due: String(data.get('due') || '') || null,
    };
  }

  async function reload() {
    [items, mails] = await Promise.all([Store.list(), Store.listCandidates ? Store.listCandidates() : []]);
    if (!mails.some((m) => m.id === mailEditingId)) mailEditingId = null;
    render();
  }

  function render() {
    const today = toDateKey(new Date());
    // なくなったカテゴリで絞り込んだままにしない
    const categories = categoriesOf(items);
    if (activeCategory !== null && !items.some((i) => inCategory(i, activeCategory))) activeCategory = null;
    if (activeCategory === '' && !categories.length) activeCategory = null;
    const shown = items.filter((i) => inCategory(i, activeCategory));
    const open = sortOpen(shown.filter((i) => i.status !== 'done'));
    const done = sortDone(shown.filter((i) => i.status === 'done'));
    renderCategories(categories);

    openList.replaceChildren(...open.map((item) => renderItem(item, today)));
    doneList.replaceChildren(...done.map((item) => renderItem(item, today)));

    $('open-count').textContent = open.length ? `${open.length}件` : '';
    $('done-count').textContent = `${done.length}件`;
    $('empty').hidden = open.length > 0;
    $('empty').textContent = activeCategory !== null
      ? 'このカテゴリに、残っているやることはありません。'
      : done.length
      ? '残っているやることはありません。'
      : 'まだ項目がありません。上のフォームから追加してください。';
    doneBlock.hidden = done.length === 0;

    $('mail').hidden = mails.length === 0;
    $('mail-count').textContent = mails.length ? `${mails.length}件` : '';
    $('mail-list').replaceChildren(...mails.map((mail) => (mail.id === mailEditingId ? renderMailEditor(mail, open) : renderMail(mail))));

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

  // カテゴリで絞り込むボタン（数字は、残っているやることの件数）。カテゴリが1つもなければ出さない
  function renderCategories(categories) {
    const openItems = items.filter((i) => i.status !== 'done');
    const chip = (label, value, count) =>
      el('button', {
        type: 'button',
        class: 'cat-chip',
        'aria-pressed': String(activeCategory === value),
        onclick: () => setCategory(value),
      }, label, el('span', { class: 'n' }, String(count)));
    const none = openItems.filter((i) => !i.category).length;
    $('cats').hidden = categories.length === 0;
    $('cats').replaceChildren(
      chip('すべて', null, openItems.length),
      ...categories.map((c) => chip(c, c, openItems.filter((i) => i.category === c).length)),
      ...(items.some((i) => !i.category) ? [chip('カテゴリなし', '', none)] : [])
    );

    // 追加フォームの選択肢。書きかけの選択は変えない
    const select = addForm.elements.category;
    // 自分で選んでいなければ、絞り込み中のカテゴリを最初から選んでおく
    if (select.value !== NEW_CATEGORY) fillCategories(select, addCategoryChosen ? select.value : activeCategory || '');
    updatePrompt(categories);
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

    const li = el(
      'li',
      {
        class: `item ${isDone ? 'done' : level}${reportIds.has(item.id) ? ' reported' : ''}`,
        'data-id': item.id,
        onclick: (e) => {
          if (e.currentTarget.dataset.swiped) return; // スワイプの直後
          if (openSwipe) return closeSwipe();           // 「削除」が出ているときは、まず閉じる
          if (e.target.closest('button, a')) return;
          startEdit(item.id);
        },
      },
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
          item.assignee ? el('span', { class: 'assignee' }, `担当：${item.assignee}`) : null,
          item.category && activeCategory === null ? el('span', { class: 'cat-tag' }, item.category) : null
        ),
        renderLinks(item.attachments)
      ),
      // キーボードや読み上げで使う人のための「編集」（見た目には出さない）
      el('button', { type: 'button', class: 'visually-hidden', onclick: () => startEdit(item.id) }, `「${item.content}」を編集`),
      // 左にスワイプすると出てくる
      el('button', { type: 'button', class: 'swipe-delete', tabindex: '-1', 'aria-hidden': 'true', onclick: () => removeItem(item) }, '削除')
    );
    attachSwipe(li);
    return li;
  }

  // ---- 左にスワイプして「削除」を出す ----
  const SWIPE_WIDTH = 92; // 出てくる「削除」の幅
  let openSwipe = null;   // いま「削除」が出ている項目

  function closeSwipe() {
    if (!openSwipe) return;
    openSwipe.style.transform = '';
    openSwipe = null;
  }

  function attachSwipe(li) {
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let base = 0;
    let mode = null; // 'x'（横に動かしている）| 'y'（縦のスクロール）

    li.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (openSwipe && openSwipe !== li) closeSwipe();
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      dx = 0;
      mode = null;
      base = openSwipe === li ? -SWIPE_WIDTH : 0;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
      dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (!mode) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        mode = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (mode === 'x') li.style.transition = 'none';
      }
      if (mode !== 'x') return;
      li.style.transform = `translateX(${Math.max(-SWIPE_WIDTH - 20, Math.min(0, base + dx))}px)`;
    }, { passive: true });

    const end = () => {
      if (mode !== 'x') return;
      mode = null;
      li.style.transition = '';
      // 指を離したときに出る「クリック」で、編集が開かないようにする
      li.dataset.swiped = '1';
      setTimeout(() => { delete li.dataset.swiped; }, 400);
      if (base + dx < -SWIPE_WIDTH / 2) {
        li.style.transform = `translateX(${-SWIPE_WIDTH}px)`;
        openSwipe = li;
      } else {
        li.style.transform = '';
        if (openSwipe === li) openSwipe = null;
      }
    };
    li.addEventListener('touchend', end);
    li.addEventListener('touchcancel', end);
  }

  // 項目の外を押したら、「削除」をしまう
  document.addEventListener('click', (e) => {
    if (openSwipe && !openSwipe.contains(e.target)) closeSwipe();
  });

  // 添付（ドライブ）とメールへのリンク。別のタブで開く
  function renderLinks(list) {
    const links = safeLinks(list);
    if (!links.length) return null;
    return el(
      'p',
      { class: 'links' },
      ...links.map((link) =>
        el('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer', class: link.kind === 'mail' ? 'mail-link' : 'file-link' }, link.name)
      )
    );
  }

  const field = (label, control) => el('label', { class: 'field' }, el('span', null, label), control);

  // 内容・必要な対応・進捗・担当・期限の入力欄（編集と、メールからの追加で使う）
  function itemFields(values) {
    const content = el('input', { name: 'content', type: 'text', required: true, maxlength: 200 });
    const action = el('textarea', { name: 'action', rows: 2, maxlength: 500 });
    // 3択になる前に自由に書いた進捗が残っている項目は、その文も選べるようにして消さない
    const choices = PROGRESS_CHOICES.includes(values.progress) || !values.progress ? PROGRESS_CHOICES : [values.progress, ...PROGRESS_CHOICES];
    const progress = el(
      'select',
      { name: 'progress' },
      el('option', { value: '' }, '（選ばない）'),
      ...choices.map((c) => el('option', { value: c }, c))
    );
    const assignee = el('input', { name: 'assignee', type: 'text', maxlength: 50, list: 'assignees' });
    const due = el('input', { name: 'due', type: 'date' });
    content.value = values.content || '';
    action.value = values.action || '';
    progress.value = values.progress || '';
    assignee.value = values.assignee || '';
    due.value = values.due || '';
    return [
      field('内容', content),
      categoryField(values.category || ''),
      field('必要な対応', action),
      field('進捗', progress),
      el('div', { class: 'field-row' }, field('誰に任せるか', assignee), field('期限', due)),
    ];
  }

  function renderEditor(item) {
    // 「外す」を押したリンクは、保存するときに項目から外す（ドライブのファイルやメールは消えない）
    let kept = safeLinks(item.attachments);
    const linkRows = kept.map((link) => {
      const row = el(
        'li',
        null,
        el('span', null, link.name),
        el('button', {
          type: 'button',
          class: 'btn small',
          'aria-label': `「${link.name}」のリンクを外す`,
          onclick: () => {
            kept = kept.filter((k) => k !== link);
            row.remove();
          },
        }, '外す')
      );
      return row;
    });

    const form = el(
      'form',
      {
        class: 'item-form',
        autocomplete: 'off',
        onsubmit: async (e) => {
          e.preventDefault();
          const fields = readForm(form);
          if (!fields.content) return;
          if (linkRows.length !== kept.length) fields.attachments = kept;
          await Store.update(item.id, fields);
          editingId = null;
          await reload();
        },
        onkeydown: (e) => {
          if (e.key === 'Escape') cancelEdit();
        },
      },
      ...itemFields(item),
      linkRows.length ? el('div', { class: 'field' }, el('span', null, '添付・メールのリンク'), el('ul', { class: 'link-rows' }, ...linkRows)) : null,
      el(
        'div',
        { class: 'form-actions' },
        el('button', { type: 'button', class: 'btn', onclick: cancelEdit }, 'やめる'),
        el('button', { type: 'submit', class: 'btn primary' }, '保存する')
      )
    );
    return el('li', { class: 'item editing', 'data-id': item.id }, form);
  }

  // ---- メールからの候補 ----
  function mailHead(mail) {
    return [
      el('p', { class: 'meta' }, el('span', { class: 'sender' }, senderName(mail.sender) || '（差出人なし）'), el('span', { class: 'assignee' }, mailTime(mail.receivedAt))),
      el('p', { class: 'content' }, mail.subject || '（件名なし）'),
    ];
  }

  function renderMail(mail) {
    return el(
      'li',
      { class: 'item mail', 'data-id': mail.id },
      el(
        'div',
        { class: 'body' },
        ...mailHead(mail),
        mail.excerpt ? el('details', { class: 'excerpt' }, el('summary', null, '本文を見る'), el('p', null, mail.excerpt)) : null,
        renderLinks(candidateLinks(mail))
      ),
      el(
        'div',
        { class: 'tools' },
        el('button', { type: 'button', class: 'btn small', onclick: () => dismissMail(mail) }, '追加しない'),
        el('button', { type: 'button', class: 'btn small strong', onclick: () => startMailEdit(mail.id) }, 'やることに追加')
      )
    );
  }

  // 候補を確認して、やることに追加する。新しい項目にするか、いまある項目にリンクだけつけるかを選べる
  function renderMailEditor(mail, openItems) {
    const links = candidateLinks(mail);
    const target = el(
      'select',
      { name: 'target' },
      el('option', { value: '' }, '新しいやることにする'),
      ...openItems.map((item) => el('option', { value: item.id }, `「${item.content}」につける`))
    );
    const fields = el('div', { class: 'more' }, ...itemFields({ content: cleanSubject(mail.subject) }));
    const submit = el('button', { type: 'submit', class: 'btn primary' }, '追加する');
    target.addEventListener('change', () => {
      const existing = Boolean(target.value);
      fields.hidden = existing;
      fields.querySelector('[name="content"]').required = !existing;
      submit.textContent = existing ? 'リンクをつける' : '追加する';
    });

    const form = el(
      'form',
      {
        class: 'item-form',
        autocomplete: 'off',
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          try {
            await addFromMail(mail, target.value, readForm(form), links);
          } finally {
            submit.disabled = false;
          }
        },
        onkeydown: (e) => {
          if (e.key === 'Escape') cancelMailEdit();
        },
      },
      ...mailHead(mail),
      openItems.length ? field('追加のしかた', target) : null,
      fields,
      links.length ? el('div', { class: 'field' }, el('span', null, '項目につくリンク'), renderLinks(links)) : null,
      el(
        'div',
        { class: 'form-actions' },
        el('button', { type: 'button', class: 'btn', onclick: cancelMailEdit }, 'やめる'),
        submit
      )
    );
    return el('li', { class: 'item mail editing', 'data-id': mail.id }, form);
  }

  function startMailEdit(id) {
    mailEditingId = id;
    render();
    const input = document.querySelector('.item.mail.editing input[name="content"]');
    if (input) input.focus();
  }

  function cancelMailEdit() {
    mailEditingId = null;
    render();
  }

  async function addFromMail(mail, targetId, fields, links) {
    let undo;
    let message;
    if (targetId) {
      const item = items.find((i) => i.id === targetId);
      if (!item) return;
      const before = item.attachments || [];
      await Store.update(item.id, { attachments: mergeLinks(before, links) });
      await Store.resolveCandidate(mail.id, 'added', item.id);
      message = 'リンクをつけました';
      undo = async () => {
        await Store.update(item.id, { attachments: before });
        await Store.resolveCandidate(mail.id, 'new');
      };
    } else {
      if (!fields.content) return;
      const item = await Store.add({ ...fields, attachments: links });
      await Store.resolveCandidate(mail.id, 'added', item.id);
      message = 'やることに追加しました';
      undo = async () => {
        await Store.remove(item.id);
        await Store.resolveCandidate(mail.id, 'new');
      };
    }
    mailEditingId = null;
    await reload();
    showToast(message, async () => {
      await undo();
      await reload();
    });
  }

  async function dismissMail(mail) {
    await Store.resolveCandidate(mail.id, 'dismissed');
    await reload();
    showToast('候補から外しました', async () => {
      await Store.resolveCandidate(mail.id, 'new');
      await reload();
    });
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
    addCategoryChosen = false;
    addForm.elements.categoryNew.hidden = true;
    addForm.elements.categoryNew.required = false;
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

  // AIへのお願い文。いまあるカテゴリがあれば、その中から選んでもらう
  function updatePrompt(categories) {
    $('prompt-text').value = [
      'これから伝える用件を、やることリスト用に整理してください。',
      '次の形だけで出力し、前置きや説明は書かないでください。',
      'どの欄も、要点だけを短い言葉で書いてください。',
      '用件が複数あるときは、1件ごとに空行で区切って、同じ形を繰り返してください。',
      'わからない欄は「なし」と書いてください。',
      '期限は「2026-11-20」のように、年-月-日の数字で書いてください。',
      categories.length
        ? `カテゴリは、合うものがあれば次の中から選んでください：${categories.join('、')}`
        : 'カテゴリは、大まかな分類を一言で書いてください（例：家のこと、仕事、手続き、買い物）。',
      '',
      '内容：（何をするか。15文字くらいまで）',
      'カテゴリ：（大まかな分類を一言で）',
      '対応：（次にやる行動を1つ。短く）',
      '進捗：（「まだ」「途中」「返事待ち」のどれか1つ）',
      '担当：（誰がやるか。自分なら「自分」）',
      '期限：（年-月-日）',
    ].join('\n');
  }
  updatePrompt([]);

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
          row('カテゴリ', c.category),
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
        const { content, category, action, progress, assignee, due } = c;
        added.push(await Store.add({ content, category, action, progress, assignee, due }));
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
    if (!editingId && !mailEditingId && !$('main').hidden) reload();
  });

  // 開きっぱなしで日付が変わっても、期限の表示を正しく保つ
  let lastDay = toDateKey(new Date());
  function refreshIfNewDay() {
    const now = toDateKey(new Date());
    if (now !== lastDay) {
      lastDay = now;
      if (!editingId && !mailEditingId) render();
    }
  }
  document.addEventListener('visibilitychange', refreshIfNewDay);
  setInterval(refreshIfNewDay, 60000);

  // 保存や読み込みに失敗したら、黙って進まずに知らせる
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    showToast((e.reason && e.reason.userMessage) || 'うまく保存・読み込みできませんでした。通信を確認してください。', null);
  });

  // ---- ログイン・新規登録・アカウントの切り替え（Supabase を使うときだけ） ----
  const loginForm = $('login-form');
  let loginMode = 'login'; // 'login' | 'signup'
  let currentEmail = '';   // ログイン中のアカウント（ログインしていなければ空）
  let notifyReady = false;

  function setLoginMode(mode) {
    loginMode = mode;
    const signup = mode === 'signup';
    $('tab-login').setAttribute('aria-selected', String(!signup));
    $('tab-signup').setAttribute('aria-selected', String(signup));
    $('login-title').textContent = signup ? '新規登録' : 'ログイン';
    $('password-label').textContent = signup ? 'パスワード（8文字以上で、自分で決める）' : 'パスワード';
    loginForm.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
    if (signup) loginForm.elements.password.minLength = 8;
    else loginForm.elements.password.removeAttribute('minlength');
    $('login-submit').textContent = signup ? '登録する' : 'ログインする';
    $('login-error').hidden = true;
    $('login-info').hidden = true;
  }

  function loginMessage(id, text) {
    $('login-error').hidden = true;
    $('login-info').hidden = true;
    $(id).textContent = text;
    $(id).hidden = false;
  }

  // 覚えているアカウントのボタン。押すと、パスワードなしで切り替わる
  function accountButtons(emails, withForget) {
    return emails.map((email) =>
      el(
        'li',
        null,
        el('button', { type: 'button', class: 'btn account-pick', onclick: () => switchAccount(email) }, email),
        withForget
          ? el('button', {
              type: 'button',
              class: 'btn small',
              'aria-label': `${email} をこの端末の一覧から消す`,
              onclick: () => {
                Store.forgetAccount(email);
                renderSavedAccounts();
              },
            }, '消す')
          : null
      )
    );
  }

  function otherAccounts() {
    return Store.savedAccounts().filter((email) => email !== currentEmail);
  }

  function renderSavedAccounts() {
    const others = otherAccounts();
    $('saved').hidden = others.length === 0;
    $('saved-list').replaceChildren(...accountButtons(others, true));
  }

  function renderAccountMenu() {
    $('account-email').textContent = currentEmail ? `${currentEmail} でログイン中` : '';
    $('account-others').replaceChildren(...accountButtons(otherAccounts(), false));
  }

  // アカウントが変わったら、ページごと読み直す（通知やメールの連携も、新しいアカウントのものに切り替わる）
  async function switchAccount(email) {
    await window.Notify.beforeSwitch();
    try {
      await Store.switchTo(email);
    } catch (err) {
      console.error(err);
      showLogin();
      loginForm.elements.email.value = email;
      loginMessage('login-error', 'このアカウントは、もう一度パスワードを入れてログインしてください。');
      return;
    }
    location.reload();
  }

  function showLogin() {
    items = [];
    mails = [];
    editingId = null;
    mailEditingId = null;
    $('main').hidden = true;
    $('summary').hidden = true;
    $('account').hidden = true;
    $('account').open = false;
    $('login').hidden = false;
    $('login-back').hidden = !currentEmail;
    setLoginMode('login');
    renderSavedAccounts();
  }

  async function showMain() {
    $('login').hidden = true;
    $('main').hidden = false;
    $('summary').hidden = false;
    $('account').hidden = !Store.remote;
    $('local-note').hidden = Store.remote;
    if (Store.remote) {
      currentEmail = await Store.currentEmail();
      renderAccountMenu();
    }
    await reload();
    if (!notifyReady) {
      notifyReady = true;
      window.Notify.init(Store, showToast, async (ids) => {
        reportIds = new Set(ids);
        await reload();
      });
      window.MailLink.init(Store, showToast);
    }
  }

  const SIGNUP_ERRORS = [
    [/already registered|already been registered/i, 'このメールアドレスは登録済みです。「ログイン」から入ってください。'],
    [/signups? not allowed|signup is disabled|signups are disabled/i, 'いまは新規登録を受け付けていません（Supabase の設定で止められています）。'],
    [/password/i, 'パスワードは8文字以上にしてください。'],
    [/rate limit|too many|security purposes/i, '短い時間に何度も試したため、いまは受け付けられません。少し待ってから、もう一度試してください。'],
    [/invalid.*email|email.*invalid/i, 'メールアドレスの形を確認してください。'],
  ];

  $('tab-login').addEventListener('click', () => setLoginMode('login'));
  $('tab-signup').addEventListener('click', () => setLoginMode('signup'));
  $('show-password').addEventListener('change', (e) => {
    loginForm.elements.password.type = e.target.checked ? 'text' : 'password';
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = loginForm.elements.email.value.trim();
    const password = loginForm.elements.password.value;
    const submit = $('login-submit');
    $('login-error').hidden = true;
    $('login-info').hidden = true;
    submit.disabled = true;
    try {
      if (currentEmail) await window.Notify.beforeSwitch(); // 別のアカウントに入り直すとき
      if (loginMode === 'signup') {
        const result = await Store.signUp(email, password);
        if (!result.signedIn) {
          loginForm.elements.password.value = '';
          loginMessage('login-info', `${email} に確認のメールを送りました。メールの中のリンクを押すと登録が完了し、このページが開きます。`);
          return;
        }
      } else {
        await Store.signIn(email, password);
      }
    } catch (err) {
      console.error(err);
      const text = String((err && err.message) || err);
      const known = loginMode === 'signup' && SIGNUP_ERRORS.find(([pattern]) => pattern.test(text));
      loginMessage('login-error', known
        ? known[1]
        : loginMode === 'signup'
          ? '登録できませんでした。通信を確認して、もう一度試してください。'
          : /not confirmed/i.test(text)
            ? 'メールアドレスの確認がまだです。届いたメールの中のリンクを押してから、ログインしてください。'
            : 'ログインできませんでした。メールアドレスとパスワードを確認してください。');
      return;
    } finally {
      submit.disabled = false;
    }
    loginForm.reset();
    loginForm.elements.password.type = 'password';
    if (notifyReady) return location.reload(); // 別のアカウントで入り直したとき
    await showMain();
  });

  $('account-add').addEventListener('click', showLogin);
  $('login-back').addEventListener('click', showMain);

  $('logout').addEventListener('click', async () => {
    await window.Notify.beforeSignOut();
    currentEmail = '';
    await Store.signOut();
  });

  // メニューの外を押したら閉じる
  document.addEventListener('click', (e) => {
    const menu = $('account');
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  async function start() {
    if (!Store.remote) return showMain();
    Store.onSignedOut(showLogin);
    if (await Store.isSignedIn()) return showMain();
    showLogin();
  }

  start();
})();

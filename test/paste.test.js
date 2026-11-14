const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

const TODAY = '2026-11-14'; // 土曜日

test('期限の読み取り：日付の書き方', () => {
  const due = (t) => L.parseDue(t, TODAY);
  assert.equal(due('2026-11-20'), '2026-11-20');
  assert.equal(due('2026/11/20'), '2026-11-20');
  assert.equal(due('2026年11月20日（金）'), '2026-11-20');
  assert.equal(due('11/20'), '2026-11-20');
  assert.equal(due('11月20日まで'), '2026-11-20');
  assert.equal(due('１１月２０日'), '2026-11-20');
  assert.equal(due('11/10'), '2026-11-10', '少し前の日付は今年のまま（期限切れ）');
  assert.equal(due('1/15'), '2027-01-15', '半年以上前になるなら来年');
  assert.equal(due('2/30'), null, '存在しない日付');
});

test('期限の読み取り：ことば', () => {
  const due = (t) => L.parseDue(t, TODAY);
  assert.equal(due('今日中'), '2026-11-14');
  assert.equal(due('明日'), '2026-11-15');
  assert.equal(due('明後日'), '2026-11-16');
  assert.equal(due('3日後'), '2026-11-17');
  assert.equal(due('2週間後'), '2026-11-28');
  assert.equal(due('来週の金曜'), '2026-11-20');
  assert.equal(due('来週金曜日まで'), '2026-11-20');
  assert.equal(due('今週の日曜'), '2026-11-15');
  assert.equal(due('再来週の月曜'), '2026-11-23');
  assert.equal(due('金曜'), '2026-11-20');
  assert.equal(due('土曜'), '2026-11-14', '今日と同じ曜日は今日');
  assert.equal(due('月末'), '2026-11-30');
  assert.equal(due('来月末'), '2026-12-31');
  assert.equal(due('12月末'), '2026-12-31');
  assert.equal(due('1月末'), '2027-01-31');
  assert.equal(due('来月5日'), '2026-12-05');
  assert.equal(due('20日'), '2026-11-20');
  assert.equal(due('5日'), '2026-12-05', '過ぎた日は来月');
  assert.equal(due('そのうち'), null);
  assert.equal(L.parseDue('再来月末', '2026-11-30'), '2027-01-31', '年をまたぐ');
});

test('決まった形の要約を1件読む', () => {
  const [item, ...rest] = L.parsePaste(
    '内容：厨房機器の見積もりをとる\n対応：2社に電話して比較する\n進捗：A社は返事待ち\n担当：店長\n期限：2026-11-20',
    TODAY
  );
  assert.equal(rest.length, 0);
  assert.deepEqual(item, {
    content: '厨房機器の見積もりをとる', category: '', action: '2社に電話して比較する', progress: '返事待ち',
    assignee: '店長', due: '2026-11-20', dueText: '2026-11-20', dueUnreadable: false,
  });
});

test('複数件、太字や箇条書きの飾り、半角コロン、「なし」', () => {
  const items = L.parsePaste(
    [
      'はい、整理しました。',
      '',
      '**内容**：保健所に営業許可の申請',
      '- **対応**: 必要書類をそろえて窓口へ',
      '- 進捗: なし',
      '- 担当: 自分',
      '- 期限: 来週の金曜',
      '',
      '1. 内容：看板のデザインを決める',
      '   必要な対応：2案から選ぶ',
      '   デザイナーに返事する',
      '   状況：未定',
      '   担当者：なし',
      '   締め切り：未定',
    ].join('\n'),
    TODAY
  );
  // 前置きの1文は候補にしない
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    content: '保健所に営業許可の申請', category: '', action: '必要書類をそろえて窓口へ', progress: '', assignee: '自分',
    due: '2026-11-20', dueText: '来週の金曜', dueUnreadable: false,
  });
  assert.deepEqual(items[1], {
    content: '看板のデザインを決める', category: '', action: '2案から選ぶ\nデザイナーに返事する', progress: '', assignee: '',
    due: null, dueText: '', dueUnreadable: false,
  });
});

test('読めない期限は捨てずに知らせる', () => {
  const [item] = L.parsePaste('内容：酒屋に連絡\n期限：オープンの前まで', TODAY);
  assert.equal(item.due, null);
  assert.equal(item.dueUnreadable, true);
  assert.equal(item.dueText, 'オープンの前まで');
});

test('決まった形でない文は、1行目を内容、残りを対応にする', () => {
  const items = L.parsePaste('酒屋に連絡する\n生ビールの樽の本数を確認', TODAY);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, '酒屋に連絡する');
  assert.equal(items[0].action, '生ビールの樽の本数を確認');
});

test('長すぎる文字は保存できる長さに切る／空は候補なし', () => {
  const [item] = L.parsePaste('内容：' + 'あ'.repeat(300), TODAY);
  assert.equal(item.content.length, 200);
  assert.deepEqual(L.parsePaste('  \n\n', TODAY), []);
});

test('進捗は3択に寄せる', () => {
  const p = L.normalizeProgress;
  assert.equal(p('まだ'), 'まだ');
  assert.equal(p('途中'), '途中');
  assert.equal(p('返事待ち'), '返事待ち');
  assert.equal(p('これから着手'), 'まだ');
  assert.equal(p('未着手'), 'まだ');
  assert.equal(p('進行中'), '途中');
  assert.equal(p('A社は見積もり待ち'), '返事待ち');
  assert.equal(p(''), '');
  assert.equal(p('書類は準備済み'), '書類は準備済み', 'どれにも当たらない文はそのまま');
  const [item] = L.parsePaste('内容：専用Botを完成させる\n進捗：これから着手', TODAY);
  assert.equal(item.progress, 'まだ');
});

test('カテゴリの行を読む。カテゴリで項目を分ける', () => {
  const [a, b] = L.parsePaste('内容：粗大ごみの回収を申し込む\nカテゴリ：家のこと\n対応：市のサイトで予約\n\n内容：免許の更新\n分類：なし\n期限：11/30', TODAY);
  assert.equal(a.category, '家のこと');
  assert.equal(a.action, '市のサイトで予約');
  assert.equal(b.category, '');
  assert.equal(b.due, '2026-11-30');

  const items = [{ category: '② 資金' }, { category: '① 物件' }, { category: '' }, { category: '⑩ 開店' }, { category: '① 物件' }, {}];
  assert.deepEqual(L.categoriesOf(items), ['① 物件', '② 資金', '⑩ 開店']);
  assert.equal(items.filter((i) => L.inCategory(i, null)).length, 6);
  assert.equal(items.filter((i) => L.inCategory(i, '① 物件')).length, 2);
  assert.equal(items.filter((i) => L.inCategory(i, '')).length, 2);
});

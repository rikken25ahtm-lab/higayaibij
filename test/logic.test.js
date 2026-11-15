const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

const TODAY = '2026-11-14';

test('期限の判定', () => {
  assert.equal(L.dueLevel('2026-11-13', TODAY), 'overdue');
  assert.equal(L.dueLevel('2026-11-14', TODAY), 'today');
  assert.equal(L.dueLevel('2026-11-17', TODAY), 'soon');
  assert.equal(L.dueLevel('2026-11-18', TODAY), 'later');
  assert.equal(L.dueLevel(null, TODAY), 'none');
});

test('月・年をまたいでも日数が正しい', () => {
  assert.equal(L.daysUntil('2026-12-01', '2026-11-30'), 1);
  assert.equal(L.daysUntil('2027-01-02', '2026-12-31'), 2);
  assert.equal(L.daysUntil('2026-03-08', '2026-03-09'), -1);
});

test('期限の表示', () => {
  assert.equal(L.dueLabel('2026-11-12', TODAY), '期限切れ 11/12（木）・2日超過');
  assert.equal(L.dueLabel('2026-11-14', TODAY), '今日まで 11/14（土）');
  assert.equal(L.dueLabel('2026-11-15', TODAY), '明日まで 11/15（日）');
  assert.equal(L.dueLabel('2026-11-16', TODAY), 'あと2日 11/16（月）');
  assert.equal(L.dueLabel('2027-01-10', TODAY), '2027/1/10（日）');
  assert.equal(L.dueLabel(null, TODAY), '期限なし');
});

test('期限の近い順、期限なしは最後、同じ期限は追加順', () => {
  const items = [
    { id: 'a', due: null, createdAt: '1' },
    { id: 'b', due: '2026-12-01', createdAt: '2' },
    { id: 'c', due: '2026-11-10', createdAt: '4' },
    { id: 'd', due: '2026-11-10', createdAt: '3' },
  ];
  assert.deepEqual(L.sortOpen(items).map((i) => i.id), ['d', 'c', 'b', 'a']);
});

test('集計は未完了だけを数える', () => {
  const items = [
    { status: 'open', due: '2026-11-01' },
    { status: 'done', due: '2026-11-01' },
    { status: 'open', due: '2026-11-14' },
    { status: 'open', due: '2026-11-16' },
    { status: 'open', due: null },
  ];
  assert.deepEqual(L.summarize(items, TODAY), { overdue: 1, today: 1, soon: 1 });
});

test('期限の色：2日を切ったら赤、5日以内は黄色、それより先は緑', () => {
  assert.equal(L.dueColor('2026-11-10', TODAY), 'red');
  assert.equal(L.dueColor('2026-11-14', TODAY), 'red');
  assert.equal(L.dueColor('2026-11-15', TODAY), 'red');
  assert.equal(L.dueColor('2026-11-16', TODAY), 'yellow');
  assert.equal(L.dueColor('2026-11-19', TODAY), 'yellow');
  assert.equal(L.dueColor('2026-11-20', TODAY), 'green');
  assert.equal(L.dueColor(null, TODAY), 'none');
});

test('直近：終わっていなくて、期限が3日以内（期限切れを含む）', () => {
  assert.equal(L.isNear({ status: 'open', due: '2026-11-17' }, TODAY), true);
  assert.equal(L.isNear({ status: 'open', due: '2026-11-01' }, TODAY), true);
  assert.equal(L.isNear({ status: 'open', due: '2026-11-18' }, TODAY), false);
  assert.equal(L.isNear({ status: 'done', due: '2026-11-14' }, TODAY), false);
  assert.equal(L.isNear({ status: 'open', due: null }, TODAY), false);
});

test('繰り返し：次の回の期限', () => {
  assert.equal(L.nextDue('2026-11-14', 'daily', TODAY), '2026-11-15');
  assert.equal(L.nextDue('2026-11-14', 'weekly', TODAY), '2026-11-21');
  assert.equal(L.nextDue('2026-11-30', 'monthly', TODAY), '2026-12-30');
  assert.equal(L.nextDue('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28'); // 31日のない月は月末
  assert.equal(L.nextDue('2024-02-29', 'yearly', TODAY), '2027-02-28');
  assert.equal(L.nextDue('2026-10-01', 'weekly', TODAY), '2026-11-19'); // 遅れて完了にしても、過去の日付にしない
  assert.equal(L.nextDue(null, 'weekly', TODAY), '2026-11-21');         // 期限なしは今日から
  assert.equal(L.nextDue('2026-11-14', '', TODAY), null);
  assert.equal(L.repeatLabel('monthly'), '毎月');
});

test('メモと履歴：古い順に1本に並べる', () => {
  const item = {
    notes: [{ at: '2026-11-10T02:00:00Z', text: ' 電話した ' }, { text: '' }, null],
    attachments: [
      { name: '見積書.pdf', url: 'https://drive.google.com/file/d/1/view', at: '2026-11-09T01:00:00Z', from: '山田' },
      { name: 'メールを開く', kind: 'mail', url: 'https://mail.google.com/x', at: '2026-11-12T01:00:00Z', subject: '再見積' },
      { name: '昔のリンク', url: 'https://a.example/b' },
    ],
  };
  assert.deepEqual(L.timeline(item).map((e) => [e.kind, e.i, e.text]),
    [['file', 2, '昔のリンク'], ['file', 0, '見積書.pdf'], ['note', 0, '電話した'], ['mail', 1, '再見積']]);
  assert.deepEqual(L.timeline({}), []);
  assert.equal(L.fileKind('請求書.PDF'), 'pdf');
  assert.equal(L.fileKind('現場.jpeg'), 'image');
  assert.equal(L.fileKind('表.xlsx'), 'file');
  assert.equal(L.fileKind('名前だけ'), 'file');
});

test('検索：全角・半角・カタカナ・ひらがなの違いを気にしない。言葉が全部入っていれば当たり', () => {
  const item = { content: 'ガス会社にＴＥＬ', action: '', notes: [{ at: '', text: '見積もりは来週' }], attachments: [{ name: 'a.pdf', url: 'https://a.example/a', subject: '開栓の件', from: '東京ガス' }] };
  const text = L.itemText(item);
  assert.equal(L.matchesQuery(text, 'がす tel'), true);
  assert.equal(L.matchesQuery(text, '見積もり'), true);
  assert.equal(L.matchesQuery(text, '開栓 東京'), true);
  assert.equal(L.matchesQuery(text, 'ガス 水道'), false);
  assert.equal(L.matchesQuery(text, '  '), true);
  assert.equal(L.matchesQuery(L.mailText({ sender: '山田 <y@example.com>', subject: '請求書', excerpt: '振込先は…' }), '振込'), true);
});

test('よく出る言葉：2つ以上の文に出てくる言葉を、多い順に', () => {
  const words = L.frequentWords(['工事の見積もりが届いた', '見積もりを比べる', '工事の日を決める', '見積もりの返事', 'これはこれ'], 8);
  assert.equal(words[0], '見積もり');
  assert.ok(words.includes('工事'));
  assert.ok(!words.includes('これ'));
  assert.deepEqual(L.frequentWords(['一度だけの言葉'], 8), []);
});

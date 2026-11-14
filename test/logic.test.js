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

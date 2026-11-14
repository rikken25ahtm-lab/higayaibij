// 画面に依存しない計算（並べ替え・期限の判定）。ブラウザと Node のテストの両方から使う。
(function (root) {
  'use strict';

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  // Date → 'YYYY-MM-DD'（端末のローカル日付）
  function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // 今日から期限までの日数（期限切れはマイナス）。期限なしは null。
  function daysUntil(due, todayKey) {
    if (!due) return null;
    return Math.round((parseDateKey(due) - parseDateKey(todayKey)) / 86400000);
  }

  // 'overdue' | 'today' | 'soon'（3日以内）| 'later' | 'none'
  function dueLevel(due, todayKey) {
    const days = daysUntil(due, todayKey);
    if (days === null) return 'none';
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days <= 3) return 'soon';
    return 'later';
  }

  function dueLabel(due, todayKey) {
    const days = daysUntil(due, todayKey);
    if (days === null) return '期限なし';
    const date = parseDateKey(due);
    const sameYear = date.getFullYear() === parseDateKey(todayKey).getFullYear();
    const text = `${sameYear ? '' : date.getFullYear() + '/'}${date.getMonth() + 1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）`;
    if (days < 0) return `期限切れ ${text}・${-days}日超過`;
    if (days === 0) return `今日まで ${text}`;
    if (days === 1) return `明日まで ${text}`;
    if (days <= 3) return `あと${days}日 ${text}`;
    return text;
  }

  // 未完了：期限の近い順。期限なしは最後。同じ期限なら追加した順。
  function sortOpen(items) {
    return items.slice().sort((a, b) => {
      if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      }
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
  }

  // 完了：最近完了したものが上。
  function sortDone(items) {
    return items.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  function summarize(items, todayKey) {
    const counts = { overdue: 0, today: 0, soon: 0 };
    for (const item of items) {
      if (item.status === 'done') continue;
      const level = dueLevel(item.due, todayKey);
      if (level in counts) counts[level] += 1;
    }
    return counts;
  }

  const api = { toDateKey, daysUntil, dueLevel, dueLabel, sortOpen, sortDone, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);

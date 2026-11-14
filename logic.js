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

  // ---- 貼り付けた要約の読み取り ----

  function addDays(key, n) {
    const d = parseDateKey(key);
    d.setDate(d.getDate() + n);
    return toDateKey(d);
  }

  // 存在しない日付（2/30 など）は null
  function makeKey(y, m, d) {
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? toDateKey(date) : null;
  }

  // 「2026-11-20」「11/20」「11月20日」「明日」「来週の金曜」「月末」などを 'YYYY-MM-DD' にする。読めなければ null。
  function parseDue(text, todayKey) {
    if (!text) return null;
    const t = String(text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[／]/g, '/')
      .replace(/\s+/g, '');
    const today = parseDateKey(todayKey);
    const y = today.getFullYear();
    const mo = today.getMonth() + 1;
    const monthEnd = (yy, mm) => toDateKey(new Date(yy, mm, 0)); // mm は 1〜12。13 以上は翌年に繰り上がる
    let m;

    if ((m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/))) return makeKey(+m[1], +m[2], +m[3]);
    if ((m = t.match(/(\d{1,2})月末/))) return monthEnd(+m[1] < mo ? y + 1 : y, +m[1]);
    if ((m = t.match(/(今月|来月|再来月)(\d{1,2})日/))) {
      const first = new Date(y, mo - 1 + ['今月', '来月', '再来月'].indexOf(m[1]), 1);
      return makeKey(first.getFullYear(), first.getMonth() + 1, +m[2]);
    }
    if ((m = t.match(/(\d{1,2})[/月](\d{1,2})/))) {
      // 年が書かれていないとき：今年とみなす。半年以上前になる場合だけ来年とみなす。
      const key = makeKey(y, +m[1], +m[2]);
      return key && daysUntil(key, todayKey) < -180 ? makeKey(y + 1, +m[1], +m[2]) : key;
    }
    if (/再来月末/.test(t)) return monthEnd(y, mo + 2);
    if (/来月末/.test(t)) return monthEnd(y, mo + 1);
    if (/月末/.test(t)) return monthEnd(y, mo);
    if (/今日|本日/.test(t)) return todayKey;
    if (/明後日|あさって/.test(t)) return addDays(todayKey, 2);
    if (/明日|あした/.test(t)) return addDays(todayKey, 1);
    if ((m = t.match(/(\d+)日後/))) return addDays(todayKey, +m[1]);
    if ((m = t.match(/(\d+)週間後/))) return addDays(todayKey, +m[1] * 7);
    if ((m = t.match(/(再来週|来週|今週)?の?([月火水木金土日])曜/))) {
      const target = (WEEKDAYS.indexOf(m[2]) + 6) % 7; // 月曜を 0 とする
      const now = (today.getDay() + 6) % 7;
      if (!m[1]) return addDays(todayKey, (target - now + 7) % 7); // 次に来るその曜日（今日を含む）
      const weeks = { 今週: 0, 来週: 1, 再来週: 2 }[m[1]];
      return addDays(todayKey, target - now + weeks * 7);
    }
    if ((m = t.match(/^(\d{1,2})日/))) {
      // 「20日」だけ：今月。もう過ぎていれば来月。
      const key = makeKey(y, mo, +m[1]);
      if (key && daysUntil(key, todayKey) >= 0) return key;
      const next = new Date(y, mo, 1);
      return makeKey(next.getFullYear(), next.getMonth() + 1, +m[1]);
    }
    return null;
  }

  // 進捗は3つから選ぶ。AI が少し違う言い方をしても、近いものに寄せる。
  const PROGRESS_CHOICES = ['まだ', '途中', '返事待ち'];

  function normalizeProgress(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (/待ち|待機|保留/.test(t)) return '返事待ち';
    if (/まだ|未着手|未対応|これから|未定|未$/.test(t)) return 'まだ';
    if (/途中|進行中|対応中|作業中|着手|進めて/.test(t)) return '途中';
    return t; // どれにも当たらない文は、捨てずにそのまま残す
  }

  const PASTE_KEYS = [
    ['content', '内容|やること|タスク|タイトル|件名|用件'],
    ['category', 'カテゴリー|カテゴリ|分類|ジャンル'],
    ['action', '必要な対応|対応|アクション|やり方'],
    ['progress', '進捗|状況|現状'],
    ['assignee', '誰に任せるか|担当者|担当|任せる人'],
    ['dueText', '期限|締め切り|締切|〆切|期日'],
  ];
  const PASTE_LINE = new RegExp(
    '^[\\s\\-・*●■◆#>]*(?:\\d+[.)）]\\s*)?[\\s*_【\\[「]*(' + PASTE_KEYS.map((k) => k[1]).join('|') + ')[\\s*_】\\]」]*[:：]\\s*(.*)$'
  );
  const PASTE_LIMITS = { content: 200, category: 50, action: 500, progress: 200, assignee: 50 };
  const EMPTY_WORDS = /^(なし|無し|特になし|未定|不明|なし。|-|ー|―|—|n\/a|null)?$/i;

  // AI に決まった形で書いてもらった要約を、項目の候補に分ける。
  // 戻り値：[{ content, action, progress, assignee, due, dueText, dueUnreadable }]
  function parsePaste(text, todayKey) {
    const items = [];
    let current = null;
    let last = null;
    const clean = (v) => v.replace(/[*_]+$/g, '').replace(/^[*_]+/g, '').replace(/^[（(](.*)[）)]$/, '$1').trim();
    const start = () => {
      current = { content: '', category: '', action: '', progress: '', assignee: '', dueText: '' };
      items.push(current);
      last = null;
    };

    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (/^(-{3,}|={3,}|\*{3,}|_{3,})$/.test(line)) { current = null; continue; } // 区切り線
      if (!line) { last = null; continue; }
      const m = line.match(PASTE_LINE);
      if (m) {
        const field = PASTE_KEYS.find((k) => new RegExp('^(' + k[1] + ')$').test(m[1]))[0];
        if (!current || current[field] || (field === 'content' && (current.category || current.action || current.progress || current.assignee || current.dueText))) start();
        current[field] = clean(m[2]);
        last = field;
      } else if (current && last && last !== 'dueText' && last !== 'assignee' && last !== 'content' && last !== 'category') {
        current[last] += '\n' + line; // 対応・進捗の続きの行
      } else if (!current) {
        start();
        current.content = clean(line); // 決まった形でない文：1行目を内容にする
        last = 'action';
        current.loose = true;
      }
    }

    // 決まった形の項目が1件でもあれば、形に合わない文（AI の前置きなど）は候補にしない
    const keyed = items.some((item) => !item.loose);

    return items
      .filter((item) => !keyed || !item.loose)
      .map((item) => {
        const out = {};
        for (const [field, limit] of Object.entries(PASTE_LIMITS)) {
          const value = (item[field] || '').replace(/^\n+/, '').trim();
          out[field] = EMPTY_WORDS.test(value) ? '' : value.slice(0, limit);
        }
        out.progress = normalizeProgress(out.progress);
        const dueText = EMPTY_WORDS.test(item.dueText) ? '' : item.dueText;
        out.due = parseDue(dueText, todayKey);
        out.dueText = dueText;
        out.dueUnreadable = Boolean(dueText) && !out.due;
        return out;
      })
      .filter((item) => item.content || item.category || item.action || item.progress || item.assignee || item.dueText);
  }

  // ---- カテゴリ ----

  // 項目についているカテゴリの一覧（名前の順。「① …」「② …」のように番号をつけておくと、その順に並ぶ）
  function categoriesOf(items) {
    return [...new Set(items.map((item) => (item.category || '').trim()).filter(Boolean))].sort();
  }

  // 絞り込み。filter が null なら全部、'' なら「カテゴリなし」だけ
  function inCategory(item, filter) {
    return filter == null || (item.category || '') === filter;
  }

  // ---- メールからの候補・添付のリンク ----

  // 「山田 太郎 <yamada@example.com>」→「山田 太郎」。名前がなければアドレスを出す
  function senderName(sender) {
    const text = String(sender || '').trim();
    const match = text.match(/^(.*?)\s*<([^>]*)>$/);
    if (!match) return text;
    return match[1].replace(/^["']+|["']+$/g, '').trim() || match[2].trim();
  }

  // 件名の頭の「Re:」「Fwd:」などを取って、やることの「内容」の下書きにする
  function cleanSubject(subject) {
    return String(subject || '').replace(/^(\s*(re|fwd?|fw)\s*[:：]\s*)+/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  // リンクとして出してよいものだけを残す（https で始まるもの。名前がなければ「添付」）
  function safeLinks(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((link) => link && typeof link.url === 'string' && /^https:\/\/[^\s]+$/.test(link.url))
      .map((link) => ({ ...link, name: String(link.name || '').trim() || '添付', url: link.url }));
  }

  // 項目についているリンクに、新しいリンクを足す（同じリンクは重ねない）
  function mergeLinks(current, added) {
    const out = safeLinks(current);
    for (const link of safeLinks(added)) {
      if (!out.some((have) => have.url === link.url)) out.push(link);
    }
    return out;
  }

  // 候補 → やることにつけるリンク（保存した添付と、メールそのものへのリンク）
  function candidateLinks(candidate) {
    const mail = candidate.mailUrl ? [{ name: 'メールを開く', url: candidate.mailUrl, kind: 'mail' }] : [];
    return safeLinks([...(candidate.attachments || []), ...mail]);
  }

  // 届いた時刻を「11/14 10:05」の形で（端末の時刻）
  function mailTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const api = {
    toDateKey, daysUntil, dueLevel, dueLabel, sortOpen, sortDone, summarize, parseDue, parsePaste, PROGRESS_CHOICES, normalizeProgress,
    senderName, cleanSubject, safeLinks, mergeLinks, candidateLinks, mailTime, categoriesOf, inCategory,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);

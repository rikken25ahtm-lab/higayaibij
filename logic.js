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
    if (days <= 5) return `あと${days}日 ${text}`;
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

  // 候補 → やることにつけるリンク（保存した添付と、メールそのものへのリンク）。
  // 項目の履歴に並べられるように、届いた時刻・差出人・件名も持たせる
  function candidateLinks(candidate) {
    const about = {};
    if (candidate.receivedAt) about.at = candidate.receivedAt;
    if (candidate.sender) about.from = senderName(candidate.sender);
    if (candidate.subject) about.subject = cleanSubject(candidate.subject);
    const files = (candidate.attachments || []).map((file) => (file && typeof file === 'object' ? { ...file, ...about } : file));
    const mail = candidate.mailUrl ? [{ name: 'メールを開く', url: candidate.mailUrl, kind: 'mail', ...about }] : [];
    return safeLinks([...files, ...mail]);
  }

  // 届いた時刻を「11/14 10:05」の形で（端末の時刻）
  function mailTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }


  // ---- 期限の色・直近 ----

  // 期限まで2日を切ったら（期限切れ・今日・明日）'red'、5日以内は 'yellow'、それより先は 'green'。期限なしは 'none'
  function dueColor(due, todayKey) {
    const days = daysUntil(due, todayKey);
    if (days === null) return 'none';
    if (days < 2) return 'red';
    if (days <= 5) return 'yellow';
    return 'green';
  }

  // 直近：まだ終わっていなくて、期限が3日以内（今日・期限切れを含む）
  function isNear(item, todayKey) {
    if (item.status === 'done') return false;
    const days = daysUntil(item.due, todayKey);
    return days !== null && days <= 3;
  }

  // ---- 繰り返し ----

  const REPEAT_CHOICES = [['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']];

  function repeatLabel(repeat) {
    const found = REPEAT_CHOICES.find((c) => c[0] === repeat);
    return found ? found[1] : '';
  }

  // n か月後の同じ日。その日がない月（31日など）は、月の最後の日にする
  function addMonths(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    const last = new Date(y, m - 1 + n + 1, 0);
    return toDateKey(new Date(last.getFullYear(), last.getMonth(), Math.min(d, last.getDate())));
  }

  // 完了にしたときの、次の回の期限。期限なしの項目は今日から数える。
  // 遅れて完了にしても、次の回が過去の日付にならないように、今日より後になるまで進める
  function nextDue(due, repeat, todayKey) {
    if (!repeatLabel(repeat)) return null;
    const base = due || todayKey;
    const step = (n) =>
      repeat === 'daily' ? addDays(base, n)
        : repeat === 'weekly' ? addDays(base, n * 7)
          : addMonths(base, repeat === 'monthly' ? n : n * 12);
    let n = 1;
    while (step(n) <= todayKey) n += 1;
    return step(n);
  }

  // ---- メモ・履歴 ----

  // メモは [{ at, text }]。形の合わないものは捨てる
  function safeNotes(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((n) => n && typeof n.text === 'string' && n.text.trim())
      .map((n) => ({ at: typeof n.at === 'string' ? n.at : '', text: n.text.trim().slice(0, 1000) }));
  }

  // 項目に紐づくもの（メモ・メール・添付）を、古い順に並べる。時刻のわからないものは先頭。
  // i は、safeNotes / safeLinks で整えた一覧の中での順番（編集で「外す」ものを指すのに使う）
  function timeline(item) {
    const entries = [
      ...safeNotes(item.notes).map((n, i) => ({ kind: 'note', i, at: n.at, text: n.text })),
      ...safeLinks(item.attachments).map((l, i) => ({
        i,
        kind: l.kind === 'mail' ? 'mail' : 'file',
        at: typeof l.at === 'string' ? l.at : '',
        text: l.kind === 'mail' ? l.subject || 'メール' : l.name,
        from: l.from || '',
        url: l.url,
      })),
    ];
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.index - b.index))
      .map((x) => x.entry);
  }

  // 添付の種類（名前の終わりから）。'pdf' | 'image' | 'file'
  function fileKind(name) {
    const ext = (String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1];
    if (!ext) return 'file';
    if (/^pdf$/i.test(ext)) return 'pdf';
    if (/^(jpe?g|png|gif|heic|heif|webp|bmp|tiff?)$/i.test(ext)) return 'image';
    return 'file';
  }

  // ---- 検索 ----

  // 全角と半角、大文字と小文字、カタカナとひらがなの違いをなくす（「ミツモリ」でも「みつもり」でも当たるように）
  function normalizeText(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  // 項目の中の、探す対象になる文（内容・対応・担当・カテゴリ・進捗・メモ・添付の名前・メールの件名と差出人）
  function itemText(item) {
    return [
      item.content, item.action, item.assignee, item.category, item.progress,
      ...safeNotes(item.notes).map((n) => n.text),
      ...safeLinks(item.attachments).flatMap((l) => [l.name, l.subject, l.from]),
    ].filter(Boolean).join('\n');
  }

  function mailText(mail) {
    return [mail.sender, mail.subject, mail.excerpt, ...safeLinks(mail.attachments).map((l) => l.name)].filter(Boolean).join('\n');
  }

  // 空白で区切った言葉が、全部入っていれば当たり
  function matchesQuery(text, query) {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const target = normalizeText(text);
    return terms.every((term) => target.includes(term));
  }

  const STOP_WORDS = new Set([
    'こと', 'もの', 'ため', 'よう', 'とき', 'ところ', 'これ', 'それ', 'あれ', 'ここ', 'そこ', 'から', 'まで', 'です', 'ます', 'する', 'した', 'して',
    'ない', 'ある', 'いる', 'なる', 'お願い', '以下', '以上', '下記', '上記', '場合', '件名', '宛先', '送信', '返信', '確認', '連絡', '対応',
    '今日', '明日', '本日', '自分', 'http', 'https', 'www', 'com', 'jp', 'mail', 'gmail', 're', 'fw', 'fwd',
  ]);

  // 文を言葉に分ける。端末が日本語の分かち書きに対応していなければ、カタカナ・漢字・英字のかたまりで分ける
  function splitWords(text) {
    const source = String(text || '').normalize('NFKC');
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const out = [];
      for (const part of new Intl.Segmenter('ja', { granularity: 'word' }).segment(source)) {
        if (part.isWordLike) out.push(part.segment);
      }
      return out;
    }
    return source.match(/[ァ-ヺー]{2,}|[一-鿿]{2,}|[A-Za-z]{3,}/g) || [];
  }

  // よく出てくる言葉（いくつの文に出てくるかで数える）。2つ以上の文に出てくるものだけを、多い順に返す。
  // ひらがなだけの言葉・数字・1文字の言葉は、探す手がかりになりにくいので外す
  function frequentWords(texts, limit) {
    const counts = new Map();
    for (const text of texts) {
      const seen = new Set();
      for (const raw of splitWords(text)) {
        const word = raw.toLowerCase();
        if (word.length < 2 || word.length > 20) continue;
        if (/^[ぁ-ゖー]+$/.test(word) || /^[\d.,:/-]+$/.test(word) || STOP_WORDS.has(word)) continue;
        seen.add(word);
      }
      for (const word of seen) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit || 8)
      .map(([word]) => word);
  }

  const api = {
    toDateKey, daysUntil, dueLevel, dueLabel, sortOpen, sortDone, summarize, parseDue, parsePaste, PROGRESS_CHOICES, normalizeProgress,
    senderName, cleanSubject, safeLinks, mergeLinks, candidateLinks, mailTime, categoriesOf, inCategory,
    dueColor, isNear, REPEAT_CHOICES, repeatLabel, nextDue, safeNotes, timeline, fileKind,
    normalizeText, itemText, mailText, matchesQuery, frequentWords,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof self !== 'undefined' ? self : this);

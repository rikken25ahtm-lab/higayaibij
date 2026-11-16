// ひがやいびん：朝と夕方の報告を、スマホの通知（Web Push）で送る。時刻は人ごとに選べる（既定は朝10時・夕方17時）。
// Supabase の Edge Function として動かす。外部のライブラリは使わない。
//
//   GET  …/report        通知の登録に使う公開鍵を返す（初回に鍵を作って保存する）
//   POST …/report        時刻の決まった報告。毎時0分に呼ばれ、その時刻を選んでいる人にだけ、1回だけ送る
//   POST …/report  + ログイン中の Authorization   本人の端末だけに、今の内容をすぐ送る（お試し用）
//   POST …/report  + ログイン中の Authorization + { view }   その回の報告の中身を返す（通知から開いたページ用）
//   POST …/report  + { mail_token }   Gmail の側から、メールを届けた直後に呼ばれる。緊急のメールだけ、その場で通知する
//
// 報告の中身は、その時間帯に起きたこと（追加・期限の変更・完了・削除）、届いたメールの要点、期限の近い件数。
//
// 型注釈を書いていないので、Node からもそのまま読み込んでテストできる。

const enc = new TextEncoder();
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_LINES = 6;

// ---------- 報告の文面 ----------

// Date → 日本時間の { dateKey: 'YYYY-MM-DD', hour }
export function jstNow(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return { dateKey: j.toISOString().slice(0, 10), hour: j.getUTCHours() };
}

// 報告の時刻（日本時間の「時」）。本人が変えられる。null は、その回を受け取らない
export const DEFAULT_TIMES = { morning: 10, evening: 17 };

export function cleanTimes(row) {
  const hour = (value, fallback) => (value === null ? null : Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback);
  if (!row) return { ...DEFAULT_TIMES };
  return { morning: hour(row.morning_hour, DEFAULT_TIMES.morning), evening: hour(row.evening_hour, DEFAULT_TIMES.evening) };
}

// その「時」が、その人の朝の報告なら 'morning'、夕方の報告なら 'evening'、どちらでもなければ null
export function slotFor(hour, times = DEFAULT_TIMES) {
  if (times.morning === hour) return 'morning';
  if (times.evening === hour) return 'evening';
  return null;
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86400000);
}

// 画面（logic.js の dueLevel）と同じ分け方：期限切れ／今日／3日以内
export function dueLevel(due, todayKey) {
  if (!due) return 'none';
  const diff = daysBetween(todayKey, due);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff <= 3) return 'soon';
  return 'later';
}

function shortDate(key) {
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function clip(text, max) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

const HOUR_MS = 60 * 60 * 1000;

// 報告が対象にする時間の範囲：前の回の報告の時刻から、その回の時刻まで。
//   既定（朝10時・夕方17時）なら、朝の報告 … 前日17時〜当日10時 ／ 夕方の報告 … 当日10時〜17時
//   片方を受け取らない人は、前の日の同じ回から（24時間）
export function slotWindow(dateKey, slot, times = DEFAULT_TIMES) {
  const midnight = Date.parse(dateKey) - JST_OFFSET_MS; // 日本時間の0時
  const end = times[slot];
  const other = times[slot === 'morning' ? 'evening' : 'morning'];
  // 前の回：同じ日のもう片方（今回より前の時刻なら）、なければ前の日
  const back = other === null || other === undefined ? 24 : (end - other + 24) % 24 || 24;
  return { start: new Date(midnight + (end - back) * HOUR_MS), end: new Date(midnight + end * HOUR_MS) };
}

// 「今すぐ試しに送る」用：直前の報告の時刻から今まで
export function currentWindow(now, times = DEFAULT_TIMES) {
  const { dateKey, hour } = jstNow(now);
  const midnight = Date.parse(dateKey) - JST_OFFSET_MS;
  const hours = [times.morning, times.evening].filter((h) => h !== null && h !== undefined);
  if (!hours.length) return { start: new Date(now.getTime() - 24 * HOUR_MS), end: new Date(now.getTime() + 1000) };
  // 今日すでに過ぎた回のうち最後のもの。まだなければ、前の日の最後の回
  const passed = hours.filter((h) => h <= hour);
  const from = passed.length ? Math.max(...passed) : Math.max(...hours) - 24;
  return { start: new Date(midnight + from * HOUR_MS), end: new Date(now.getTime() + 1000) };
}

// 時間内の記録（item_events）を、項目ごとに「結局どうなったか」へまとめる。
// 例：追加してすぐ消した項目は出さない。期限を2回変えたら、最初→最後だけを出す。
export function summarizeEvents(events) {
  const byItem = new Map();
  for (const e of events) byItem.set(e.item_id, [...(byItem.get(e.item_id) || []), e]);

  const changes = [];
  for (const [itemId, list] of byItem) {
    const first = list[0];
    const last = list[list.length - 1];
    const existedBefore = first.kind !== 'added';
    const existsAfter = last.kind !== 'deleted';
    const base = { itemId, content: last.content };
    if (!existedBefore && !existsAfter) continue;
    if (!existedBefore) { changes.push({ ...base, kind: 'added', due: last.new_due }); continue; }
    if (!existsAfter) { changes.push({ ...base, kind: 'deleted' }); continue; }

    const dueEvents = list.filter((e) => e.kind === 'due_changed');
    if (dueEvents.length) {
      const from = dueEvents[0].old_due;
      const to = dueEvents[dueEvents.length - 1].new_due;
      if (from !== to) changes.push({ ...base, kind: 'due_changed', from, to });
    }
    const statusEvents = list.filter((e) => e.kind === 'done' || e.kind === 'reopened');
    if (statusEvents.length && statusEvents[0].kind === statusEvents[statusEvents.length - 1].kind) {
      changes.push({ ...base, kind: statusEvents[0].kind });
    }
  }
  const order = ['added', 'due_changed', 'done', 'reopened', 'deleted'];
  return changes.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
}

const KIND_LABEL = { added: '追加', due_changed: '期限変更', done: '完了', reopened: '未完了に戻す', deleted: '削除' };
const dueText = (due) => (due ? shortDate(due) : 'なし');

function changeLine(change) {
  const name = clip(change.content, 22);
  if (change.kind === 'added') return `【追加】${name}${change.due ? `（期限 ${shortDate(change.due)}）` : ''}`;
  if (change.kind === 'due_changed') return `【期限変更】${name}：${dueText(change.from)}→${dueText(change.to)}`;
  return `【${KIND_LABEL[change.kind]}】${name}`;
}

// 期限の近いものの件数を1行で。朝も夕方も同じ形で、0件でも必ず出す。
// どれも「その日までに期限が来るもの」の合計（期限切れを含み、前の区分と重ねて数える）
function deadlineLine(items, todayKey) {
  const open = items.filter((item) => item.status === 'open' && item.due);
  const count = (days) => open.filter((item) => daysBetween(todayKey, item.due) <= days).length;
  return `本日まで：${count(0)}件　翌日まで：${count(1)}件　3日以内：${count(3)}件`;
}

// 「山田 太郎 <yamada@example.com>」→「山田 太郎」。名前がなければアドレスを出す
export function senderName(sender) {
  const text = String(sender || '').trim();
  const match = text.match(/^(.*?)\s*<([^>]*)>$/);
  if (!match) return text;
  return match[1].replace(/^["']+|["']+$/g, '').trim() || match[2].trim();
}

// 届いたメールの要点：誰から・件名・添付の数
function mailLine(mail) {
  const from = clip(senderName(mail.sender), 12);
  const count = Array.isArray(mail.attachments) ? mail.attachments.length : 0;
  return `【メール】${from ? `${from}：` : ''}${clip(mail.subject, 22) || '（件名なし）'}${count ? `（添付${count}）` : ''}`;
}

// 時間内の記録・今の項目・時間内に届いたメール → 通知の { title, body } と、画面で使う { lines, itemIds }
export function buildReport(events, items, todayKey, slot, mails = []) {
  const greeting = slot === 'evening' ? '夕方の報告' : slot === 'morning' ? '朝の報告' : '今の状況';
  const changes = summarizeEvents(events);
  const deadline = deadlineLine(items, todayKey);

  const lines = [...changes.map(changeLine), ...mails.map(mailLine)];
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`ほか ${lines.length - MAX_LINES}件`);
  shown.push(deadline);

  const counts = Object.keys(KIND_LABEL)
    .map((kind) => [kind, changes.filter((c) => c.kind === kind).length])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${KIND_LABEL[kind]}${n}`);
  if (mails.length) counts.push(`メール${mails.length}`);

  return {
    title: counts.length ? `${greeting}：${counts.join('・')}` : `${greeting}：動きはありません`,
    body: shown.join('\n'),
    lines: [...lines, deadline], // 画面では省略せずに全部出す
    itemIds: changes.filter((c) => c.kind !== 'deleted').map((c) => c.itemId),
  };
}

// ---------- 緊急のメールの判定（AI は使わず、決まりで判定する） ----------

const URGENT_WORDS = /大至急|至急|緊急|早急|急ぎ|本日中|今日中|明日中|明日まで|本日まで|今日まで|督促|最終のご案内|最終通知|期限が過ぎ|期限を過ぎ|urgent|asap/i;
const DUE_WORDS = '(?:まで|迄|期限|期日|締切|締め切り|〆切|必着)';
const MAIL_DATE = '(?:(\\d{4})[年/])?(\\d{1,2})[月/](\\d{1,2})日?';
const DATE_THEN_DUE = new RegExp(MAIL_DATE + '[^\\n。]{0,8}?' + DUE_WORDS, 'g');   // 「11月17日までに」「11/17（火）必着」
const DUE_THEN_DATE = new RegExp(DUE_WORDS + '[^\\n。\\d]{0,8}' + MAIL_DATE, 'g'); // 「お支払い期限：11月17日」

function toHalfWidth(text) {
  return String(text || '').replace(/[０-９／：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 文の中の「期限つきの日付」を 'YYYY-MM-DD' の一覧にする。年がなければ今年（もう過ぎた月日なら来年とはせず、過去として捨てる）
function deadlinesIn(text, todayKey) {
  const year = Number(todayKey.slice(0, 4));
  const out = [];
  for (const pattern of [DATE_THEN_DUE, DUE_THEN_DATE]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      const y = m[1] ? Number(m[1]) : year;
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const date = new Date(Date.UTC(y, mo - 1, d));
      if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) continue; // 13月40日のような、日付でない数字
      out.push(date.toISOString().slice(0, 10));
    }
  }
  return out;
}

// 緊急かどうかと、その理由。important は、本人が「大事な相手」に入れた言葉（アドレス・ドメイン・名前の一部）
//   1. 大事な相手から届いた  2. 「至急」「本日中」などの言葉がある  3. 3日以内の期限が書かれている
export function mailUrgency(mail, important, todayKey) {
  const sender = String(mail.sender || '').toLowerCase();
  const who = (important || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean).find((s) => sender.includes(s));
  if (who) return { urgent: true, reason: '大事な相手から' };

  const text = toHalfWidth(`${mail.subject || ''}\n${String(mail.excerpt || '').slice(0, 800)}`);
  const word = text.match(URGENT_WORDS);
  if (word) return { urgent: true, reason: `「${word[0]}」とある` };

  const near = deadlinesIn(text, todayKey)
    .map((key) => [key, daysBetween(todayKey, key)])
    .filter(([, days]) => days >= 0 && days <= 3)
    .sort((a, b) => a[1] - b[1])[0];
  if (near) return { urgent: true, reason: `期限が近い（${shortDate(near[0])}）` };
  return { urgent: false, reason: '' };
}

const MAX_URGENT_PUSHES = 3;                 // 1回に送る緊急の通知の数（それ以上は、まとめて1通）
const URGENT_FRESH_MS = 2 * 60 * 60 * 1000;  // 届いてから時間のたった候補は、判定だけして通知はしない

// 緊急のメール → 通知。多いときは、最後の1通にまとめる
export function urgentMessages(urgent) {
  const one = (mail) => ({
    title: `緊急のメール：${clip(senderName(mail.sender), 16) || '差出人なし'}`,
    body: `${clip(mail.subject, 40) || '（件名なし）'}\n${mail.reason}`,
    tag: `mail-${mail.id}`,
    view: 'mail',
  });
  if (urgent.length <= MAX_URGENT_PUSHES) return urgent.map(one);
  const rest = urgent.slice(MAX_URGENT_PUSHES - 1);
  return [
    ...urgent.slice(0, MAX_URGENT_PUSHES - 1).map(one),
    { title: `緊急のメール：ほか${rest.length}件`, body: rest.map((m) => clip(m.subject, 24) || '（件名なし）').join('\n'), tag: 'mail-more', view: 'mail' },
  ];
}

// ---------- Web Push（RFC 8291 の暗号化と、RFC 8292 の VAPID 署名） ----------

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// 通知の本文を、受け取る端末だけが読める形に暗号化する（aes128gcm）
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = 最後のレコードの印
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, body));

  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  return {
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

// 「この通知は、ひがやいびんのサーバーが送った」ことを通知の配信元に示す署名
export async function vapidHeader(endpoint, vapid, subject, nowSeconds) {
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 60 * 60,
    sub: subject,
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

// 1台に送る。戻り値は配信元の HTTP ステータス（201 が成功、404・410 は登録が無効）
export async function sendPush(subscription, message, vapid, subject, fetchImpl = fetch) {
  const body = await encryptPayload(subscription, JSON.stringify(message));
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid, subject, Math.floor(Date.now() / 1000)),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(6 * 60 * 60), // 端末が圏外でも6時間は配信を試みる
      Urgency: 'normal',
    },
    body,
  });
  return response.status;
}

// ---------- Supabase とのやりとり（管理者の権限。Edge Function の中だけで使う） ----------

function createDb(url, serviceKey, fetchImpl = fetch) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  async function rest(path, init = {}) {
    const response = await fetchImpl(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    async getVapid() {
      const rows = await rest('push_config?key=eq.vapid&select=value');
      if (rows.length) return rows[0].value;
      // 初回だけ鍵を作る。同時に2回呼ばれても、先に保存されたほうを使う
      await rest('push_config', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({ key: 'vapid', value: await generateVapidKeys() }),
      });
      return (await rest('push_config?key=eq.vapid&select=value'))[0].value;
    },
    // この回の報告をまだ送っていなければ true（同じ回を2度送らないための記録）
    async claimSlot(slotKey) {
      const rows = await rest('report_log', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ slot: slotKey }),
      });
      return rows.length > 0;
    },
    subscriptions(userId) {
      return rest(`push_subscriptions?select=*${userId ? `&user_id=eq.${userId}` : ''}`);
    },
    events(userId, { start, end }) {
      return rest(`item_events?select=item_id,kind,content,old_due,new_due&user_id=eq.${userId}` +
        `&at=gte.${start.toISOString()}&at=lt.${end.toISOString()}&order=at.asc,id.asc`);
    },
    // 時間内に届いたメールの候補。メールの連携をまだ設定していなければ（表がなければ）0件として扱う
    async mails(userId, { start, end }) {
      try {
        return await rest(`mail_candidates?select=sender,subject,attachments&user_id=eq.${userId}` +
          `&created_at=gte.${start.toISOString()}&created_at=lt.${end.toISOString()}&order=created_at.asc`);
      } catch (_) {
        return [];
      }
    },
    // 報告の時刻（人ごと）。まだ表がなければ（SQL を実行し直していなければ）、全員が既定の時刻
    async times(userId) {
      try {
        const rows = await rest(`notify_settings?select=user_id,morning_hour,evening_hour${userId ? `&user_id=eq.${userId}` : ''}`);
        return new Map(rows.map((row) => [row.user_id, cleanTimes(row)]));
      } catch (_) {
        return new Map();
      }
    },
    // ---- 緊急のメール ----
    // 合言葉から持ち主を確かめる。違っていれば null
    async mailOwner(token) {
      try {
        return await rest('rpc/mail_owner', { method: 'POST', body: JSON.stringify({ p_token: token }) });
      } catch (_) {
        return null;
      }
    },
    async importantSenders(userId) {
      const rows = await rest(`mail_links?select=important&user_id=eq.${userId}`);
      return rows.length && Array.isArray(rows[0].important) ? rows[0].important : [];
    },
    // まだ判定していない候補（古い順）
    uncheckedMails(userId) {
      return rest(`mail_candidates?select=id,sender,subject,excerpt,created_at&user_id=eq.${userId}&checked_at=is.null&order=created_at.asc&limit=50`);
    },
    markMail(id, urgent, reason, now) {
      return rest(`mail_candidates?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ urgent, urgent_reason: reason, checked_at: now.toISOString() }),
      });
    },
    openItems(userId) {
      return rest(`items?select=content,progress,assignee,due,status&status=eq.open&user_id=eq.${userId}`);
    },
    removeSubscription(endpoint) {
      return rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
    },
    // ログイン中の本人を確かめる。確かめられなければ null
    async userFromToken(token) {
      const response = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
      if (!response.ok) return null;
      const user = await response.json();
      return user && user.id ? user.id : null;
    },
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// 1人の端末すべてに、同じ通知を送る。無効になった登録は消す
async function pushTo(db, subs, message, vapid, subject, fetchImpl) {
  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    let status = 0;
    try {
      status = await sendPush(sub, message, vapid, subject, fetchImpl);
    } catch (_) { /* 1台の失敗で、ほかの端末への送信を止めない */ }
    if (status >= 200 && status < 300) sent++;
    else {
      failed++;
      if (status === 404 || status === 410) await db.removeSubscription(sub.endpoint); // 端末側で通知が解除された
    }
  }
  return { sent, failed };
}

// Gmail の側から呼ばれる：まだ判定していない候補を判定し、緊急のものだけをその場で通知する
async function checkMails(db, vapid, subject, userId, todayKey, now, fetchImpl) {
  const [mails, important] = await Promise.all([db.uncheckedMails(userId), db.importantSenders(userId)]);
  const urgent = [];
  for (const mail of mails) {
    const { urgent: isUrgent, reason } = mailUrgency(mail, important, todayKey);
    await db.markMail(mail.id, isUrgent, reason, now);
    const fresh = now.getTime() - new Date(mail.created_at).getTime() <= URGENT_FRESH_MS;
    if (isUrgent && fresh) urgent.push({ ...mail, reason });
  }
  let sent = 0;
  let failed = 0;
  if (urgent.length) {
    const subs = await db.subscriptions(userId);
    for (const message of urgentMessages(urgent)) {
      const result = await pushTo(db, subs, message, vapid, subject, fetchImpl);
      sent += result.sent;
      failed += result.failed;
    }
  }
  return { checked: mails.length, urgent: urgent.length, sent, failed };
}

async function reportFor(db, userId, todayKey, slot, window) {
  const [events, items, mails] = await Promise.all([db.events(userId, window), db.openItems(userId), db.mails(userId, window)]);
  return buildReport(events, items, todayKey, slot, mails);
}

// 1人に、その回の報告を送る
async function deliverTo(db, vapid, subject, todayKey, slot, window, userId, subs, fetchImpl) {
  const { title, body } = await reportFor(db, userId, todayKey, slot, window);
  // view は、通知を押したときにページが開く報告（例：2026-11-14-morning）
  const message = { title, body, tag: slot || 'now', view: slot ? `${todayKey}-${slot}` : 'now' };
  return pushTo(db, subs, message, vapid, subject, fetchImpl);
}

// 通知を受け取る人ごとに、端末の登録をまとめる
async function subscribers(db, userId) {
  const byUser = new Map();
  for (const sub of await db.subscriptions(userId)) byUser.set(sub.user_id, [...(byUser.get(sub.user_id) || []), sub]);
  return byUser;
}

export async function handle(request, env, fetchImpl = fetch, now = new Date()) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const db = createDb(env.url, env.serviceKey, fetchImpl);
  try {
    const vapid = await db.getVapid();
    if (request.method === 'GET') return json({ publicKey: vapid.publicKey });
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const { dateKey, hour } = jstNow(now);
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const input = await request.json().catch(() => ({}));

    // Gmail の側からの呼び出し（メールを届けた直後）。合言葉で持ち主を確かめる
    if (input && typeof input.mail_token === 'string') {
      const owner = await db.mailOwner(input.mail_token);
      if (!owner) return json({ error: '合言葉が違います' }, 403);
      return json({ mode: 'mail', ...(await checkMails(db, vapid, env.url, owner, dateKey, now, fetchImpl)) });
    }

    // ログイン中の本人からの呼び出し
    const userId = token ? await db.userFromToken(token) : null;
    if (userId) {
      // 通知を押して開いたページに、その回の報告を返す（送信はしない）
      const times = (await db.times(userId)).get(userId) || { ...DEFAULT_TIMES };
      if (input && typeof input.view === 'string') {
        const match = input.view.match(/^(\d{4}-\d{2}-\d{2})-(morning|evening)$/);
        const report = match
          ? await reportFor(db, userId, dateKey, match[2], slotWindow(match[1], match[2], times))
          : await reportFor(db, userId, dateKey, null, currentWindow(now, times));
        return json({ mode: 'view', title: report.title, lines: report.lines, itemIds: report.itemIds });
      }
      // 「今すぐ試しに送る」
      const mine = (await subscribers(db, userId)).get(userId) || [];
      return json({ mode: 'test', ...(await deliverTo(db, vapid, env.url, dateKey, null, currentWindow(now, times), userId, mine, fetchImpl)) });
    }

    // 時刻の決まった報告。毎時呼ばれ、その「時」を選んでいる人にだけ送る。同じ時刻の回は1度だけ
    const [byUser, allTimes] = await Promise.all([subscribers(db, null), db.times(null)]);
    const due = [...byUser].map(([uid, subs]) => {
      const times = allTimes.get(uid) || { ...DEFAULT_TIMES };
      return { uid, subs, times, slot: slotFor(hour, times) };
    }).filter((user) => user.slot);
    if (!due.length) return json({ mode: 'schedule', skipped: 'time' });
    if (!(await db.claimSlot(`${dateKey}-${String(hour).padStart(2, '0')}`))) return json({ mode: 'schedule', skipped: 'already-sent' });

    let sent = 0;
    let failed = 0;
    for (const user of due) {
      const result = await deliverTo(db, vapid, env.url, dateKey, user.slot, slotWindow(dateKey, user.slot, user.times), user.uid, user.subs, fetchImpl);
      sent += result.sent;
      failed += result.failed;
    }
    const slots = [...new Set(due.map((user) => user.slot))];
    return json({ mode: 'schedule', slot: slots.length === 1 ? slots[0] : 'mixed', sent, failed });
  } catch (error) {
    console.error(error);
    return json({ error: String(error && error.message ? error.message : error) }, 500);
  }
}

if (typeof Deno !== 'undefined') {
  Deno.serve((request) => handle(request, {
    url: Deno.env.get('SUPABASE_URL'),
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  }));
}

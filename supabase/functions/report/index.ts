// ひがやいびん：朝10時・夕方17時の報告を、スマホの通知（Web Push）で送る。
// Supabase の Edge Function として動かす。外部のライブラリは使わない。
//
//   GET  …/report        通知の登録に使う公開鍵を返す（初回に鍵を作って保存する）
//   POST …/report        時刻の決まった報告。朝10時台・夕方17時台に、1回だけ全員へ送る
//   POST …/report  + ログイン中の Authorization   本人の端末だけに、今の内容をすぐ送る（お試し用）
//   POST …/report  + ログイン中の Authorization + { view }   その回の報告の中身を返す（通知から開いたページ用）
//
// 報告の中身は、その時間帯に起きたこと（追加・期限の変更・完了・削除）と、期限の近い件数。
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

// 朝10時台は 'morning'、夕方17時台は 'evening'、それ以外は null
export function slotFor(hour) {
  if (hour === 10) return 'morning';
  if (hour === 17) return 'evening';
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

// 報告が対象にする時間の範囲（設計メモ 6.）
//   朝10時の報告 … 前日17時〜当日10時 ／ 夕方17時の報告 … 当日10時〜17時
export function slotWindow(dateKey, slot) {
  const midnight = Date.parse(dateKey) - JST_OFFSET_MS; // 日本時間の0時
  return slot === 'morning'
    ? { start: new Date(midnight - 7 * HOUR_MS), end: new Date(midnight + 10 * HOUR_MS) }
    : { start: new Date(midnight + 10 * HOUR_MS), end: new Date(midnight + 17 * HOUR_MS) };
}

// 「今すぐ試しに送る」用：直前の報告の時刻から今まで
export function currentWindow(now) {
  const { dateKey, hour } = jstNow(now);
  const midnight = Date.parse(dateKey) - JST_OFFSET_MS;
  const from = hour >= 17 ? 17 : hour >= 10 ? 10 : -7;
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

// 期限の近いものの件数を1行で。
// 夕方は、明日の段取りがつくように「本日まで／翌日まで／3日以内」を、0件でも必ず出す。
// どれも「その日までに期限が来るもの」の合計（期限切れを含み、前の区分と重ねて数える）。
// 朝は「期限切れ／今日／3日以内」で、該当があるものだけ出す。なければ空文字
function deadlineLine(items, todayKey, slot) {
  const open = items.filter((item) => item.status === 'open' && item.due);
  const count = (test) => open.filter((item) => test(daysBetween(todayKey, item.due))).length;
  if (slot === 'evening') {
    return `本日まで：${count((d) => d <= 0)}件　翌日まで：${count((d) => d <= 1)}件　3日以内：${count((d) => d <= 3)}件`;
  }
  const parts = [['期限切れ', count((d) => d < 0)], ['今日', count((d) => d === 0)], ['3日以内', count((d) => d >= 1 && d <= 3)]];
  const shown = parts.filter(([, n]) => n > 0).map(([label, n]) => `${label}${n}件`);
  return shown.length ? `いまの期限：${shown.join('・')}` : '';
}

// 時間内の記録と今の項目 → 通知の { title, body } と、画面で使う { lines, itemIds }
export function buildReport(events, items, todayKey, slot) {
  const greeting = slot === 'evening' ? '夕方の報告' : slot === 'morning' ? '朝の報告' : '今の状況';
  const changes = summarizeEvents(events);
  const deadline = deadlineLine(items, todayKey, slot);

  const lines = changes.map(changeLine);
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`ほか ${lines.length - MAX_LINES}件`);
  if (deadline) shown.push(deadline);

  const counts = Object.keys(KIND_LABEL)
    .map((kind) => [kind, changes.filter((c) => c.kind === kind).length])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${KIND_LABEL[kind]}${n}`);

  return {
    title: counts.length ? `${greeting}：${counts.join('・')}` : `${greeting}：動きはありません`,
    body: shown.length ? shown.join('\n') : '急ぎの期限もありません。',
    lines: deadline ? [...lines, deadline] : lines, // 画面では省略せずに全部出す
    itemIds: changes.filter((c) => c.kind !== 'deleted').map((c) => c.itemId),
  };
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

async function reportFor(db, userId, todayKey, slot, window) {
  const [events, items] = await Promise.all([db.events(userId, window), db.openItems(userId)]);
  return buildReport(events, items, todayKey, slot);
}

// 登録されている端末へ送る。userId を渡すと、その人の端末だけ
async function deliver(db, vapid, subject, todayKey, slot, window, userId, fetchImpl) {
  const subs = await db.subscriptions(userId);
  const byUser = new Map();
  for (const sub of subs) byUser.set(sub.user_id, [...(byUser.get(sub.user_id) || []), sub]);

  let sent = 0;
  let failed = 0;
  for (const [uid, list] of byUser) {
    const { title, body } = await reportFor(db, uid, todayKey, slot, window);
    // view は、通知を押したときにページが開く報告（例：2026-11-14-morning）
    const message = { title, body, tag: slot || 'now', view: slot ? `${todayKey}-${slot}` : 'now' };
    for (const sub of list) {
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
  }
  return { sent, failed };
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

    // ログイン中の本人からの呼び出し
    const userId = token ? await db.userFromToken(token) : null;
    if (userId) {
      // 通知を押して開いたページに、その回の報告を返す（送信はしない）
      if (input && typeof input.view === 'string') {
        const match = input.view.match(/^(\d{4}-\d{2}-\d{2})-(morning|evening)$/);
        const report = match
          ? await reportFor(db, userId, dateKey, match[2], slotWindow(match[1], match[2]))
          : await reportFor(db, userId, dateKey, null, currentWindow(now));
        return json({ mode: 'view', title: report.title, lines: report.lines, itemIds: report.itemIds });
      }
      // 「今すぐ試しに送る」
      return json({ mode: 'test', ...(await deliver(db, vapid, env.url, dateKey, null, currentWindow(now), userId, fetchImpl)) });
    }

    // 時刻の決まった報告。朝10時台・夕方17時台だけ、各回1度だけ送る
    const slot = slotFor(hour);
    if (!slot) return json({ mode: 'schedule', skipped: 'time' });
    if (!(await db.claimSlot(`${dateKey}-${slot}`))) return json({ mode: 'schedule', skipped: 'already-sent' });
    return json({ mode: 'schedule', slot, ...(await deliver(db, vapid, env.url, dateKey, slot, slotWindow(dateKey, slot), null, fetchImpl)) });
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

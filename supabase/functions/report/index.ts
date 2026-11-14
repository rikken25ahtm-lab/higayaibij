// ひがやいびん：朝10時・夕方17時の報告を、スマホの通知（Web Push）で送る。
// Supabase の Edge Function として動かす。外部のライブラリは使わない。
//
//   GET  …/report        通知の登録に使う公開鍵を返す（初回に鍵を作って保存する）
//   POST …/report        時刻の決まった報告。朝10時台・夕方17時台に、1回だけ全員へ送る
//   POST …/report  + ログイン中の Authorization   本人の端末だけに、今の内容をすぐ送る（お試し用）
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

// items（Supabase の行）→ 通知の { title, body }
export function buildReport(items, todayKey, slot) {
  const greeting = slot === 'evening' ? '夕方の報告' : slot === 'morning' ? '朝の報告' : '今の状況';
  const groups = { overdue: [], today: [], soon: [] };
  for (const item of items) {
    if (item.status !== 'open') continue;
    const level = dueLevel(item.due, todayKey);
    if (groups[level]) groups[level].push(item);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.due.localeCompare(b.due));

  const urgent = [...groups.overdue, ...groups.today, ...groups.soon];
  if (urgent.length === 0) {
    const open = items.filter((i) => i.status === 'open').length;
    return {
      title: `${greeting}：急ぎはありません`,
      body: open ? `残っているやることは ${open}件。期限が3日以内のものはありません。` : 'やることは残っていません。',
    };
  }

  const counts = [
    groups.overdue.length && `期限切れ${groups.overdue.length}`,
    groups.today.length && `今日${groups.today.length}`,
    groups.soon.length && `3日以内${groups.soon.length}`,
  ].filter(Boolean);

  const lines = urgent.slice(0, MAX_LINES).map((item) => {
    const level = dueLevel(item.due, todayKey);
    const when = level === 'overdue' ? `切れ ${shortDate(item.due)}` : level === 'today' ? '今日' : shortDate(item.due);
    const extra = [clip(item.assignee, 8), clip(item.progress, 8)].filter(Boolean).join('・');
    return `【${when}】${clip(item.content, 22)}${extra ? `（${extra}）` : ''}`;
  });
  if (urgent.length > MAX_LINES) lines.push(`ほか ${urgent.length - MAX_LINES}件`);

  return { title: `${greeting}：${counts.join('・')}`, body: lines.join('\n') };
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

// 登録されている端末へ送る。userId を渡すと、その人の端末だけ
async function deliver(db, vapid, subject, todayKey, slot, userId, fetchImpl) {
  const subs = await db.subscriptions(userId);
  const byUser = new Map();
  for (const sub of subs) byUser.set(sub.user_id, [...(byUser.get(sub.user_id) || []), sub]);

  let sent = 0;
  let failed = 0;
  for (const [uid, list] of byUser) {
    const report = buildReport(await db.openItems(uid), todayKey, slot);
    for (const sub of list) {
      let status = 0;
      try {
        status = await sendPush(sub, { ...report, tag: slot || 'now' }, vapid, subject, fetchImpl);
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

    // ログイン中の本人からの「今すぐ送る」
    const userId = token ? await db.userFromToken(token) : null;
    if (userId) return json({ mode: 'test', ...(await deliver(db, vapid, env.url, dateKey, null, userId, fetchImpl)) });

    // 時刻の決まった報告。朝10時台・夕方17時台だけ、各回1度だけ送る
    const slot = slotFor(hour);
    if (!slot) return json({ mode: 'schedule', skipped: 'time' });
    if (!(await db.claimSlot(`${dateKey}-${slot}`))) return json({ mode: 'schedule', skipped: 'already-sent' });
    return json({ mode: 'schedule', slot, ...(await deliver(db, vapid, env.url, dateKey, slot, null, fetchImpl)) });
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

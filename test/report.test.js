const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Edge Function は ES モジュールなので、import() で読み込む
const load = () => import('../supabase/functions/report/index.ts');

const TODAY = '2026-11-14';
const item = (content, due, more = {}) => ({ content, due, status: 'open', progress: '', assignee: '', ...more });

test('日本時間への変換と、報告の時間帯', async () => {
  const R = await load();
  assert.deepEqual(R.jstNow(new Date('2026-11-14T01:00:30Z')), { dateKey: '2026-11-14', hour: 10 });
  assert.deepEqual(R.jstNow(new Date('2026-11-14T15:30:00Z')), { dateKey: '2026-11-15', hour: 0 });
  assert.equal(R.slotFor(10), 'morning');
  assert.equal(R.slotFor(17), 'evening');
  assert.equal(R.slotFor(11), null);
});

test('報告：期限切れ・今日・3日以内を、期限の近い順に並べる', async () => {
  const R = await load();
  const report = R.buildReport([
    item('看板の発注', '2026-11-16', { assignee: '店長', progress: '返事待ち' }),
    item('保健所に連絡', '2026-11-14'),
    item('内装の見積もり', '2026-11-12', { progress: '途中' }),
    item('メニュー撮影', '2026-11-30'),
    item('期限なしの用件', null),
    item('済んだ用件', '2026-11-14', { status: 'done' }),
  ], TODAY, 'morning');
  assert.equal(report.title, '朝の報告：期限切れ1・今日1・3日以内1');
  assert.deepEqual(report.body.split('\n'), [
    '【切れ 11/12】内装の見積もり（途中）',
    '【今日】保健所に連絡',
    '【11/16】看板の発注（店長・返事待ち）',
  ]);
});

test('報告：急ぎがなければ1行で伝える', async () => {
  const R = await load();
  assert.deepEqual(R.buildReport([item('メニュー撮影', '2026-11-30')], TODAY, 'evening'), {
    title: '夕方の報告：急ぎはありません',
    body: '残っているやることは 1件。期限が3日以内のものはありません。',
  });
  assert.equal(R.buildReport([], TODAY, 'morning').body, 'やることは残っていません。');
});

test('報告：多いときは6件までにして、残りは件数で伝える', async () => {
  const R = await load();
  const many = Array.from({ length: 9 }, (_, i) => item(`用件${i}`, '2026-11-14'));
  const lines = R.buildReport(many, TODAY, 'morning').body.split('\n');
  assert.equal(lines.length, 7);
  assert.equal(lines[6], 'ほか 3件');
});

// 受け取る端末の側の手順（RFC 8291）で復号する
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

function fakeDevice() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    ua, authSecret,
    subscription: {
      endpoint: 'https://web.push.apple.com/abc123',
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: authSecret.toString('base64url'),
      user_id: 'user-1',
    },
  };
}

test('通知：端末の鍵で復号でき、署名も正しい', async () => {
  const R = await load();
  const device = fakeDevice();
  const vapid = await R.generateVapidKeys();
  let sentRequest;
  const status = await R.sendPush(device.subscription, { title: '朝の報告', body: '【今日】保健所に連絡' }, vapid,
    'https://example.supabase.co', async (url, init) => { sentRequest = { url, init }; return { status: 201 }; });

  assert.equal(status, 201);
  assert.equal(sentRequest.url, device.subscription.endpoint);
  assert.equal(sentRequest.init.headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(decrypt(Buffer.from(sentRequest.init.body), device.ua, device.authSecret)),
    { title: '朝の報告', body: '【今日】保健所に連絡' });

  const [, jwt, key] = sentRequest.init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = jwt.split('.');
  const publicKey = crypto.createPublicKey({ key: { ...vapid.privateJwk, d: undefined }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.sub, 'https://example.supabase.co');
});

// Supabase と通知の配信元の代わりをする、テスト用の fetch
function fakeBackend(device, items) {
  const state = { config: [], log: [], subs: [device.subscription], pushes: [], pushStatus: 201 };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url.startsWith('https://web.push.apple.com/')) {
      state.pushes.push(JSON.parse(decrypt(Buffer.from(init.body), device.ua, device.authSecret)));
      return { status: state.pushStatus };
    }
    const path = url.replace('https://example.supabase.co', '');
    if (path === '/auth/v1/user') {
      return init.headers.Authorization === 'Bearer good-token' ? reply({ id: 'user-1' }) : reply({}, 401);
    }
    if (path.startsWith('/rest/v1/push_config')) {
      if (method === 'POST') { if (!state.config.length) state.config.push(JSON.parse(init.body)); return reply(null, 201); }
      return reply(state.config.map((r) => ({ value: r.value })));
    }
    if (path.startsWith('/rest/v1/report_log')) {
      const row = JSON.parse(init.body);
      if (state.log.includes(row.slot)) return reply([], 201);
      state.log.push(row.slot);
      return reply([row], 201);
    }
    if (path.startsWith('/rest/v1/push_subscriptions')) {
      if (method === 'DELETE') { state.subs = []; return reply(null, 200); }
      return reply(state.subs);
    }
    if (path.startsWith('/rest/v1/items')) return reply(items);
    throw new Error(`想定外の通信: ${method} ${url}`);
  };
  return { state, fetchImpl };
}

const ENV = { url: 'https://example.supabase.co', serviceKey: 'service-key' };
const post = (headers = {}) => new Request('https://example.supabase.co/functions/v1/report', { method: 'POST', headers });

test('時刻の報告：朝10時台に1回だけ送り、ほかの時間には送らない', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), [item('保健所に連絡', '2026-11-14')]);

  const noon = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await noon.json(), { mode: 'schedule', skipped: 'time' });
  assert.equal(state.pushes.length, 0);

  const morning = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T01:00:05Z'));
  assert.deepEqual(await morning.json(), { mode: 'schedule', slot: 'morning', sent: 1, failed: 0 });
  assert.deepEqual(state.pushes, [{ title: '朝の報告：今日1', body: '【今日】保健所に連絡', tag: 'morning' }]);

  const again = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T01:20:00Z'));
  assert.deepEqual(await again.json(), { mode: 'schedule', skipped: 'already-sent' });
  assert.equal(state.pushes.length, 1);

  const evening = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T08:00:05Z'));
  assert.equal((await evening.json()).slot, 'evening');
  assert.equal(state.pushes[1].title, '夕方の報告：今日1');
});

test('お試し：ログイン中の本人には、時間に関係なくすぐ送る', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), []);
  const res = await R.handle(post({ Authorization: 'Bearer good-token' }), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await res.json(), { mode: 'test', sent: 1, failed: 0 });
  assert.equal(state.pushes[0].title, '今の状況：急ぎはありません');

  const stranger = await R.handle(post({ Authorization: 'Bearer wrong' }), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await stranger.json(), { mode: 'schedule', skipped: 'time' });
});

test('公開鍵は初回に作られ、2回目以降も同じ。無効になった端末の登録は消す', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), []);
  const get = () => R.handle(new Request('https://example.supabase.co/functions/v1/report'), ENV, fetchImpl);
  const first = (await (await get()).json()).publicKey;
  assert.equal(Buffer.from(first, 'base64url').length, 65);
  assert.equal((await (await get()).json()).publicKey, first);

  state.pushStatus = 410;
  const res = await R.handle(post({ Authorization: 'Bearer good-token' }), ENV, fetchImpl);
  assert.deepEqual(await res.json(), { mode: 'test', sent: 0, failed: 1 });
  assert.equal(state.subs.length, 0);
});

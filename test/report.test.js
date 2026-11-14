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

const ev = (item_id, kind, content, more = {}) => ({ item_id, kind, content, old_due: null, new_due: null, ...more });

test('報告の時間の範囲：朝は前日17時〜当日10時、夕方は当日10時〜17時（日本時間）', async () => {
  const R = await load();
  assert.deepEqual(R.slotWindow('2026-11-14', 'morning'),
    { start: new Date('2026-11-13T08:00:00Z'), end: new Date('2026-11-14T01:00:00Z') });
  assert.deepEqual(R.slotWindow('2026-11-14', 'evening'),
    { start: new Date('2026-11-14T01:00:00Z'), end: new Date('2026-11-14T08:00:00Z') });
  assert.deepEqual(R.currentWindow(new Date('2026-11-14T03:00:00Z')).start, new Date('2026-11-14T01:00:00Z'));
  assert.deepEqual(R.currentWindow(new Date('2026-11-14T00:30:00Z')).start, new Date('2026-11-13T08:00:00Z'));
  assert.deepEqual(R.currentWindow(new Date('2026-11-14T09:00:00Z')).start, new Date('2026-11-14T08:00:00Z'));
});

test('報告：その時間に起きたこと（追加・期限変更・完了・削除）と、期限の近い件数', async () => {
  const R = await load();
  const report = R.buildReport([
    ev('a', 'added', '看板の発注', { new_due: '2026-11-20' }),
    ev('b', 'due_changed', '内装の見積もり', { old_due: '2026-11-12', new_due: '2026-11-18' }),
    ev('c', 'done', '保健所に連絡'),
    ev('d', 'deleted', '古い用件'),
  ], [item('内装の見積もり', '2026-11-18'), item('酒屋に電話', '2026-11-14'), item('家賃の振込', '2026-11-10')], TODAY, 'morning');
  assert.equal(report.title, '朝の報告：追加1・期限変更1・完了1・削除1');
  assert.deepEqual(report.body.split('\n'), [
    '【追加】看板の発注（期限 11/20）',
    '【期限変更】内装の見積もり：11/12→11/18',
    '【完了】保健所に連絡',
    '【削除】古い用件',
    '本日まで：2件　翌日まで：2件　3日以内：2件',
  ]);
  assert.deepEqual(report.itemIds, ['a', 'b', 'c']);
});

test('報告：項目ごとに、結局どうなったかだけを伝える', async () => {
  const R = await load();
  const changes = R.summarizeEvents([
    ev('a', 'added', 'すぐ消した'), ev('a', 'deleted', 'すぐ消した'),
    ev('b', 'added', '追加して期限を直した', { new_due: '2026-11-20' }),
    ev('b', 'due_changed', '追加して期限を直した', { old_due: '2026-11-20', new_due: '2026-11-22' }),
    ev('c', 'due_changed', '2回変えた', { old_due: '2026-11-15', new_due: '2026-11-16' }),
    ev('c', 'due_changed', '2回変えた', { old_due: '2026-11-16', new_due: '2026-11-19' }),
    ev('d', 'done', '完了して戻した'), ev('d', 'reopened', '完了して戻した'),
    ev('e', 'deleted', '消して元に戻した'), ev('e', 'added', '消して元に戻した'),
    ev('f', 'due_changed', '変えて戻した', { old_due: '2026-11-15', new_due: '2026-11-16' }),
    ev('f', 'due_changed', '変えて戻した', { old_due: '2026-11-16', new_due: '2026-11-15' }),
  ]);
  assert.deepEqual(changes, [
    { itemId: 'b', content: '追加して期限を直した', kind: 'added', due: '2026-11-22' },
    { itemId: 'c', content: '2回変えた', kind: 'due_changed', from: '2026-11-15', to: '2026-11-19' },
  ]);
});

test('報告：動きがなければ、そう伝える', async () => {
  const R = await load();
  assert.deepEqual(R.buildReport([], [item('メニュー撮影', '2026-11-30')], TODAY, 'evening'),
    { title: '夕方の報告：動きはありません', body: '本日まで：0件　翌日まで：0件　3日以内：0件',
      lines: ['本日まで：0件　翌日まで：0件　3日以内：0件'], itemIds: [] });
  assert.equal(R.buildReport([], [item('メニュー撮影', '2026-11-30')], TODAY, 'morning').body, '本日まで：0件　翌日まで：0件　3日以内：0件');
  const withDeadline = R.buildReport([], [item('酒屋に電話', '2026-11-16')], TODAY, 'morning');
  assert.equal(withDeadline.body, '本日まで：0件　翌日まで：0件　3日以内：1件');
});

test('報告：期限は朝も夕方も「本日まで／翌日まで／3日以内」を、0件でも出す', async () => {
  const R = await load();
  const items = [item('切れ', '2026-11-10'), item('今日', '2026-11-14'), item('明日', '2026-11-15'),
    item('2日後', '2026-11-16'), item('3日後', '2026-11-17'), item('4日後', '2026-11-18'), item('期限なし', null)];
  assert.equal(R.buildReport([], items, TODAY, 'evening').body, '本日まで：2件　翌日まで：3件　3日以内：5件');
  assert.equal(R.buildReport([], items, TODAY, 'morning').body, '本日まで：2件　翌日まで：3件　3日以内：5件');
});

test('報告：多いときは通知を6件までにして、残りは件数で伝える（画面用は全部）', async () => {
  const R = await load();
  const many = Array.from({ length: 9 }, (_, i) => ev(`id${i}`, 'added', `用件${i}`));
  const report = R.buildReport(many, [], TODAY, 'morning');
  const lines = report.body.split('\n');
  assert.equal(lines.length, 8);
  assert.equal(lines[6], 'ほか 3件');
  assert.equal(lines[7], '本日まで：0件　翌日まで：0件　3日以内：0件');
  assert.equal(report.lines.length, 10);
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
function fakeBackend(device, items, events = [], mails = []) {
  const state = { config: [], log: [], subs: [device.subscription], pushes: [], pushStatus: 201, eventQueries: [], mailQueries: [] };
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
    if (path.startsWith('/rest/v1/item_events')) { state.eventQueries.push(path); return reply(events); }
    if (path.startsWith('/rest/v1/items')) return reply(items);
    if (path.startsWith('/rest/v1/mail_candidates')) {
      state.mailQueries.push(path);
      return mails === null ? reply({ message: 'relation does not exist' }, 404) : reply(mails);
    }
    throw new Error(`想定外の通信: ${method} ${url}`);
  };
  return { state, fetchImpl };
}

const ENV = { url: 'https://example.supabase.co', serviceKey: 'service-key' };
const post = (headers = {}, body = {}) => new Request('https://example.supabase.co/functions/v1/report', { method: 'POST', headers, body: JSON.stringify(body) });

test('時刻の報告：朝10時台に1回だけ送り、ほかの時間には送らない', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), [item('保健所に連絡', '2026-11-14')], [ev('a', 'added', '保健所に連絡', { new_due: '2026-11-14' })]);

  const noon = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await noon.json(), { mode: 'schedule', skipped: 'time' });
  assert.equal(state.pushes.length, 0);

  const morning = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T01:00:05Z'));
  assert.deepEqual(await morning.json(), { mode: 'schedule', slot: 'morning', sent: 1, failed: 0 });
  assert.deepEqual(state.pushes, [{
    title: '朝の報告：追加1', body: '【追加】保健所に連絡（期限 11/14）\n本日まで：1件　翌日まで：1件　3日以内：1件', tag: 'morning', view: '2026-11-14-morning',
  }]);
  assert.match(state.eventQueries[0], /user_id=eq\.user-1&at=gte\.2026-11-13T08:00:00\.000Z&at=lt\.2026-11-14T01:00:00\.000Z/);

  const again = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T01:20:00Z'));
  assert.deepEqual(await again.json(), { mode: 'schedule', skipped: 'already-sent' });
  assert.equal(state.pushes.length, 1);

  const evening = await R.handle(post(), ENV, fetchImpl, new Date('2026-11-14T08:00:05Z'));
  assert.equal((await evening.json()).slot, 'evening');
  assert.equal(state.pushes[1].view, '2026-11-14-evening');
  assert.match(state.eventQueries[1], /at=gte\.2026-11-14T01:00:00\.000Z&at=lt\.2026-11-14T08:00:00\.000Z/);
});

test('お試し：ログイン中の本人には、時間に関係なくすぐ送る', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), []);
  const res = await R.handle(post({ Authorization: 'Bearer good-token' }), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await res.json(), { mode: 'test', sent: 1, failed: 0 });
  assert.equal(state.pushes[0].title, '今の状況：動きはありません');
  assert.equal(state.pushes[0].view, 'now');

  const stranger = await R.handle(post({ Authorization: 'Bearer wrong' }), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await stranger.json(), { mode: 'schedule', skipped: 'time' });
});

test('通知から開いたページ用：その回の報告を返すだけで、送信はしない', async () => {
  const R = await load();
  const { state, fetchImpl } = fakeBackend(fakeDevice(), [], [ev('a', 'added', '看板の発注')]);
  const res = await R.handle(post({ Authorization: 'Bearer good-token' }, { view: '2026-11-13-evening' }), ENV, fetchImpl, new Date('2026-11-14T03:00:00Z'));
  assert.deepEqual(await res.json(), { mode: 'view', title: '夕方の報告：追加1', lines: ['【追加】看板の発注', '本日まで：0件　翌日まで：0件　3日以内：0件'], itemIds: ['a'] });
  assert.match(state.eventQueries[0], /at=gte\.2026-11-13T01:00:00\.000Z&at=lt\.2026-11-13T08:00:00\.000Z/);
  assert.equal(state.pushes.length, 0);
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

const mail = (sender, subject, attachments = []) => ({ sender, subject, attachments });

test('報告：届いたメールの要点（誰から・件名・添付の数）を加える', async () => {
  const R = await load();
  assert.equal(R.senderName('山田 太郎 <yamada@example.com>'), '山田 太郎');
  assert.equal(R.senderName('"山田工務店" <info@example.com>'), '山田工務店');
  assert.equal(R.senderName('<info@example.com>'), 'info@example.com');
  assert.equal(R.senderName('info@example.com'), 'info@example.com');

  const report = R.buildReport(
    [ev('a', 'added', '看板の発注')], [], TODAY, 'evening',
    [mail('山田工務店 <info@example.com>', '内装工事のお見積り', [{ name: '見積書.pdf', url: 'https://drive.google.com/file/d/1/view' }]), mail('info@example.com', '')]
  );
  assert.equal(report.title, '夕方の報告：追加1・メール2');
  assert.deepEqual(report.lines, [
    '【追加】看板の発注',
    '【メール】山田工務店：内装工事のお見積り（添付1）',
    '【メール】info@exampl…：（件名なし）',
    '本日まで：0件　翌日まで：0件　3日以内：0件',
  ]);
  assert.equal(R.buildReport([], [], TODAY, 'morning', [mail('a <a@example.com>', '件名')]).title, '朝の報告：メール1');
});

test('報告：メールは、その回の時間内に届いた候補だけを読む。連携の表がまだなくても報告は出る', async () => {
  const R = await load();
  const view = { view: '2026-11-13-evening' };
  const at = new Date('2026-11-14T03:00:00Z');

  const linked = fakeBackend(fakeDevice(), [], [], [mail('酒屋 <s@example.com>', '納品日のご連絡')]);
  const res = await R.handle(post({ Authorization: 'Bearer good-token' }, view), ENV, linked.fetchImpl, at);
  assert.deepEqual((await res.json()).lines, ['【メール】酒屋：納品日のご連絡', '本日まで：0件　翌日まで：0件　3日以内：0件']);
  assert.match(linked.state.mailQueries[0], /user_id=eq\.user-1&created_at=gte\.2026-11-13T01:00:00\.000Z&created_at=lt\.2026-11-13T08:00:00\.000Z/);

  const notYet = fakeBackend(fakeDevice(), [], [], null);
  const res2 = await R.handle(post({ Authorization: 'Bearer good-token' }, view), ENV, notYet.fetchImpl, at);
  assert.equal((await res2.json()).title, '夕方の報告：動きはありません');
});

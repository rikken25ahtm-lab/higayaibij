const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../logic.js');

test('差出人の名前と、件名から作る「内容」の下書き', () => {
  assert.equal(L.senderName('山田 太郎 <yamada@example.com>'), '山田 太郎');
  assert.equal(L.senderName('"山田工務店" <info@example.com>'), '山田工務店');
  assert.equal(L.senderName('info@example.com'), 'info@example.com');
  assert.equal(L.cleanSubject('Re: RE： Fwd: 内装工事の  お見積り'), '内装工事の お見積り');
  assert.equal(L.cleanSubject('Report の件'), 'Report の件');
  assert.equal(L.cleanSubject(null), '');
});

test('リンクは https だけを出し、同じリンクは重ねない', () => {
  const drive = { name: '請求書.pdf', url: 'https://drive.google.com/file/d/1/view' };
  assert.deepEqual(L.safeLinks([drive, { name: 'x', url: 'javascript:alert(1)' }, { name: 'y', url: 'http://example.com' }, null, { url: 'https://a.example/b' }]),
    [drive, { name: '添付', url: 'https://a.example/b' }]);
  assert.deepEqual(L.safeLinks('not a list'), []);
  assert.deepEqual(L.mergeLinks([drive], [drive, { name: '図面.pdf', url: 'https://drive.google.com/file/d/2/view' }]).map((l) => l.name), ['請求書.pdf', '図面.pdf']);
  assert.deepEqual(L.candidateLinks({ attachments: [drive], mailUrl: 'https://mail.google.com/mail/u/0/#all/abc' }).map((l) => [l.name, l.kind]),
    [['請求書.pdf', undefined], ['メールを開く', 'mail']]);
  assert.deepEqual(L.candidateLinks({ attachments: [], mailUrl: '' }), []);
});

// ---- Gmail の側のプログラム（google/mail.gs）を、Google のサービスの代わりを用意して動かす ----
function runScript({ known = [], token = 'good', failOn = null, label = 'ひがやいびん' } = {}) {
  const calls = [];
  const saved = [];
  const labels = [];
  const notified = [];
  let minutes = null;
  const props = { TOKEN: token };
  const message = (id, from, more = {}) => ({
    getId: () => id, getFrom: () => from, getSubject: () => `件名${id}`, getDate: () => new Date(more.date || '2026-11-14T01:00:00Z'),
    getPlainBody: () => '本文\r\n\r\n\r\n\r\n続き', isDraft: () => Boolean(more.draft), isInTrash: () => false,
    getAttachments: () => (more.files || []).map((name) => ({ getName: () => name, copyBlob: () => name })),
  });
  const threads = [
    { getPermalink: () => 'https://mail.google.com/mail/u/0/#all/t1', getMessages: () => [
      message('m2', '山田 <y@example.com>', { date: '2026-11-14T02:00:00Z', files: ['請求書.pdf'] }),
      message('m1', '山田 <y@example.com>', { date: '2026-11-13T02:00:00Z' }),
      message('mine', 'ダイ <dai@example.com>'),
      message('draft', '山田 <y@example.com>', { draft: true }),
    ] },
  ];
  const months = {};
  const monthFolder = (month) => ({ createFile: (blob) => {
    const file = { setName(name) { saved.push(`${month}/${name}`); return file; }, getUrl: () => `https://drive.google.com/file/d/${blob}/view` };
    return file;
  } });
  const folder = { getId: () => 'folder-1', isTrashed: () => false,
    getFoldersByName: (name) => ({ hasNext: () => Boolean(months[name]), next: () => months[name] }),
    createFolder: (name) => (months[name] = monthFolder(name)) };
  const context = {
    console: { log() {} },
    GmailApp: { getUserLabelByName: (name) => { labels.push(name); return { getThreads: () => threads }; }, createLabel() {} },
    DriveApp: { getFolderById: () => folder, createFolder: () => folder },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'dai@example.com' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (date, zone, format) => date.toISOString().slice(0, format.length) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: (n) => { minutes = n; return { create() {} }; } }) }) },
    UrlFetchApp: { fetch: (url, init) => {
      const body = JSON.parse(init.payload);
      const reply = (code, data) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(data) });
      if (url.endsWith('/functions/v1/report')) { notified.push(body); return reply(200, { mode: 'mail' }); }
      const name = url.split('/rpc/')[1];
      if (body.p_token !== 'good') return reply(403, { message: '合言葉が違います' });
      if (name === 'mail_settings') return reply(200, { label });
      calls.push([name, body]);
      if (name === 'mail_unknown') return reply(200, body.p_ids.filter((id) => !known.includes(id)));
      if (failOn && body.p_messages[0].id === failOn) return reply(500, { message: 'boom' });
      return reply(200, body.p_messages.length);
    } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google/mail.gs'), 'utf8') + '\nthis.run = run; this.setup = setup;', context);
  return { context, calls, saved, labels, notified, minutes: () => minutes };
}

test('Gmail の側：届けていないメールだけを、古い順に1通ずつ届ける。自分の返信と下書きは除く', () => {
  const { context, calls, saved, notified } = runScript();
  assert.equal(context.run(), 2);
  assert.deepEqual(calls[0], ['mail_unknown', { p_token: 'good', p_ids: ['m2', 'm1'] }]);
  const sent = calls.slice(1).map(([name, body]) => [name, body.p_messages[0]]);
  assert.deepEqual(sent.map(([name, m]) => [name, m.id]), [['receive_mail', 'm1'], ['receive_mail', 'm2']]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1][1])), {
    id: 'm2', sender: '山田 <y@example.com>', subject: '件名m2', excerpt: '本文\n\n続き',
    mail_url: 'https://mail.google.com/mail/u/0/#all/t1', received_at: '2026-11-14T02:00:00.000Z',
    attachments: [{ name: '請求書.pdf', url: 'https://drive.google.com/file/d/請求書.pdf/view' }],
  });
  // 添付は月ごとのフォルダに、「日付_差出人_もとの名前」で入る
  assert.deepEqual(saved, ['2026-11/2026-11-14_山田_請求書.pdf']);
  // 届けたら、緊急の確認を1回だけ頼む
  assert.deepEqual(notified, [{ mail_token: 'good' }]);
});

test('Gmail の側：見るラベルはページで決めた名前。確認は30分おき', () => {
  const custom = runScript({ label: '仕事のメール' });
  custom.context.setup();
  assert.ok(custom.labels.every((name) => name === '仕事のメール'));
  assert.equal(custom.minutes(), 30);
  assert.ok(runScript({ label: '' }).context.run() >= 0); // 名前が空なら「ひがやいびん」を見る
});

test('Gmail の側：届け済みのメールの添付は、ドライブに保存し直さない', () => {
  const { context, calls, saved, notified } = runScript({ known: ['m1', 'm2'] });
  assert.equal(context.run(), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(saved, []);
  assert.deepEqual(notified, []); // 新しいメールがなければ、知らせない
});

test('Gmail の側：合言葉が違うときは、直し方を伝えて止まる', () => {
  assert.throws(() => runScript({ token: 'bad' }).context.setup(), /合言葉が違います。ページの「メールの連携」で作り直して/);
  assert.throws(() => runScript({ token: '' }).context.run(), /合言葉がまだ入っていません/);
});

test('振り分け先の提案：同じ件名の項目 → 同じ差出人の前の行き先 → 似た言葉', () => {
  const items = [
    { id: 'i1', projectId: 'p-work', category: '① 物件', content: '内装工事の見積もりを比べる', action: '', status: 'open',
      attachments: [{ name: 'メールを開く', kind: 'mail', url: 'https://mail.google.com/x', subject: '内装工事のお見積り' }] },
    { id: 'i2', projectId: 'p-home', category: '', content: '家賃を振り込む', action: '', status: 'open', attachments: [] },
    { id: 'i3', projectId: 'p-work', category: '② 手続き', content: '保健所へ営業許可の書類を出す', action: '', status: 'open', attachments: [] },
  ];
  const history = [{ sender: '大家 <Ooya@Example.com>', itemId: 'i2' }, { sender: 'x <gone@example.com>', itemId: 'deleted' }];
  const s = (mail) => L.suggestPlace({ excerpt: '', ...mail }, history, items);

  // 同じ件名のやりとり：その項目に足す
  assert.deepEqual(s({ sender: '山田 <y@example.com>', subject: 'Re: 内装工事のお見積り' }),
    { projectId: 'p-work', category: '① 物件', itemId: 'i1', reason: '同じ件名のやりとりが、この項目についています' });
  // 同じ差出人：前に入れたところ（項目には足さない）
  assert.deepEqual(s({ sender: '"大家" <ooya@example.com>', subject: '更新のお知らせ' }),
    { projectId: 'p-home', category: '', reason: '同じ差出人のメールを、前にここへ入れました' });
  // 似た言葉が2つ以上
  const byWords = s({ sender: '保健所 <h@example.com>', subject: '営業許可の申請について', excerpt: '保健所の窓口へお越しください' });
  assert.deepEqual([byWords.projectId, byWords.category, byWords.itemId], ['p-work', '② 手続き', undefined]);
  // 手がかりがなければ、提案しない
  assert.equal(s({ sender: '知らない人 <n@example.com>', subject: 'はじめまして' }), null);
  assert.equal(s({ sender: 'x <gone@example.com>', subject: 'こんにちは' }), null); // 行き先の項目が、もうない
  assert.equal(L.senderAddress('山田 <Yamada@Example.com>'), 'yamada@example.com');
});

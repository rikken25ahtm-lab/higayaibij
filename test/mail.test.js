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
function runScript({ known = [], token = 'good', failOn = null } = {}) {
  const calls = [];
  const saved = [];
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
  const folder = { getId: () => 'folder-1', isTrashed: () => false, createFile: (blob) => {
    const file = { setName(name) { saved.push(name); return file; }, getUrl: () => `https://drive.google.com/file/d/${blob}/view` };
    return file;
  } };
  const context = {
    console: { log() {} },
    GmailApp: { getUserLabelByName: () => ({ getThreads: () => threads }), createLabel() {} },
    DriveApp: { getFolderById: () => folder, createFolder: () => folder },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'dai@example.com' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (date) => date.toISOString().slice(0, 10) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
    UrlFetchApp: { fetch: (url, init) => {
      const name = url.split('/rpc/')[1];
      const body = JSON.parse(init.payload);
      calls.push([name, body]);
      const reply = (code, data) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(data) });
      if (body.p_token !== 'good') return reply(403, { message: '合言葉が違います' });
      if (name === 'mail_unknown') return reply(200, body.p_ids.filter((id) => !known.includes(id)));
      if (failOn && body.p_messages[0].id === failOn) return reply(500, { message: 'boom' });
      return reply(200, body.p_messages.length);
    } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../google/mail.gs'), 'utf8') + '\nthis.run = run; this.setup = setup;', context);
  return { context, calls, saved };
}

test('Gmail の側：届けていないメールだけを、古い順に1通ずつ届ける。自分の返信と下書きは除く', () => {
  const { context, calls, saved } = runScript();
  assert.equal(context.run(), 2);
  assert.deepEqual(calls[0], ['mail_unknown', { p_token: 'good', p_ids: ['m2', 'm1'] }]);
  const sent = calls.slice(1).map(([name, body]) => [name, body.p_messages[0]]);
  assert.deepEqual(sent.map(([name, m]) => [name, m.id]), [['receive_mail', 'm1'], ['receive_mail', 'm2']]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1][1])), {
    id: 'm2', sender: '山田 <y@example.com>', subject: '件名m2', excerpt: '本文\n\n続き',
    mail_url: 'https://mail.google.com/mail/u/0/#all/t1', received_at: '2026-11-14T02:00:00.000Z',
    attachments: [{ name: '請求書.pdf', url: 'https://drive.google.com/file/d/請求書.pdf/view' }],
  });
  assert.deepEqual(saved, ['2026-11-14 請求書.pdf']);
});

test('Gmail の側：届け済みのメールの添付は、ドライブに保存し直さない', () => {
  const { context, calls, saved } = runScript({ known: ['m1', 'm2'] });
  assert.equal(context.run(), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(saved, []);
});

test('Gmail の側：合言葉が違うときは、直し方を伝えて止まる', () => {
  assert.throws(() => runScript({ token: 'bad' }).context.setup(), /合言葉が違います。ページの「メールの連携」で作り直して/);
  assert.throws(() => runScript({ token: '' }).context.run(), /合言葉がまだ入っていません/);
});

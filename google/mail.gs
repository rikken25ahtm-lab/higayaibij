// ひがやいびん：Gmail のメールを「候補」として届け、添付を Google ドライブに保存する。
// Google Apps Script（https://script.google.com）に貼り付けて使う。設定の手順は README にあります。
//
// やること（15分おきに自動で動く）
//   1. Gmail でラベル「2号店」がついたメールを見る
//   2. まだ届けていないメールがあれば、添付をドライブのフォルダ「ひがやいびん 添付」に保存する
//   3. 差出人・件名・本文の最初の部分・添付のリンクを、ひがやいびんに「候補」として届ける
//
// やらないこと
//   ・メールの送信、削除、既読への変更はしない（読むだけ）
//   ・ラベルのついていないメールは見ない
//   ・やることへの追加はしない（ページで確認してから、ダイくんが追加する）

// ---- 設定（公開してよい値だけ。合言葉はここに書かず、「スクリプト プロパティ」に入れる） ----
const SUPABASE_URL = 'https://ngddtyyxfcmfzpjqcaco.supabase.co';
const SUPABASE_KEY = 'sb_publishable_A0jk5-oz5dTF0-URK1aRlA_lpUe3vL0';
const LABEL = '2号店';                  // このラベルがついたメールだけを見る
const FOLDER_NAME = 'ひがやいびん 添付'; // 添付の保存先（ドライブの中に自動で作る）
const MAX_THREADS = 30;                  // 1回に見る会話の数（新しい順）
const MAX_PER_RUN = 10;                  // 1回に届けるメールの数（残りは次の回に届ける）
const EXCERPT_LENGTH = 1500;             // 届ける本文の長さ（文字）

// 最初に1回だけ、手で実行する。ラベルとフォルダを作り、15分おきの予約を入れる。
function setup() {
  if (!GmailApp.getUserLabelByName(LABEL)) GmailApp.createLabel(LABEL);
  folder_();
  call_('mail_unknown', { p_ids: [] }); // 合言葉が正しいか、ここで確かめる

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'run')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(15).create();

  const sent = run();
  console.log('設定できました。ラベル「' + LABEL + '」のメールを15分おきに確認します。今回届けたメール：' + sent + '件');
}

// 連携をやめるとき：15分おきの予約を消す（保存済みの添付とラベルは残る）
function stop() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  console.log('自動の確認を止めました。');
}

// 15分おきに動く本体。届けた件数を返す
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 0; // 前の回がまだ動いている
  try {
    const label = GmailApp.getUserLabelByName(LABEL);
    if (!label) return 0;

    const me = Session.getEffectiveUser().getEmail().toLowerCase();
    const messages = [];
    label.getThreads(0, MAX_THREADS).forEach((thread) => {
      thread.getMessages().forEach((message) => {
        if (message.isDraft() || message.isInTrash()) return;
        if (me && message.getFrom().toLowerCase().indexOf(me) !== -1) return; // 自分が送った返信は候補にしない
        messages.push({ thread: thread, message: message });
      });
    });
    if (!messages.length) {
      call_('mail_unknown', { p_ids: [] }); // 「確認した」ことだけ伝える（ページに最後の確認時刻が出る）
      return 0;
    }

    const unknown = call_('mail_unknown', { p_ids: messages.map((m) => m.message.getId()) });
    const todo = messages
      .filter((m) => unknown.indexOf(m.message.getId()) !== -1)
      .sort((a, b) => a.message.getDate() - b.message.getDate()) // 古いものから順に届ける
      .slice(0, MAX_PER_RUN);

    let sent = 0;
    todo.forEach((m) => {
      // 1通ずつ届ける。途中で失敗しても、届け終わったメールの添付を次の回に保存し直さない
      sent += call_('receive_mail', { p_messages: [describe_(m.thread, m.message)] });
    });
    return sent;
  } finally {
    lock.releaseLock();
  }
}

// 1通のメール → 届ける内容。添付はここでドライブに保存する
function describe_(thread, message) {
  const day = Utilities.formatDate(message.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const attachments = message
    .getAttachments({ includeInlineImages: false, includeAttachments: true })
    .slice(0, 20)
    .map((file) => {
      const saved = folder_().createFile(file.copyBlob()).setName(day + ' ' + file.getName());
      return { name: file.getName(), url: saved.getUrl() };
    });

  return {
    id: message.getId(),
    sender: message.getFrom(),
    subject: message.getSubject(),
    excerpt: message.getPlainBody().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, EXCERPT_LENGTH),
    mail_url: thread.getPermalink(),
    received_at: message.getDate().toISOString(),
    attachments: attachments,
  };
}

// 添付の保存先。初回に作って、場所を覚えておく（あとでフォルダの名前を変えても大丈夫）。
// 作ったフォルダは、ダイくん本人だけが見られる状態になる。
function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      const found = DriveApp.getFolderById(id);
      if (!found.isTrashed()) return found;
    } catch (e) {
      // フォルダが消されていたら、作り直す
    }
  }
  const created = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', created.getId());
  return created;
}

// ひがやいびん（Supabase）の受け取り口を呼ぶ
function call_(name, body) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token) {
    throw new Error('合言葉がまだ入っていません。「プロジェクトの設定」→「スクリプト プロパティ」に、名前 TOKEN で入れてください。');
  }
  const payload = Object.assign({ p_token: token.trim() }, body);
  const response = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    if (text.indexOf('合言葉が違います') !== -1) {
      throw new Error('合言葉が違います。ページの「メールの連携」で作り直して、スクリプト プロパティの TOKEN を入れ替えてください。');
    }
    throw new Error('ひがやいびんに届けられませんでした（' + code + '）：' + text.slice(0, 200));
  }
  return JSON.parse(text);
}

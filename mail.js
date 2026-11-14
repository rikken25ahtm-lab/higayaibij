// メールの連携の設定（Supabase を使うときだけ）。
// ここでやるのは「合言葉」を作ることだけ。メールを読むのは Gmail の側のプログラム（google/mail.gs）。
(function (root) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const HOUR_MS = 60 * 60 * 1000;

  root.MailLink = {
    async init(Store, showToast) {
      if (!Store.remote) return;
      const box = $('maillink');
      const status = $('maillink-status');
      const createButton = $('maillink-create');
      const offButton = $('maillink-off');
      const tokenBox = $('maillink-token-box');
      const tokenInput = $('maillink-token');
      const openLink = $('maillink-open');
      const { mailTime } = root.Logic;

      async function refresh() {
        const link = await Store.mailLink();
        createButton.hidden = !link;
        offButton.hidden = !(link && link.linked);
        createButton.textContent = link && link.linked ? '合言葉を作り直す' : '合言葉を作る';
        if (!link) {
          status.textContent = 'まだ準備ができていません。先に、README の「メールとドライブの連携」の手順1（SQL の実行）を行ってください。';
        } else if (!link.linked) {
          status.textContent = 'Gmail でラベル「2号店」をつけたメールを、やることの候補として受け取れます。添付はドライブに保存され、リンクがつきます。まず合言葉を作り、README の手順で Gmail の側に入れてください。';
        } else if (!link.lastSeenAt) {
          status.textContent = '合言葉は作成済みです。Gmail の側からの確認は、まだ来ていません（README の手順で、Apps Script の setup を実行してください）。';
        } else if (Date.now() - new Date(link.lastSeenAt).getTime() > HOUR_MS) {
          status.textContent = `1時間以上、Gmail の側からの確認が来ていません（最後の確認：${mailTime(link.lastSeenAt)}）。Apps Script の予約が止まっていないか確認してください。`;
        } else {
          status.textContent = `連携しています。15分おきにメールを確認します（最後の確認：${mailTime(link.lastSeenAt)}）。`;
        }
      }

      async function guarded(button, work) {
        button.disabled = true;
        try {
          await work();
        } catch (error) {
          console.error(error);
          showToast('メールの連携の設定がうまくいきませんでした。通信を確認して、もう一度試してください。', null);
        } finally {
          button.disabled = false;
        }
      }

      openLink.hidden = false;
      openLink.addEventListener('click', async () => {
        const open = box.hidden;
        box.hidden = !open;
        openLink.setAttribute('aria-expanded', String(open));
        if (!open) {
          // 閉じたら、合言葉を画面に残さない
          tokenBox.hidden = true;
          tokenInput.value = '';
          return;
        }
        box.scrollIntoView({ block: 'nearest' });
        await guarded(createButton, refresh);
      });

      createButton.addEventListener('click', () => guarded(createButton, async () => {
        const link = await Store.mailLink();
        if (link && link.linked && !confirm('合言葉を作り直すと、いまの合言葉は使えなくなります。Apps Script の TOKEN も入れ替えが必要です。作り直しますか？')) return;
        tokenInput.value = await Store.createMailToken();
        tokenBox.hidden = false;
        await refresh();
      }));

      $('maillink-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(tokenInput.value);
          showToast('合言葉をコピーしました', null);
        } catch (err) {
          tokenInput.focus();
          tokenInput.select();
          showToast('合言葉を選択しました。そのままコピーしてください。', null);
        }
      });

      offButton.addEventListener('click', () => guarded(offButton, async () => {
        if (!confirm('メールの連携をやめますか？（これまでに届いた候補と、ドライブに保存した添付は残ります。Apps Script の側でも stop を実行してください）')) return;
        await Store.removeMailLink();
        tokenBox.hidden = true;
        tokenInput.value = '';
        showToast('メールの連携をやめました。', null);
        await refresh();
      }));
    },
  };
})(window);

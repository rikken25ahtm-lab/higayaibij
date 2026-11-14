// 朝10時・夕方17時の報告を、この端末の通知で受け取るための設定（Supabase を使うときだけ）。
(function (root) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function keyBytes(base64url) {
    const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  }

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isInstalled = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const supported = 'serviceWorker' in navigator && 'PushManager' in root && 'Notification' in root;

  root.Notify = {
    async init(Store, showToast, markItems) {
      const box = $('notify');
      const status = $('notify-status');
      const onButton = $('notify-on');
      const testButton = $('notify-test');
      const offButton = $('notify-off');
      const openLink = $('notify-open');
      if (!Store.remote) return;

      let registration = null;
      let openedByHand = false;

      // 欄を大きく出すのは、まだ選んでいないとき（needsChoice）だけ。
      // 選び終わったあとは畳んで、一番下の「通知の設定」から開けるようにする。
      function show(text, state, needsChoice = state === 'off') {
        status.textContent = text;
        onButton.hidden = state !== 'off';
        testButton.hidden = state !== 'on';
        offButton.hidden = state !== 'on';
        if (needsChoice) openedByHand = false;
        box.hidden = !needsChoice && !openedByHand;
        openLink.hidden = needsChoice;
        openLink.setAttribute('aria-expanded', String(!box.hidden));
      }

      openLink.addEventListener('click', () => {
        openedByHand = box.hidden;
        box.hidden = !openedByHand;
        openLink.setAttribute('aria-expanded', String(openedByHand));
        if (openedByHand) box.scrollIntoView({ block: 'nearest' });
      });

      async function refresh() {
        if (!supported) {
          return isIOS && !isInstalled
            ? show('iPhone では、Safari の共有ボタンから「ホーム画面に追加」を選び、ホーム画面のアイコンから開くと通知を受け取れます。', 'none', true)
            : show('このブラウザは通知に対応していません。', 'none');
        }
        if (Notification.permission === 'denied') {
          return show(isIOS
            ? '通知が許可されていません。iPhone の「設定」→「通知」→「ひがやいびん」で許可してください。'
            : '通知が許可されていません。アドレスバーの左にある印（鍵やつまみの形）を押し、「通知」を「許可」に変えてから、ページを読み込み直してください。', 'none');
        }
        registration = registration || await navigator.serviceWorker.register('sw.js');
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          await Store.savePushSubscription(sub.toJSON()); // ログインし直したあとも登録が残るように
          show('この端末で、毎日 朝10時と夕方17時に報告を受け取ります。', 'on');
        } else {
          show('毎日 朝10時と夕方17時に、その間に起きたこと（追加・期限の変更など）を通知でお知らせします。', 'off');
        }
      }

      async function guarded(button, work) {
        button.disabled = true;
        try {
          await work();
        } catch (error) {
          console.error(error);
          showToast('通知の設定がうまくいきませんでした。通信を確認して、もう一度試してください。', null);
        } finally {
          button.disabled = false;
        }
      }

      // 許可の確認は、ボタンを押した直後に出す必要がある（iPhone の決まり）
      onButton.addEventListener('click', () => guarded(onButton, async () => {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          await navigator.serviceWorker.ready;
          const sub = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(await Store.pushPublicKey()),
          });
          await Store.savePushSubscription(sub.toJSON());
          showToast('通知を受け取るようにしました。', null);
        }
        await refresh();
      }));

      testButton.addEventListener('click', () => guarded(testButton, async () => {
        const result = await Store.sendTestReport();
        showToast(result.sent > 0 ? '送りました。数秒で通知が届きます。' : '送れませんでした。「通知をやめる」→「通知を受け取る」でやり直してください。', null);
        if (!result.sent) await refresh();
      }));

      async function turnOff() {
        const sub = registration && await registration.pushManager.getSubscription();
        if (!sub) return;
        await Store.removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }

      offButton.addEventListener('click', () => guarded(offButton, async () => {
        await turnOff();
        showToast('通知をやめました。', null);
        await refresh();
      }));

      // ---- 通知を押して開いたとき：その回の報告を、ページの一番上に出す ----
      async function openReport(view) {
        if (!/^(now|\d{4}-\d{2}-\d{2}-(morning|evening))$/.test(view)) return;
        try {
          const report = await Store.viewReport(view);
          $('report-title').textContent = report.title;
          $('report-lines').replaceChildren(...report.lines.map((line) => {
            const li = document.createElement('li');
            li.textContent = line;
            return li;
          }));
          $('report').hidden = false;
          await markItems(report.itemIds);
          $('report').scrollIntoView({ block: 'start' });
        } catch (error) {
          console.error(error);
          showToast('報告を読み込めませんでした。通信を確認してください。', null);
        }
      }

      function openReportFromHash() {
        const match = location.hash.match(/^#report=(.+)$/);
        if (!match) return;
        history.replaceState(null, '', location.pathname + location.search); // 開き直すたびに出ないように
        openReport(match[1]);
      }

      $('report-close').addEventListener('click', () => {
        $('report').hidden = true;
        markItems([]);
      });
      root.addEventListener('hashchange', openReportFromHash);
      if (supported) {
        // すでに開いているページには、通知の側から知らせが来る
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.report) openReport(event.data.report);
        });
      }
      openReportFromHash();

      // ログアウトした端末には報告を送らない
      this.beforeSignOut = () => turnOff().catch((error) => console.error(error));

      // アカウントを切り替えるとき：いまのアカウントからこの端末の登録を外す。
      // 端末の通知の許可はそのままなので、切り替えた先のアカウントで自動的に登録し直される
      this.beforeSwitch = async () => {
        try {
          const sub = registration && await registration.pushManager.getSubscription();
          if (sub) await Store.removePushSubscription(sub.endpoint);
        } catch (error) {
          console.error(error);
        }
      };

      try {
        await refresh();
      } catch (error) {
        console.error(error);
        show('通知の状態を確認できませんでした。ページを開き直してください。', 'none');
      }
    },

    beforeSignOut: async () => {},
    beforeSwitch: async () => {},
  };
})(window);

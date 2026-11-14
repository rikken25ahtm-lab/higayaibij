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
    async init(Store, showToast) {
      const box = $('notify');
      const status = $('notify-status');
      const onButton = $('notify-on');
      const testButton = $('notify-test');
      const offButton = $('notify-off');
      if (!Store.remote) return;
      box.hidden = false;

      let registration = null;

      function show(text, state) {
        status.textContent = text;
        onButton.hidden = state !== 'off';
        testButton.hidden = state !== 'on';
        offButton.hidden = state !== 'on';
      }

      async function refresh() {
        if (!supported) {
          return show(isIOS && !isInstalled
            ? 'iPhone では、Safari の共有ボタンから「ホーム画面に追加」を選び、ホーム画面のアイコンから開くと通知を受け取れます。'
            : 'このブラウザは通知に対応していません。', 'none');
        }
        if (Notification.permission === 'denied') {
          return show('通知が許可されていません。端末の「設定」→「通知」→「ひがやいびん」で許可してください。', 'none');
        }
        registration = registration || await navigator.serviceWorker.register('sw.js');
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          await Store.savePushSubscription(sub.toJSON()); // ログインし直したあとも登録が残るように
          show('この端末で、毎日 朝10時と夕方17時に報告を受け取ります。', 'on');
        } else {
          show('毎日 朝10時と夕方17時に、期限の近いやることを通知でお知らせします。', 'off');
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

      // ログアウトした端末には報告を送らない
      this.beforeSignOut = () => turnOff().catch((error) => console.error(error));

      try {
        await refresh();
      } catch (error) {
        console.error(error);
        show('通知の状態を確認できませんでした。ページを開き直してください。', 'none');
      }
    },

    beforeSignOut: async () => {},
  };
})(window);

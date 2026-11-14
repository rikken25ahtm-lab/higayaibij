// 通知を受け取って表示する（ページを閉じていても動く部分）。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch (_) { /* 読めなければ既定の文面で出す */ }
  event.waitUntil(self.registration.showNotification(message.title || 'ひがやいびん', {
    body: message.body || 'やることを確認してください。',
    tag: message.tag || 'report', // 同じ回の通知が重なったら、新しいほうに置き換える
    icon: 'icons/icon-192.png',
    data: { view: message.view || 'now' }, // どの回の報告か
  }));
});

// 通知を押したら、ひがやいびんを開いて、その回の報告を出す（開いていれば、それを前に出す）
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const view = (event.notification.data && event.notification.data.view) || 'now';
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (pages.length) {
      pages[0].postMessage({ report: view });
      return pages[0].focus();
    }
    return self.clients.openWindow(`${self.registration.scope}#report=${view}`);
  })());
});

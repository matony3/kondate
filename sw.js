// 献立アプリは https://stock.yurukichi.com/meal/ に移転しました。
// 以前のオフライン用キャッシュが古い画面を出し続けないよう、このサービスワーカーはキャッシュを消して自分の登録を外す。
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url);
  })());
});

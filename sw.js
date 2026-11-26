// Shows race alerts (see alerts.js). It only handles notifications: it doesn't
// store pages, so the site always loads fresh.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data && e.data.text() }; }
  const title = msg.title || 'Mountain Biking SA';
  e.waitUntil(self.registration.showNotification(title, {
    body: msg.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: msg.tag || undefined,
    data: { url: msg.url || '/calendar' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/calendar', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url === url && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});

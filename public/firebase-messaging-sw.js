/* global clients */
self.addEventListener('push', (event) => {
  const payload = event.data?.json() || {};
  const data = payload.data || payload.notification || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'PrediLeague', {
      body: data.body || '',
      icon: '/brand-mark.svg',
      badge: '/brand-mark.svg',
      data: { link: data.link || '/#game' }
    })
  );
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.showNotification('PrediLeague', {
      body: 'Open PrediLeague to renew match notifications.',
      icon: '/brand-mark.svg',
      badge: '/brand-mark.svg',
      data: { link: '/#profile' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/#game';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(link);
          return client.focus();
        }
      }
      return clients.openWindow(link);
    })
  );
});

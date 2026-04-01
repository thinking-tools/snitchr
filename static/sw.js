/* snitchr service worker — handles Web Push notifications */
/* v1 */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'snitchr', body: event.data.text() };
  }

  const title = data.title || 'snitchr';
  const options = {
    body: data.body || '',
    icon: '/static/web-app-manifest-192x192.png',
    badge: '/static/web-app-manifest-192x192.png',
    tag: data.tag || 'snitchr-alert',
    data: { url: data.url || '/' },
    requireInteraction: data.priority === 'urgent' || data.priority === 'high',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

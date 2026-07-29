/* Wassel service worker — PUSH NOTIFICATIONS ONLY.
 *
 * THIS WORKER DELIBERATELY DOES NOT CACHE ANYTHING AND HAS NO `fetch`
 * HANDLER. Do not add one.
 *
 * A service worker that intercepts fetch becomes a second caching layer in
 * front of Vercel's, and this app has already lost a production morning to
 * exactly that failure mode: `index.html` was cached against hashed
 * `/assets/*.js` filenames that no longer existed, and every user got a blank
 * page that a normal reload could not fix (commit a910f10). A stale service
 * worker is strictly worse, because it survives reloads and there is no
 * "clear cache" a rep on an iPhone can reasonably be talked through.
 *
 * The app already solves freshness properly: `__BUILD_VERSION__` is compared
 * against /api/version by the in-app poller, which prompts the user to reload
 * (see src/hooks/useAppVersionPoller.ts + src/components/UpdateBanner.tsx).
 * Offline support, if it is ever wanted, is a separate decision with its own
 * invalidation design — not something to bolt onto the push worker.
 *
 * The ONLY reason this file exists: iOS cannot show a notification without a
 * service worker. `new Notification(...)` is unsupported on iOS entirely; the
 * only route is ServiceWorkerRegistration.showNotification, which must be
 * called from here.
 */

// Take over immediately so a freshly-installed worker can receive pushes
// without the rep having to close and reopen the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // iOS revokes push permission from apps that receive a push and show
  // nothing, so every branch below MUST end in showNotification — including
  // the malformed-payload path.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push whose body isn't JSON is a bug on our side, but silently showing
    // nothing would cost us the permission. Fall through to the defaults.
    payload = {};
  }

  const title = payload.title || 'وصل العقارية';
  const options = {
    body: payload.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    // Same tag replaces an earlier notification for the same follow-up rather
    // than stacking three copies of "customer replied" for one conversation.
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' },
    dir: 'rtl',
    lang: 'ar',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Reuse an already-open window when there is one. Opening a second
      // window would leave the rep with two copies of the app and lose
      // whatever they had on screen.
      for (const client of all) {
        if ('focus' in client) {
          await client.focus();
          // Navigate via the SPA router rather than client.navigate(), which
          // would force a full reload and drop in-memory state.
          client.postMessage({ type: 'navigate', url: target });
          return;
        }
      }

      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

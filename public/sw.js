// The Diagram — service worker for Web Push (Phase 2 notifications).
// Deliberately minimal: no offline caching (this is a live, server-backed app), ONLY push.
//
// iOS reliability rule (the "3-strike" trap): Safari REVOKES the push subscription after 3
// pushes whose handler doesn't visibly show a notification. So every 'push' MUST resolve a
// showNotification() inside event.waitUntil(). Never a silent push.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data && event.data.text() } }
  const title = data.title || 'The Diagram'
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,          // same tag replaces an earlier notification instead of stacking
    renotify: !!data.tag,
    data: { url: data.url || '/', ...(data.data || {}) },
    requireInteraction: !!data.requireInteraction,
  }
  // ALWAYS show something — the userVisibleOnly contract Safari enforces.
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Focus an existing tab if one is open; otherwise open a new one.
    for (const c of all) {
      if ('focus' in c) { try { await c.focus() } catch { /* ignore */ } ; if ('navigate' in c && url !== '/') { try { await c.navigate(url) } catch { /* ignore */ } } return }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})

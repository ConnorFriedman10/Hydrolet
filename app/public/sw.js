// Service worker: receives Web Push messages from the send-push Edge Function
// and shows them, even when the app is closed.
//
// Payload (JSON): { title, body, url, tag }. `url` is opened on tap; `tag`
// lets a newer notification of the same kind replace the older one.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Hydrolet'
  // iOS revokes the subscription if a push arrives and no notification is
  // shown, so always show one, even for an empty or malformed payload.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Reuse an open app window rather than stacking new ones.
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        try {
          await client.focus()
          // navigate() only works on windows this worker controls.
          return await client.navigate(target)
        } catch {
          break
        }
      }
    }
    return self.clients.openWindow(target)
  })())
})

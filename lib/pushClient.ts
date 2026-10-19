// Web Push — client side. Registers the service worker, subscribes the device (on a user
// gesture — iOS requires it), and re-subscribes on every app open (iOS drops subscriptions).
// Browser-only; import into a client component. Everything self-catching + feature-detected so
// a non-supporting browser just reports 'unsupported' instead of throwing.

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  // Allocate over a plain ArrayBuffer so the view is ArrayBuffer-backed (applicationServerKey
  // rejects a possibly-SharedArrayBuffer-backed Uint8Array under strict lib types).
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function notifPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported'
  return Notification.permission
}

// Whether the app is running as an installed PWA (iOS requires this for push to work at all).
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return window.matchMedia?.('(display-mode: standalone)').matches || (window.navigator as any).standalone === true
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null
  try { return await navigator.serviceWorker.register('/sw.js') } catch { return null }
}

async function subscribeAndSync(reg: ServiceWorkerRegistration, label: string): Promise<boolean> {
  if (!VAPID_PUBLIC) return false
  try {
    let sub = await reg.pushManager.getSubscription()
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) })
    const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), label }) })
    return res.ok
  } catch { return false }
}

// Called from a user gesture (a button). Requests permission, subscribes, syncs to the server.
export async function enableNotifications(label = 'device'): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'This browser does not support notifications.' }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, reason: perm === 'denied' ? 'Notifications are blocked in your browser settings.' : 'Permission was not granted.' }
  const reg = await registerSW()
  if (!reg) return { ok: false, reason: 'Could not register the notification worker.' }
  await navigator.serviceWorker.ready
  const ok = await subscribeAndSync(reg, label)
  return ok ? { ok: true } : { ok: false, reason: 'Subscription failed (missing key or push service unreachable).' }
}

// Silent refresh on app open — only if already granted. Keeps the endpoint alive across iOS's
// spontaneous subscription drops.
export async function refreshSubscription(label = 'device'): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return
  const reg = await registerSW()
  if (!reg) return
  try { await navigator.serviceWorker.ready; await subscribeAndSync(reg, label) } catch { /* ignore */ }
}

export async function disableNotifications(): Promise<void> {
  if (!pushSupported()) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
      await sub.unsubscribe().catch(() => {})
    }
  } catch { /* ignore */ }
}

// Fire a test push to THIS device (uses its own endpoint so only this phone buzzes).
export async function sendTestPush(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    const res = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub?.endpoint }) })
    const data = await res.json()
    if (data.sent > 0) return { ok: true }
    return { ok: false, reason: data.configured ? 'No delivery — the subscription may have expired. Try Enable again.' : 'Push is not configured on the server (VAPID keys).' }
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : 'failed' } }
}

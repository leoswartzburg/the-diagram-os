// Web Push — server side. Sends notifications to subscribed devices via VAPID + the browser's
// push service (Apple's web.push.apple.com for iOS). Fully self-catching, like the vault: a
// missing key / dead endpoint / network error NEVER throws into a request — it logs and no-ops.
import webpush from 'web-push'
import { listPushSubscriptions, removePushSubscription, type PushSubscriptionRow } from './conversations'

let _configured: boolean | null = null
function configured(): boolean {
  if (_configured !== null) return _configured
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
  if (pub && priv) {
    try { webpush.setVapidDetails(subject, pub, priv); _configured = true }
    catch (e) { console.warn('[push] VAPID setup failed:', (e as Error).message); _configured = false }
  } else { _configured = false }
  return _configured
}

export function isPushConfigured(): boolean {
  return configured()
}

export type PushPayload = {
  title: string
  body?: string
  url?: string                 // where notificationclick lands
  tag?: string                 // dedupe/replace key
  requireInteraction?: boolean
  data?: Record<string, unknown>
}

// Deliver to ONE subscription. Returns 'ok' | 'gone' (410/404 → prune it) | 'error'.
async function sendOne(sub: PushSubscriptionRow, payload: PushPayload): Promise<'ok' | 'gone' | 'error'> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 },   // hold up to an hour if the device is offline
    )
    return 'ok'
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.statusCode
    if (code === 404 || code === 410) return 'gone'   // subscription expired/unsubscribed
    console.warn('[push] send failed:', code ?? (err as Error).message)
    return 'error'
  }
}

// Broadcast to every registered device (your phone + any others). Prunes dead subscriptions.
// `endpointFilter` targets a single device (the test push). Returns delivery counts.
export async function sendPush(payload: PushPayload, endpointFilter?: string): Promise<{ sent: number; pruned: number; total: number }> {
  if (!configured()) { console.warn('[push] not configured (no VAPID keys)'); return { sent: 0, pruned: 0, total: 0 } }
  let subs: PushSubscriptionRow[] = []
  try { subs = listPushSubscriptions() } catch { return { sent: 0, pruned: 0, total: 0 } }
  if (endpointFilter) subs = subs.filter(s => s.endpoint === endpointFilter)
  let sent = 0, pruned = 0
  for (const sub of subs) {
    const r = await sendOne(sub, payload)
    if (r === 'ok') sent++
    else if (r === 'gone') { try { removePushSubscription(sub.endpoint); pruned++ } catch { /* ignore */ } }
  }
  return { sent, pruned, total: subs.length }
}

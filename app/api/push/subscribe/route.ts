// Register (or refresh) a device's Web Push subscription. The client calls this on every app
// open — iOS subscriptions die spontaneously, so re-subscribing keeps the endpoint live.
import { NextResponse } from 'next/server'
import { upsertPushSubscription } from '@/lib/conversations'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const sub = body.subscription || body
    const endpoint = sub?.endpoint
    const p256dh = sub?.keys?.p256dh
    const auth = sub?.keys?.auth
    if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: 'invalid subscription' }, { status: 400 })
    upsertPushSubscription({ endpoint, p256dh, auth, label: body.label ? String(body.label) : '' })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

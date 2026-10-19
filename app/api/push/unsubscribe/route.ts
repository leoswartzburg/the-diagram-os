// Drop a device's push subscription (the user turns notifications off, or the browser unsubscribes).
import { NextResponse } from 'next/server'
import { removePushSubscription } from '@/lib/conversations'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const endpoint = body.endpoint || body.subscription?.endpoint
    if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 })
    removePushSubscription(String(endpoint))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

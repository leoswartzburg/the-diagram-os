// Send a test push — the make-or-break check for iOS delivery. POST with an optional `endpoint`
// to target the calling device; otherwise broadcasts to all. GET reports config + device count.
import { NextResponse } from 'next/server'
import { sendPush, isPushConfigured } from '@/lib/push'
import { listPushSubscriptions } from '@/lib/conversations'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({ configured: isPushConfigured(), devices: listPushSubscriptions().length })
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const endpoint = body.endpoint ? String(body.endpoint) : undefined
    const result = await sendPush({
      title: 'Spectre',
      body: body.message || 'Notifications are live. This is a test — Spectre can now reach you here.',
      url: '/',
      tag: 'diagram-test',
    }, endpoint)
    return NextResponse.json({ ...result, configured: isPushConfigured() })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

// Inbox — the unified stream of everything Spectre fires at the user (reminders, rhythm
// pushes, news compiles; email monitoring later). GET lists + unread; POST marks read.
import { NextResponse } from 'next/server'
import { listInboxEvents, inboxUnreadCount, markInboxRead } from '@/lib/conversations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ events: listInboxEvents(20), unread: inboxUnreadCount() })
  } catch {
    return NextResponse.json({ events: [], unread: 0 })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    if (body.op === 'read') { markInboxRead(); return NextResponse.json({ ok: true }) }
    return NextResponse.json({ error: 'unknown op' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

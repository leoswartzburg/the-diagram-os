// Blocks — calendar-event ↔ project links (the bridge that makes a "Research 10–5"
// calendar entry mean something). Rows carry the event's time so the reconcile sweep can be
// range-scoped and past-safe. Unlink = tombstone (matched='unlinked'), never DELETE — the
// auto-matcher re-runs every calendar fetch and would resurrect a deleted row's link.
import { NextResponse } from 'next/server'
import { listBlocks, upsertBlock, tombstoneBlock, getNode } from '@/lib/conversations'

export const runtime = 'nodejs'

// GET /api/blocks?date=YYYY-MM-DD (default today) → links overlapping that local day.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const dateStr = url.searchParams.get('date') || ''
    const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0))
    const start = base.getTime()
    const end = start + 24 * 3600 * 1000
    return NextResponse.json({ blocks: listBlocks(start, end) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

// POST — manual link. Recurring instances pass recurring_event_id so ONE link covers the series.
export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const eventId = String(body.event_id || '')
    const nodeId = String(body.node_id || '')
    if (!eventId || !nodeId) return NextResponse.json({ error: 'event_id and node_id required' }, { status: 400 })
    if (!getNode(nodeId)) return NextResponse.json({ error: `no node "${nodeId}"` }, { status: 400 })
    const block = upsertBlock({
      event_id: eventId, node_id: nodeId, matched: 'manual',
      recurring_event_id: body.recurring_event_id ? String(body.recurring_event_id) : '',
      title: body.title ? String(body.title) : '',
      start_at: body.start_at ? Number(body.start_at) : 0,
      end_at: body.end_at ? Number(body.end_at) : 0,
    })
    return NextResponse.json({ block })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

// DELETE /api/blocks?event_id= — tombstone + release assigned tasks (logged, undoable).
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url)
    const eventId = url.searchParams.get('event_id')
    if (!eventId) return NextResponse.json({ error: 'event_id required' }, { status: 400 })
    tombstoneBlock(eventId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

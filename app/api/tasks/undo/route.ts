// Undo — transactional revert of one task_event or a whole group. This is the safety valve
// that makes the Secretary's auto-add tier acceptable: every auto action is one tap from
// reversed, and the undo itself is logged (an undo never hides history).
import { NextResponse } from 'next/server'
import { undoTaskEvents, listTaskEvents } from '@/lib/conversations'

export const runtime = 'nodejs'

// GET /api/tasks/undo?node_id=&limit= — the "Recent changes" strip data.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const nodeId = url.searchParams.get('node_id')
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100)
    return NextResponse.json({ events: listTaskEvents(nodeId === null ? undefined : nodeId, limit) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const eventId = body.event_id ? String(body.event_id) : undefined
    const groupId = body.group_id ? String(body.group_id) : undefined
    if (!eventId && !groupId) return NextResponse.json({ error: 'event_id or group_id required' }, { status: 400 })
    const result = undoTaskEvents({ event_id: eventId, group_id: groupId })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

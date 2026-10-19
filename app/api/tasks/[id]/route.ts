// One task — edit / complete / move / assign · soft-drop. Every mutation logs to
// task_events (op inferred from the patch) so the Recent-changes strip + undo stay honest.
import { NextResponse } from 'next/server'
import { getTask, updateTask } from '@/lib/conversations'
import { parseDue } from '@/lib/nlDue'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const task = getTask(id)
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ task })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: any = {}
    for (const k of ['title', 'notes', 'status', 'phase_id', 'block_event_id'] as const) {
      if (body[k] !== undefined) patch[k] = String(body[k])
    }
    if (body.step !== undefined) patch.step = body.step === null ? null : Number(body.step)
    if (body.lane !== undefined) patch.lane = Number(body.lane)
    if (body.position !== undefined) patch.position = Number(body.position)
    if (body.is_archived !== undefined) patch.is_archived = body.is_archived ? 1 : 0
    if (body.due_at !== undefined) patch.due_at = body.due_at === null ? null : String(body.due_at)
    else if (body.due !== undefined) patch.due_at = parseDue(String(body.due)).due_at
    const task = updateTask(id, patch, { actor: body.actor === 'secretary' ? 'secretary' : 'user' })
    if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ task })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

// DELETE = soft-drop (lifecycle), never a hard delete. Archive separately via PATCH.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const task = updateTask(id, { status: 'dropped' }, { actor: 'user' })
  if (!task) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ task })
}

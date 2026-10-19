// Tasks — list + create. The single `tasks` table backs every projection (map / list /
// block checklists); this route is the generic CRUD face.
import { NextResponse } from 'next/server'
import { listTasks, createTask, resolveStepPlacement } from '@/lib/conversations'
import { parseDue } from '@/lib/nlDue'

export const runtime = 'nodejs'

// GET /api/tasks              → every open task (the NOW list derives client-side)
// GET /api/tasks?node_id=     → one project's tasks ('' = personal)
// GET /api/tasks?include_done=1 — map view wants done tasks too (dimmed progress read)
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const nodeId = url.searchParams.get('node_id')
    const includeDone = url.searchParams.get('include_done') === '1'
    const tasks = listTasks(nodeId === null ? undefined : nodeId, { includeDone: true })
    return NextResponse.json({ tasks: includeDone ? tasks : tasks.filter(t => t.status !== 'done') })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

// POST /api/tasks — create. Accepts either an explicit due_at (client already parsed) or a
// raw NL `due` string (parsed here with chrono — the Secretary path never does date math).
// Map placement via {step_relation, anchor_id} (sparse fractional — never renumbers) or
// explicit {step, lane}.
export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const title = String(body.title || '').trim()
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })
    const nodeId = body.node_id ? String(body.node_id) : ''
    let due: string | null = body.due_at !== undefined ? (body.due_at === null ? null : String(body.due_at)) : null
    if (due === null && body.due) due = parseDue(String(body.due)).due_at
    let step: number | null = typeof body.step === 'number' ? body.step : null
    let lane: number = typeof body.lane === 'number' ? body.lane : 0
    if (step === null && nodeId && body.step_relation) {
      const placed = resolveStepPlacement(nodeId, body.step_relation, body.anchor_id ? String(body.anchor_id) : undefined)
      step = placed.step; lane = placed.lane
    }
    const task = createTask({
      node_id: nodeId, title, notes: body.notes ? String(body.notes) : '',
      step, lane, due_at: due,
      block_event_id: body.block_event_id ? String(body.block_event_id) : '',
      notepad_id: body.notepad_id ? String(body.notepad_id) : '',
      source: body.source === 'secretary' ? 'secretary' : 'user',
      actor: body.source === 'secretary' ? 'secretary' : 'user',
    })
    return NextResponse.json({ task })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

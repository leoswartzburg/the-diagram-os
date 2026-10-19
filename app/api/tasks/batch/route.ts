// Batch task ops — SEMANTIC, server-side, transactional. The client sends what it MEANS
// ("move X between A and B", "into step k's lane stack"), the server computes the sparse
// fractional placement inside the write, and the response returns the authoritative rows
// for optimistic-UI reconciliation. Never a client-computed absolute (step,lane) dump —
// that pattern is single-writer, and this table has two writers (the user + the Secretary).
import { NextResponse } from 'next/server'
import { getTask, updateTask, resolveStepPlacement, listTasks, tasksTransaction } from '@/lib/conversations'
import { randomUUID } from 'crypto'

export const runtime = 'nodejs'

type BatchOp =
  | { op: 'place'; id: string; relation: 'after' | 'before' | 'parallel' | 'start' | 'end'; anchor_id?: string }
  | { op: 'move'; id: string; step: number; lane: number }        // explicit slot (drag onto an existing stack)
  | { op: 'position'; id: string; position: number }              // personal-list reorder
  | { op: 'unplace'; id: string }                                 // back to the Inbox column

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const ops: BatchOp[] = Array.isArray(body.ops) ? body.ops : []
    if (!ops.length) return NextResponse.json({ error: 'ops required' }, { status: 400 })
    // Validate numeric fields BEFORE any write — a missing/NaN step or lane must never reach
    // the DB (it would either null a task off the map or throw a NOT NULL error mid-batch).
    const fin = (v: unknown) => Number.isFinite(Number(v))
    for (const o of ops) {
      if (o.op === 'move' && (!fin(o.step) || !fin(o.lane))) return NextResponse.json({ error: 'move needs finite step+lane' }, { status: 400 })
      if (o.op === 'position' && !fin(o.position)) return NextResponse.json({ error: 'position needs a finite number' }, { status: 400 })
    }
    const group = randomUUID()
    const affected = new Set<string>()
    // One transaction for the whole batch — any throw rolls back every op (true atomicity,
    // no partial application if a later op fails or a concurrent write collides).
    tasksTransaction(() => {
      for (const o of ops) {
        const t = getTask(String(o.id))
        if (!t) continue
        if (o.op === 'place') {
          const placed = resolveStepPlacement(t.node_id, o.relation, o.anchor_id)
          updateTask(t.id, { step: placed.step, lane: placed.lane }, { group_id: group })
        } else if (o.op === 'move') {
          updateTask(t.id, { step: Number(o.step), lane: Number(o.lane) }, { group_id: group })
        } else if (o.op === 'position') {
          updateTask(t.id, { position: Number(o.position) }, { group_id: group })
        } else if (o.op === 'unplace') {
          updateTask(t.id, { step: null, lane: 0 }, { group_id: group })
        }
        affected.add(t.id)
      }
    })
    // Authoritative state back for the touched nodes (small sets — reconcile wholesale).
    const nodes = [...new Set([...affected].map(id => getTask(id)?.node_id ?? ''))]
    const tasks = nodes.flatMap(n => listTasks(n, { includeDone: true }))
    return NextResponse.json({ group_id: group, tasks })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

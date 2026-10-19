// The Librarian API — propose / review / apply a document-tidy plan for one project Hand.
//   GET  ?node_id=<id>   → the current proposed plan for that project (or null)
//   GET  (no node_id)    → every open plan (the notification bell counts these)
//   POST { op:'generate', node_id }              → build a fresh dry-run plan (proposes only)
//   POST { op:'apply', plan_id, approved:[ids] } → apply ONLY the approved actions
//   POST { op:'dismiss', plan_id }               → shelve a plan without applying
// Runs on the local model (gpt-oss) with a Claude Haiku fallback/escalation. NEVER writes to Mem0.
import { NextResponse } from 'next/server'
import { getLibrarianPlan, listLibrarianPlans, updateLibrarianPlan } from '@/lib/conversations'
import { generateLibrarianPlan, applyLibrarianPlan, shapePlan } from '@/lib/librarian'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const nodeId = new URL(req.url).searchParams.get('node_id')
    if (nodeId) {
      const row = getLibrarianPlan(nodeId)
      return NextResponse.json({ plan: row ? shapePlan(row) : null })
    }
    return NextResponse.json({ plans: listLibrarianPlans('proposed').map(shapePlan) })
  } catch (err) {
    return NextResponse.json({ plan: null, plans: [], error: err instanceof Error ? err.message : 'failed' })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const op = String(body.op || '')
    if (op === 'generate') {
      const prefer = body.prefer === 'claude' ? 'claude' : body.prefer === 'local' ? 'local' : undefined
      const plan = await generateLibrarianPlan(String(body.node_id || ''), prefer)
      return NextResponse.json({ plan })
    }
    if (op === 'apply') {
      const approved = Array.isArray(body.approved) ? body.approved.map(String) : []
      const edits = body.edits && typeof body.edits === 'object' ? body.edits : undefined
      const res = await applyLibrarianPlan(String(body.plan_id || ''), approved, edits)
      return NextResponse.json(res)
    }
    if (op === 'dismiss') {
      const row = updateLibrarianPlan(String(body.plan_id || ''), { status: 'dismissed' })
      return NextResponse.json({ plan: row ? shapePlan(row) : null })
    }
    return NextResponse.json({ error: 'unknown op' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

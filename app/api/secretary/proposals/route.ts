// Secretary structural proposals — the review queue. GET lists the current/all proposals
// (the map's review panel + the bell); POST applies approved actions or dismisses. Applying
// runs the Librarian-contract executor (per-action revalidation, loud failure). §6.
import { NextResponse } from 'next/server'
import { getSecretaryProposal, listSecretaryProposals, updateSecretaryProposal } from '@/lib/conversations'
import { applyProposal } from '@/lib/tools/secretaryApply'

export const runtime = 'nodejs'

// GET ?node_id= → the current proposed plan for that node; GET (bare) → all proposed (bell).
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const nodeId = url.searchParams.get('node_id')
    if (nodeId) return NextResponse.json({ proposal: getSecretaryProposal(nodeId) ?? null })
    return NextResponse.json({ proposals: listSecretaryProposals('proposed') })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const op = String(body.op || '')
    const id = String(body.id || '')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    if (op === 'dismiss') { updateSecretaryProposal(id, { status: 'dismissed' }); return NextResponse.json({ ok: true }) }
    if (op === 'apply') {
      const approved: number[] = Array.isArray(body.approved) ? body.approved.map(Number) : []
      const result = applyProposal(id, approved)
      return NextResponse.json(result)
    }
    return NextResponse.json({ error: `unknown op "${op}"` }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { getDiagramTree } from '@/lib/conversations'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/tree — the full live Diagram tree (Arms, Hands, Sources, Notebooks) as a
// compact string for Spectre's spatial-awareness primer, plus an item index
// (notebook id / file id → owning node id) for implicit-navigate. `getDiagramTree()`
// caches in lib/conversations with a 30s TTL safety net, and that cache is invalidated
// on EVERY write to diagram_nodes / notebooks / files (bustTreeCache) — so new, renamed,
// or deleted items show up here immediately rather than after the TTL.
export async function GET() {
  try {
    return NextResponse.json(getDiagramTree())
  } catch (e) {
    console.error('[tree] failed:', e)
    return NextResponse.json({ tree: '', index: { notebooks: {}, files: {} } }, { status: 500 })
  }
}

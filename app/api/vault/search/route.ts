import { NextRequest, NextResponse } from 'next/server'
import { searchVault, searchDocument } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// POST /api/vault/search { query, node_id?, limit?, threshold?, source_id?, source_type? } —
// semantic search over the Metalmind vault (Qdrant `spectre_wiki`). Two modes:
//  · DOCUMENT-SCOPED (source_id + source_type present) — the "second screen": search ONLY
//    that one open document's chunks. Low threshold, rank-ordered sections.
//  · VAULT-WIDE (node_id / nothing) — the [VAULT CONTEXT] auto-injection + searchVault action.
// Returns { results: [] } — empty (never an error) when Qdrant/Ollama are down, so the
// caller can always proceed silently.
export async function POST(req: NextRequest) {
  try {
    // Debug/Claude-Code sessions skip vault auto-injection — a test call pulls nothing.
    if (req.headers.get('x-debug-session') === 'true') return NextResponse.json({ results: [] })
    const body = await req.json().catch(() => ({}))
    const query = String(body?.query ?? '').trim()
    if (!query) return NextResponse.json({ results: [] })
    const limit = Number.isFinite(body?.limit) ? Math.max(1, Math.min(20, Number(body.limit))) : 5
    // Document-scoped (open reference doc) takes precedence when a source_id is supplied.
    const sourceId = body?.source_id ? String(body.source_id) : ''
    const sourceType = body?.source_type === 'notebook' ? 'notebook' : 'file'
    if (sourceId) {
      const threshold = Number.isFinite(body?.threshold) ? Number(body.threshold) : 0.25
      const results = await searchDocument(query, sourceType, sourceId, limit, threshold)
      return NextResponse.json({ results: results ?? [] })
    }
    const nodeId = body?.node_id ? String(body.node_id) : undefined
    const threshold = Number.isFinite(body?.threshold) ? Number(body.threshold) : 0.65
    const results = await searchVault(query, nodeId, limit, threshold)
    return NextResponse.json({ results: results ?? [] })
  } catch (e) {
    console.error('[vault/search] failed:', e)
    return NextResponse.json({ results: [] })
  }
}

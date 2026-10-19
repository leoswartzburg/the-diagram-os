import { NextRequest, NextResponse } from 'next/server'
import { ensureDocIndexed } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// POST /api/vault/index { source_type, source_id } — ensure one document is vectorized into
// the vault so document-scoped search ("second screen") has its chunks. Fired when a Source
// file or notebook is opened. No-op when already indexed. Always returns { ok: true } even
// when the vault is down (the policy: never block the UI).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const sourceId = String(body?.source_id ?? '').trim()
    const sourceType = body?.source_type === 'notebook' ? 'notebook' : 'file'
    if (!sourceId) return NextResponse.json({ ok: false })
    // Fire-and-forget — indexing a large PDF shouldn't hold the response; the next turn's
    // scoped search picks up the chunks once they land.
    void ensureDocIndexed(sourceType, sourceId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[vault/index] failed:', e)
    return NextResponse.json({ ok: false })
  }
}

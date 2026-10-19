import { NextRequest, NextResponse } from 'next/server'
import { compressSession } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// POST /api/chat/sessions/[id]/compress — fold the oldest turns into summaries until
// the active context is back under budget. Idempotent (a no-op when already small).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const result = await compressSession(id)
    return NextResponse.json(result)
  } catch (e) {
    console.error('[compress] POST failed:', e)
    return NextResponse.json({ compressed: false, level: 0, error: 'compress failed' })
  }
}

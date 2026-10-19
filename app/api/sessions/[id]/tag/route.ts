import { NextRequest, NextResponse } from 'next/server'
import { setSessionTag } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// PATCH /api/sessions/[id]/tag { tag_id } — set (or clear with null) a session's section.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { tag_id } = await req.json()
    const session = setSessionTag(id, tag_id ?? null)
    if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ session })
  } catch (e) {
    console.error('[sessions] PATCH tag failed:', e)
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }
}

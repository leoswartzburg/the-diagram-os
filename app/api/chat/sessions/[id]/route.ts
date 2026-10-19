import { NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// PATCH /api/chat/sessions/[id] { title?, is_archived? } — rename / archive.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { title, is_archived } = await req.json()
    const session = updateSession(id, { title, is_archived })
    if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ session })
  } catch (e) {
    console.error('[sessions] PATCH failed:', e)
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }
}

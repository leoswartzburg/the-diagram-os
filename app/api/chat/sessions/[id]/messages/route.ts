import { NextRequest, NextResponse } from 'next/server'
import { getMessages, addMessage } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/chat/sessions/[id]/messages — full message history (verbatim + summaries).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    return NextResponse.json({ messages: getMessages(id) })
  } catch (e) {
    console.error('[messages] GET failed:', e)
    return NextResponse.json({ messages: [] })
  }
}

// POST /api/chat/sessions/[id]/messages { role, content, is_bookmarked? } — append a turn.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { role, content, is_bookmarked } = await req.json()
    if (role !== 'user' && role !== 'assistant') {
      return NextResponse.json({ error: 'invalid role' }, { status: 400 })
    }
    const result = addMessage(id, role, String(content ?? ''), { is_bookmarked })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[messages] POST failed:', e)
    return NextResponse.json({ error: 'append failed' }, { status: 500 })
  }
}

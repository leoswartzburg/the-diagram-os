import { NextRequest, NextResponse } from 'next/server'
import { editMessage, truncateAfter, getMessages } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// PATCH /api/chat/sessions/[id]/messages/[messageId] { content } — edit a past user
// message and truncate everything after it (soft-delete; originals are kept). The
// caller then re-runs generation from this point. Returns the surviving messages.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const { id, messageId } = await params
    const { content } = await req.json()
    editMessage(id, messageId, String(content ?? ''))
    const messages = truncateAfter(id, messageId, false)   // keep the edited message
    return NextResponse.json({ messages })
  } catch (e) {
    console.error('[message edit] PATCH failed:', e)
    return NextResponse.json({ error: 'edit failed' }, { status: 500 })
  }
}

// DELETE /api/chat/sessions/[id]/messages/[messageId] — truncate from this message
// inclusive (retry: drop the last assistant turn before regenerating).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const { id, messageId } = await params
    const messages = truncateAfter(id, messageId, true)
    return NextResponse.json({ messages })
  } catch (e) {
    console.error('[message delete] DELETE failed:', e)
    return NextResponse.json({ messages: [] }, { status: 500 })
  }
}

// GET — convenience: surviving messages (mirrors the parent messages route).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    return NextResponse.json({ messages: getMessages(id) })
  } catch {
    return NextResponse.json({ messages: [] })
  }
}

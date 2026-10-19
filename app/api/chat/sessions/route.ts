import { NextRequest, NextResponse } from 'next/server'
import { listSessions, createSession } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/chat/sessions?folder_id=X&archived=0 — list sessions for a folder/scope.
export async function GET(req: NextRequest) {
  try {
    const folderId = req.nextUrl.searchParams.get('folder_id')
    if (!folderId) return NextResponse.json({ sessions: [] })
    const includeArchived = req.nextUrl.searchParams.get('archived') === '1'
    return NextResponse.json({ sessions: listSessions(folderId, includeArchived) })
  } catch (e) {
    console.error('[sessions] GET failed:', e)
    return NextResponse.json({ sessions: [] })
  }
}

// POST /api/chat/sessions { folder_id, firstMessage?, title?, tag_id? } — create a session.
export async function POST(req: NextRequest) {
  try {
    const { folder_id, firstMessage, title, tag_id } = await req.json()
    if (!folder_id) return NextResponse.json({ error: 'folder_id required' }, { status: 400 })
    const session = createSession(String(folder_id), { firstMessage, title, tag_id: tag_id ?? null })
    return NextResponse.json({ session })
  } catch (e) {
    console.error('[sessions] POST failed:', e)
    return NextResponse.json({ error: 'create failed' }, { status: 500 })
  }
}

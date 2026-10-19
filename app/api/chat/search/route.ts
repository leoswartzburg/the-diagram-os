import { NextRequest, NextResponse } from 'next/server'
import { searchSessions } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/chat/search?folder_id=X&q=Y&tag_id=Z — full-text-ish search over a single
// node's conversations (titles + message content). Scoped to folder_id, and further to
// the given section/tag when tag_id is present (the active filter in a project Hand).
export async function GET(req: NextRequest) {
  try {
    const folderId = req.nextUrl.searchParams.get('folder_id')
    const q = req.nextUrl.searchParams.get('q') ?? ''
    const tagId = req.nextUrl.searchParams.get('tag_id')
    if (!folderId || !q.trim()) return NextResponse.json({ results: [] })
    return NextResponse.json({ results: searchSessions(folderId, q, tagId) })
  } catch (e) {
    console.error('[search] GET failed:', e)
    return NextResponse.json({ results: [] })
  }
}

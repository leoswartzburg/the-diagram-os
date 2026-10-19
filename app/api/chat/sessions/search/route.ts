import { NextRequest, NextResponse } from 'next/server'
import { searchSessions } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/chat/sessions/search?node_id=X&q=Y — sessions in one node matching a query,
// TITLE matches first then message-content matches, each newest-first. Powers Spectre's
// searchSessions action ("find the conversation where we discussed …"). Static `search`
// segment takes precedence over the sibling `[id]` dynamic route.
export async function GET(req: NextRequest) {
  try {
    const nodeId = req.nextUrl.searchParams.get('node_id')
    const q = req.nextUrl.searchParams.get('q') ?? ''
    if (!nodeId || !q.trim()) return NextResponse.json({ sessions: [] })
    // searchSessions already ranks title matches inline + orders by updated_at DESC; a
    // stable re-sort floats every title match above content matches while keeping recency.
    const results = searchSessions(nodeId, q)
    const sorted = [...results].sort(
      (a, b) => (a.match_field === 'title' ? 0 : 1) - (b.match_field === 'title' ? 0 : 1),
    )
    return NextResponse.json({ sessions: sorted })
  } catch (e) {
    console.error('[sessions/search] GET failed:', e)
    return NextResponse.json({ sessions: [] })
  }
}

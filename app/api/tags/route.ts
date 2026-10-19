import { NextRequest, NextResponse } from 'next/server'
import { listTags, createTag } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/tags?node_id=X — sections/tags for a project Hand.
export async function GET(req: NextRequest) {
  try {
    const nodeId = req.nextUrl.searchParams.get('node_id')
    if (!nodeId) return NextResponse.json({ error: 'node_id required' }, { status: 400 })
    return NextResponse.json({ tags: listTags(nodeId) })
  } catch (e) {
    console.error('[tags] GET failed:', e)
    return NextResponse.json({ tags: [] })
  }
}

// POST /api/tags { node_id, name } — create a tag (next palette color auto-assigned).
export async function POST(req: NextRequest) {
  try {
    const { node_id, name } = await req.json()
    if (!node_id || !name?.trim()) {
      return NextResponse.json({ error: 'node_id and name required' }, { status: 400 })
    }
    return NextResponse.json({ tag: createTag(String(node_id), String(name)) })
  } catch (e) {
    console.error('[tags] POST failed:', e)
    return NextResponse.json({ error: 'create failed' }, { status: 500 })
  }
}

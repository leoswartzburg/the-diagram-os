import { NextRequest, NextResponse } from 'next/server'
import { listNotebooks, listAllNotebooks, createNotebook, notebookChildCount } from '@/lib/conversations'
import { syncNotebookToVault } from '@/lib/vault'

export const dynamic = 'force-dynamic'

// GET /api/notebooks?node_id=X&parent_id=Y — items at one level (folders first, then
// notebooks). parent_id defaults to '' (top level). `&all=1` returns the whole tree for
// the node (client derives levels + the primer index). Folders carry a live child count.
export async function GET(req: NextRequest) {
  try {
    const nodeId = req.nextUrl.searchParams.get('node_id')
    if (!nodeId) return NextResponse.json({ error: 'node_id required' }, { status: 400 })
    const rows = req.nextUrl.searchParams.get('all')
      ? listAllNotebooks(nodeId)
      : listNotebooks(nodeId, req.nextUrl.searchParams.get('parent_id') ?? '')
    const items = rows.map(n => n.type === 'folder' ? { ...n, child_count: notebookChildCount(n.id) } : n)
    return NextResponse.json({ notebooks: items })
  } catch (e) {
    console.error('[notebooks] GET failed:', e)
    return NextResponse.json({ notebooks: [] })
  }
}

// POST /api/notebooks — create a folder or notebook.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { node_id, title, type } = body ?? {}
    if (!node_id || !title || (type !== 'folder' && type !== 'notebook')) {
      return NextResponse.json({ error: 'node_id, title, type required' }, { status: 400 })
    }
    const notebook = createNotebook({
      node_id, title, type,
      parent_id: body.parent_id ?? '',
      content: body.content ?? '',
      icon: body.icon ?? '',
      color: body.color ?? '',
      created_by: body.created_by ?? 'user',
    })
    // Index new notebooks immediately (folders carry no content). Fire-and-forget.
    if (notebook.type === 'notebook') void syncNotebookToVault(notebook.id)
    return NextResponse.json({ notebook })
  } catch (e) {
    console.error('[notebooks] POST failed:', e)
    return NextResponse.json({ error: 'create failed' }, { status: 500 })
  }
}

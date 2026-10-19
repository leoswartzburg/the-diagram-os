import { NextRequest, NextResponse } from 'next/server'
import { getNotebook, updateNotebook, archiveNotebook, notebookChildIds, NotebookConflictError } from '@/lib/conversations'
import { syncNotebookToVault, removeFromVault } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/notebooks/[id] — the full row including TipTap JSON content.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const notebook = getNotebook(id)
    if (!notebook || notebook.is_archived) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ notebook })
  } catch (e) {
    console.error('[notebooks/id] GET failed:', e)
    return NextResponse.json({ error: 'read failed' }, { status: 500 })
  }
}

// PATCH /api/notebooks/[id] — update title/content/icon/color/parent/position (bumps updated_at).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const notebook = updateNotebook(id, {
      title: body.title,
      content: body.content,
      icon: body.icon,
      color: body.color,
      parent_id: body.parent_id,
      position: body.position,
      // Optimistic-concurrency guard (optional): a caller that sends the updated_at it last
      // read gets a 409 (below) instead of silently clobbering a concurrent write.
      expectedUpdatedAt: body.expectedUpdatedAt,
    })
    if (!notebook) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Mirror to the vault (debounced internally). Fire-and-forget — never blocks the save.
    if (notebook.type === 'notebook') void syncNotebookToVault(notebook.id)
    return NextResponse.json({ notebook })
  } catch (e) {
    if (e instanceof NotebookConflictError) {
      // The row changed since the caller's read — return the current row so it can re-merge.
      return NextResponse.json({ error: 'conflict', conflict: true, notebook: e.notebook }, { status: 409 })
    }
    console.error('[notebooks/id] PATCH failed:', e)
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }
}

// DELETE /api/notebooks/[id] — soft-archive. A folder also archives its children.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // A folder cascade-archives its child Documents — capture their ids BEFORE archiving so we
    // can drop their vault vectors too, else "deleted" docs keep surfacing in semantic search.
    const existing = getNotebook(id)
    const childIds = existing?.type === 'folder' ? notebookChildIds(id) : []
    const notebook = archiveNotebook(id)
    if (!notebook) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Drop its (and any child Documents') vectors from the vault. Fire-and-forget.
    void removeFromVault('notebook', id)
    for (const childId of childIds) void removeFromVault('notebook', childId)
    return NextResponse.json({ notebook })
  } catch (e) {
    console.error('[notebooks/id] DELETE failed:', e)
    return NextResponse.json({ error: 'archive failed' }, { status: 500 })
  }
}

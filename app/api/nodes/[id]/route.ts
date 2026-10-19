import { NextRequest, NextResponse } from 'next/server'
import { updateNode, archiveNode } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// PATCH /api/nodes/[id] { name?, position?, primer?, icon?, is_archived?, progress?, phase?, description? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { name, position, primer, icon, is_archived, progress, phase, description } = await req.json()
    const node = updateNode(id, { name, position, primer, icon, is_archived, progress, phase, description })
    if (!node) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ node })
  } catch (e) {
    console.error('[nodes] PATCH failed:', e)
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }
}

// DELETE /api/nodes/[id] — soft-delete (is_archived = true). Sessions are preserved.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const node = archiveNode(id)
    if (!node) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ node })
  } catch (e) {
    console.error('[nodes] DELETE failed:', e)
    return NextResponse.json({ error: 'archive failed' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { deleteTag } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// DELETE /api/tags/[id] — remove a tag; its sessions become untagged (tag_id = null).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    deleteTag(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[tags] DELETE failed:', e)
    return NextResponse.json({ error: 'delete failed' }, { status: 500 })
  }
}

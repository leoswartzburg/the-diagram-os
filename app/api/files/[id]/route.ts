import { NextRequest, NextResponse } from 'next/server'
import { archiveFile } from '@/lib/conversations'
import { removeFromVault } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// DELETE /api/files/[id] — soft-delete (is_archived = 1). The bytes stay on disk.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const file = archiveFile(id)
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Drop its vectors from the vault (the .md mirror stays — Sources are permanent on disk).
    void removeFromVault('file', id)
    return NextResponse.json({ file })
  } catch (e) {
    console.error('[files] DELETE failed:', e)
    return NextResponse.json({ error: 'archive failed' }, { status: 500 })
  }
}

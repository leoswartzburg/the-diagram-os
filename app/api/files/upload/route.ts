import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'fs/promises'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { addFile } from '@/lib/conversations'
import { syncFileToVault } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Files live on disk, outside the DB. The row keeps the original filename + a relative
// stored_path. Sources (right panel): the-diagram-files/projects/<node>/sources/<uuid>.
// Chat attachments: the-diagram-files/chat/<node>/<uuid>.

// POST /api/files/upload — multipart { file, node_id, source? }. Stores the bytes,
// inserts a metadata row, returns { file }. source='sources' (default, right panel) lives
// under projects/<node>/sources/; source='chat' (chat attachment) under chat/<node>/;
// source='notebook' (inline Docu-scape image) under projects/<node>/notebooks/.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const node_id = String(form.get('node_id') ?? '').trim()
    const sourceRaw = String(form.get('source') ?? 'sources')
    const source = sourceRaw === 'chat' ? 'chat' : sourceRaw === 'notebook' ? 'notebook' : 'sources'
    const file = form.get('file')
    if (!node_id || !(file instanceof File)) {
      return NextResponse.json({ error: 'file and node_id required' }, { status: 400 })
    }

    const relDir = source === 'chat'
      ? join('the-diagram-files', 'chat', node_id)
      : source === 'notebook'
        ? join('the-diagram-files', 'projects', node_id, 'notebooks')
        : join('the-diagram-files', 'projects', node_id, 'sources')
    const dir = join(process.cwd(), relDir)
    await mkdir(dir, { recursive: true })

    const ext = extname(file.name) || ''
    const safeName = `${randomUUID()}${ext}`
    const abs = join(dir, safeName)
    const bytes = Buffer.from(await file.arrayBuffer())
    await writeFile(abs, bytes)

    const stored_path = join(relDir, safeName)
    const file_type = (ext.replace('.', '') || file.type || 'file').toLowerCase()
    const row = addFile({
      node_id,
      filename: file.name,
      stored_path,
      file_type,
      size_bytes: bytes.length,
      source,
    })
    // Mirror Sources files into the vault (companion .md + vectors). Fire-and-forget — the
    // upload response returns immediately; indexing happens in the background. Chat
    // attachments (source='chat') are not part of the vault.
    if (source === 'sources') void syncFileToVault(row.id)
    return NextResponse.json({ file: row })
  } catch (e) {
    console.error('[files/upload] failed:', e)
    return NextResponse.json({ error: 'upload failed' }, { status: 500 })
  }
}

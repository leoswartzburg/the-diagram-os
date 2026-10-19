import { NextRequest, NextResponse } from 'next/server'
import { getFile } from '@/lib/conversations'
import { readFile } from 'fs/promises'
import { join } from 'path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Minimal extension → MIME map for inline preview (image/PDF). The openFile action
// renders images via <img> and PDFs via <iframe>, both of which need the real bytes
// served with a correct Content-Type. Text/MD previews use /content instead.
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
}

// GET /api/files/[id]/raw — stream a Sources file's bytes for inline UI preview.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const file = getFile(id)
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const abs = join(process.cwd(), file.stored_path)
    const buf = await readFile(abs)
    const type = MIME[(file.file_type || '').toLowerCase()] ?? 'application/octet-stream'
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (e) {
    console.error('[files/raw] failed:', e)
    return NextResponse.json({ error: 'read failed' }, { status: 500 })
  }
}

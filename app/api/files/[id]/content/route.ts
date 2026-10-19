import { NextRequest, NextResponse } from 'next/server'
import { getFile } from '@/lib/conversations'
import { extractText } from '@/lib/fileText'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CHARS = 80_000

// GET /api/files/[id]/content — full text content of a Sources file, for Spectre's
// readFile action. PDFs are parsed, text read directly, images return a placeholder.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const file = getFile(id)
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const { text, kind } = await extractText(file)
    return NextResponse.json({ filename: file.filename, kind, content: text.slice(0, MAX_CHARS) })
  } catch (e) {
    console.error('[files/content] failed:', e)
    return NextResponse.json({ error: 'read failed' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { getFile } from '@/lib/conversations'
import { extractText } from '@/lib/fileText'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CHARS = 50_000

// POST /api/files/extract-text { id } — extract text from a file (PDF parse / text read).
// Used by chat attachments before sending so PDFs/text reach Claude as text. Capped.
export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json()
    const file = getFile(String(id ?? ''))
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const { text, kind } = await extractText(file)
    return NextResponse.json({ filename: file.filename, kind, text: text.slice(0, MAX_CHARS) })
  } catch (e) {
    console.error('[files/extract-text] failed:', e)
    return NextResponse.json({ error: 'extract failed' }, { status: 500 })
  }
}

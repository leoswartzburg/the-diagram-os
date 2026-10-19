// Server-only text extraction for uploaded files. Used by /api/files/extract-text
// (chat attachments) and /api/files/[id]/content (Sources readFile action).
//
// PDFs are parsed with pdf-parse (imported from its lib subpath to skip the package
// index's debug harness, which tries to read a bundled test PDF at import time and
// throws in a Next.js server bundle). Plain-text formats are read directly. Images and
// binary office formats return a short placeholder — images reach Claude as image
// content blocks (chat) and aren't text-extractable here.
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { FileRow } from './conversations'

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'text']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic']

export type ExtractKind = 'pdf' | 'text' | 'image' | 'other'

export function fileKind(fileType: string): ExtractKind {
  const t = (fileType || '').toLowerCase()
  if (t === 'pdf') return 'pdf'
  if (TEXT_EXT.includes(t) || t.startsWith('text')) return 'text'
  if (IMAGE_EXT.includes(t) || t.startsWith('image')) return 'image'
  return 'other'
}

// Returns extracted text (or a short placeholder) plus the resolved kind. Never throws —
// failures degrade to a readable note so callers can always return a 200.
export async function extractText(file: FileRow): Promise<{ text: string; kind: ExtractKind }> {
  const kind = fileKind(file.file_type)
  const abs = join(process.cwd(), file.stored_path)

  try {
    if (kind === 'text') {
      return { text: await readFile(abs, 'utf-8'), kind }
    }
    if (kind === 'pdf') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>
      const buf = await readFile(abs)
      const data = await pdfParse(buf)
      const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim()
      return { text: text || `(No extractable text found in ${file.filename}.)`, kind }
    }
    if (kind === 'image') {
      return { text: `[${file.filename} is an image file. Image contents can't be read as text — attach it directly in chat to have me view it.]`, kind }
    }
    return { text: `[${file.filename} is a ${file.file_type.toUpperCase()} file. Text extraction isn't supported for this format yet.]`, kind }
  } catch (e) {
    console.error('[fileText] extract failed:', e)
    return { text: `(Couldn't read ${file.filename}.)`, kind }
  }
}

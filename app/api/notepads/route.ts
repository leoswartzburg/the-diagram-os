// Notepads — the whiteboard next to the desk. Plain text, fast.
import { NextResponse } from 'next/server'
import { listNotepads, createNotepad, updateNotepad } from '@/lib/conversations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try { return NextResponse.json({ notepads: listNotepads() }) } catch {
    return NextResponse.json({ notepads: [] })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    return NextResponse.json({ notepad: createNotepad(String(body.title || 'Notepad')) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const id = String(body.id || '')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const notepad = updateNotepad(id, {
      title: body.title !== undefined ? String(body.title) : undefined,
      content: body.content !== undefined ? String(body.content) : undefined,
      is_archived: body.is_archived !== undefined ? !!body.is_archived : undefined,
    })
    if (!notepad) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ notepad })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

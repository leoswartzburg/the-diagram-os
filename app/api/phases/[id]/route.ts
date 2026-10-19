// One phase — rename/recolor · delete (unlabels member tasks, never deletes them).
import { NextResponse } from 'next/server'
import { updatePhase, deletePhase } from '@/lib/conversations'

export const runtime = 'nodejs'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const phase = updatePhase(id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      color: body.color !== undefined ? String(body.color) : undefined,
      position: body.position !== undefined ? Number(body.position) : undefined,
    })
    if (!phase) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ phase })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    deletePhase(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

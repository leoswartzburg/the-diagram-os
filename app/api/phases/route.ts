// Phases — labels over map tasks; the bracket layer of the project map.
import { NextResponse } from 'next/server'
import { listPhases, createPhase } from '@/lib/conversations'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const nodeId = url.searchParams.get('node_id')
    if (!nodeId) return NextResponse.json({ error: 'node_id required' }, { status: 400 })
    return NextResponse.json({ phases: listPhases(nodeId) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const nodeId = String(body.node_id || '')
    const name = String(body.name || '').trim()
    if (!nodeId || !name) return NextResponse.json({ error: 'node_id and name required' }, { status: 400 })
    return NextResponse.json({ phase: createPhase({ node_id: nodeId, name, color: body.color ? String(body.color) : undefined }) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

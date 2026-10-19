import { NextRequest, NextResponse } from 'next/server'
import { listNodes, createNode, type NodeLevel, type NodeTemplate } from '@/lib/conversations'
import { ensureNodeFolders } from '@/lib/vault'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/nodes — the full Arm/Hand tree (non-archived).
export async function GET() {
  try {
    return NextResponse.json({ nodes: listNodes() })
  } catch (e) {
    console.error('[nodes] GET failed:', e)
    return NextResponse.json({ nodes: [] })
  }
}

// POST /api/nodes { name, level, parent_id?, template?, icon?, primer? } — create an
// Arm or Hand. Position is computed server-side (appended after existing siblings).
export async function POST(req: NextRequest) {
  try {
    const { name, level, parent_id, template, icon, primer } = await req.json()
    if (!name || (level !== 'arm' && level !== 'hand')) {
      return NextResponse.json({ error: 'name and level (arm|hand) required' }, { status: 400 })
    }
    const node = createNode({
      name: String(name),
      level: level as NodeLevel,
      parent_id: parent_id ?? null,
      template: (template ?? 'custom') as NodeTemplate,
      icon, primer,
    })
    // Mirror the new Arm/Hand into the vault filesystem. Fire-and-forget.
    void ensureNodeFolders(node.id)
    return NextResponse.json({ node })
  } catch (e) {
    console.error('[nodes] POST failed:', e)
    return NextResponse.json({ error: 'create failed' }, { status: 500 })
  }
}

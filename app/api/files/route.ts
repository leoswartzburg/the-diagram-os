import { NextRequest, NextResponse } from 'next/server'
import { listFiles } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// GET /api/files?node_id=X — non-archived source files for a node (the SOURCES list).
export async function GET(req: NextRequest) {
  try {
    const nodeId = req.nextUrl.searchParams.get('node_id')
    if (!nodeId) return NextResponse.json({ error: 'node_id required' }, { status: 400 })
    return NextResponse.json({ files: listFiles(nodeId) })
  } catch (e) {
    console.error('[files] GET failed:', e)
    return NextResponse.json({ files: [] })
  }
}

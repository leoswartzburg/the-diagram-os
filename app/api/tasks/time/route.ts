// Per-project tracked time — the focus↔task rollup. GET returns
// { [node_id]: total_spent_ms } for the Projects landing.
import { NextResponse } from 'next/server'
import { projectSpentMsByNode } from '@/lib/conversations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ spent: projectSpentMsByNode() })
  } catch {
    return NextResponse.json({ spent: {} })
  }
}

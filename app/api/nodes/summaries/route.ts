import { NextResponse } from 'next/server'
import { refreshProjectSummaries } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// POST /api/nodes/summaries — refresh every Project Hand's activity summary and return
// { summaries: { nodeId: text } }. Haiku is only called when there is new session activity
// since the last generation; cached summaries are returned instantly. GET behaves identically.
async function run() {
  try {
    const summaries = await refreshProjectSummaries()
    return NextResponse.json({ summaries })
  } catch (e) {
    console.error('[nodes/summaries] failed:', e)
    return NextResponse.json({ summaries: {} })
  }
}

export const POST = run
export const GET = run

import { NextRequest, NextResponse } from 'next/server'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { isAuthorizedSystemRequest } from '@/lib/systemAuth'

export const dynamic = 'force-dynamic'

// POST { event: string } — append a timestamped line to failover.log (gitignored).
// Used to record voice-failover events for later review.
export async function POST(req: NextRequest) {
  if (!isAuthorizedSystemRequest(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const event = String(body?.event ?? 'failover').slice(0, 300).replace(/\s+/g, ' ')
  const line = `${new Date().toISOString()}  ${event}\n`
  try {
    appendFileSync(join(process.cwd(), 'failover.log'), line)
  } catch (err) {
    console.error('[system/log] write failed:', err)
  }
  return NextResponse.json({ ok: true })
}

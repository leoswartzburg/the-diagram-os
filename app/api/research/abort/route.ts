import { NextRequest } from 'next/server'
import { requestAbort, requestWindDown } from '@/lib/researchLock'

// Research run controls. The pipeline polls these between steps.
//   signal:'stop'     (default) — IMMEDIATE halt. Aborts in-flight calls; saves the raw findings
//                                 collected so far with NO synthesis. Fastest possible exit.
//   signal:'winddown'           — GRACEFUL exit. The current agent round finishes, no new agents
//                                 spawn, and the run goes straight to a FULL synthesis. This is how
//                                 you cleanly exit Exhaustive mode once you've seen enough.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  let body: { sessionId?: string; signal?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  const sessionId = String(body.sessionId ?? '').trim()
  if (!sessionId) return Response.json({ ok: false, error: 'sessionId required' }, { status: 400 })
  const signal = body.signal === 'winddown' ? 'winddown' : 'stop'
  const found = signal === 'winddown' ? requestWindDown(sessionId) : requestAbort(sessionId)
  return Response.json({ ok: true, signal, found })
}

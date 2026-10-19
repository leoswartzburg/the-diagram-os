import { NextRequest, NextResponse } from 'next/server'
import { promisify } from 'util'
import { exec as _exec } from 'child_process'
import { isAuthorizedSystemRequest, validToken } from '@/lib/systemAuth'

export const dynamic = 'force-dynamic'
const exec = promisify(_exec)

// POST { action: 'start' | 'stop' | 'status', container: string }
// Used by the voice failover to bring the Chatterbox TTS container online.
export async function POST(req: NextRequest) {
  if (!isAuthorizedSystemRequest(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const action: string = body?.action
  const container = body?.container
  if (!validToken(container)) {
    return NextResponse.json({ error: 'invalid container' }, { status: 400 })
  }

  try {
    if (action === 'start') {
      const { stderr } = await exec(`docker start ${container}`)
      return NextResponse.json({ ok: true, stderr: stderr || undefined })
    }
    if (action === 'stop') {
      await exec(`docker stop ${container}`)
      return NextResponse.json({ ok: true })
    }
    if (action === 'status') {
      const { stdout } = await exec(`docker inspect -f "{{.State.Running}}" ${container}`)
      return NextResponse.json({ ok: true, running: stdout.trim() === 'true' })
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (err) {
    // Surface the failure as JSON (not a 500) so the client orchestration can branch.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[system/docker] ${action} ${container} failed:`, msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 200 })
  }
}

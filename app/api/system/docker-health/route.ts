import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedSystemRequest } from '@/lib/systemAuth'

export const dynamic = 'force-dynamic'

const CHATTERBOX_URL = process.env.CHATTERBOX_URL || 'http://localhost:8004'

// GET — is the local TTS engine reachable? Probes Chatterbox (:8004); the
// /api/tts LOCAL chain serves from it when up. Any HTTP response (even 404)
// means the server is listening → reachable. Connection refusal / timeout → not.
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2500), cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedSystemRequest(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const chatterbox = await reachable(`${CHATTERBOX_URL}/`)
  return NextResponse.json({ healthy: chatterbox, chatterbox })
}

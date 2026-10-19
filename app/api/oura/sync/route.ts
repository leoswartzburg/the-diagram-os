import { NextResponse } from 'next/server'
import { isConnected, buildSnapshot, getCachedSnapshot } from '@/lib/oura'

export const dynamic = 'force-dynamic'

// GET — force a fresh pull from Oura (daily_sleep + daily_readiness + sleep
// periods), store it to the cache, and return it. Polled by the client every
// 10 min between 7–11am (when Oura's cloud refreshes after a morning ring sync).
// On failure, returns the last cached snapshot so the UI can keep showing data.
//   - auth_expired → the refresh token is dead; the client shows "Reconnect".
//   - sync_failed  → a transient API error; the client shows a "Sync failed" note.
export async function GET() {
  if (!isConnected()) {
    return NextResponse.json({ connected: false, data: getCachedSnapshot(), error: 'not_connected' })
  }
  try {
    return NextResponse.json({ connected: true, data: await buildSnapshot() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const authExpired = msg.includes('AUTH_EXPIRED') || msg.includes('NOT_CONNECTED')
    console.error('[Oura] sync failed:', msg)
    return NextResponse.json(
      { connected: !authExpired, data: getCachedSnapshot(), error: authExpired ? 'auth_expired' : 'sync_failed' },
      { status: authExpired ? 401 : 502 },
    )
  }
}

import { NextResponse } from 'next/server'
import { isConnected, getCachedSnapshot, buildSnapshot, disconnect } from '@/lib/oura'

export const dynamic = 'force-dynamic'

// GET — return the cached snapshot WITHOUT hitting the Oura API (cheap; the client
// polls this on every load). Returns {connected,data}; data is null when not
// connected so the UI can show the connect CTA. The only exception: if connected
// but no cache exists yet (first-ever load), build one so something renders —
// fresh pulls otherwise go through GET /api/oura/sync (7–11am poll / webhook).
export async function GET() {
  if (!isConnected()) return NextResponse.json({ connected: false, data: null })
  let data = getCachedSnapshot()
  if (!data) {
    try {
      data = await buildSnapshot()
    } catch (err) {
      console.error('[Oura] initial build failed:', err)
      // Distinguish a revoked/expired token from a transient failure so the UI shows the
      // Reconnect CTA instead of a silently-empty Body panel (same as the sync route).
      const msg = err instanceof Error ? err.message : String(err)
      if (/AUTH_EXPIRED|NOT_CONNECTED/.test(msg)) {
        return NextResponse.json({ connected: false, data: null, error: 'auth_expired' })
      }
      return NextResponse.json({ connected: true, data: null, error: 'sync_failed' })
    }
  }
  return NextResponse.json({ connected: true, data })
}

// DELETE — disconnect (removes the local token + cache).
export async function DELETE() {
  disconnect()
  return NextResponse.json({ connected: false })
}

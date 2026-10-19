import { NextRequest, NextResponse } from 'next/server'
import { getVerificationToken, verifyHmac, buildSnapshot, isConnected } from '@/lib/oura'

export const dynamic = 'force-dynamic'

// GET — Oura subscription verification handshake. Oura calls this with
// ?verification_token=…&challenge=… when a subscription is created; echo the
// challenge back (200) only if the token matches the one we registered.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const token = url.searchParams.get('verification_token')
  const challenge = url.searchParams.get('challenge')
  if (token && challenge && token === getVerificationToken()) {
    return NextResponse.json({ challenge })
  }
  return NextResponse.json({ error: 'invalid verification token' }, { status: 403 })
}

// POST — event notification (~30s after ring sync). Verify HMAC if present, then
// refresh the server cache from the freshly-synced data. Returns 200 fast.
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('x-oura-signature') || req.headers.get('x-signature')
  if (!verifyHmac(raw, sig)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }
  if (isConnected()) buildSnapshot().catch(err => console.error('[Oura] webhook resync failed:', err))
  return NextResponse.json({ ok: true })
}

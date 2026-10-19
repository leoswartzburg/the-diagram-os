import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getAuthUrl } from '@/lib/oura'

export const dynamic = 'force-dynamic'

// Origin-derived redirect URI so the same code works on localhost + Funnel.
// Both must be registered on the Oura application.
function originFromReq(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function GET(req: NextRequest) {
  const redirectUri = `${originFromReq(req)}/api/oura/callback`
  const state = randomBytes(16).toString('hex')
  const res = NextResponse.redirect(getAuthUrl(redirectUri, state))
  res.cookies.set('oura_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600, path: '/' })
  return res
}

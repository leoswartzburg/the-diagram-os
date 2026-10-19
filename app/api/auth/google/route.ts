import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getAuthUrl } from '@/lib/gcal'

export const dynamic = 'force-dynamic'

// Derive the app origin from the proxied request so the same callback works on
// both localhost and the Tailscale funnel. Both must be registered in Google
// Cloud Console as Authorized redirect URIs.
function originFromReq(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function GET(req: NextRequest) {
  const redirectUri = `${originFromReq(req)}/api/auth/callback`
  const state = randomBytes(16).toString('hex')
  const authUrl = `${getAuthUrl(redirectUri)}&state=${state}`

  const res = NextResponse.redirect(authUrl)
  // Short-lived CSRF state — validated in the callback.
  res.cookies.set('gcal_oauth_state', state, {
    httpOnly: true, sameSite: 'lax', maxAge: 600, path: '/',
  })
  return res
}

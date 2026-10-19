import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode } from '@/lib/gcal'

export const dynamic = 'force-dynamic'

function originFromReq(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookieState = req.cookies.get('gcal_oauth_state')?.value
  const appOrigin = originFromReq(req)

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(`${appOrigin}/?gcal=error`)
  }

  try {
    // redirect_uri must exactly match the one used to start the flow.
    await exchangeCode(code, `${appOrigin}/api/auth/callback`)
  } catch (err) {
    console.error('[GCal] token exchange failed:', err)
    return NextResponse.redirect(`${appOrigin}/?gcal=error`)
  }

  const res = NextResponse.redirect(`${appOrigin}/?gcal=connected`)
  res.cookies.delete('gcal_oauth_state')
  return res
}

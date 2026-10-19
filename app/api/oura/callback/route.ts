import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode, buildSnapshot, ensureSubscriptions } from '@/lib/oura'

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
  const cookieState = req.cookies.get('oura_oauth_state')?.value
  const appOrigin = originFromReq(req)

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(`${appOrigin}/?oura=error`)
  }

  try {
    await exchangeCode(code, `${appOrigin}/api/oura/callback`)
  } catch (err) {
    console.error('[Oura] token exchange failed:', err)
    return NextResponse.redirect(`${appOrigin}/?oura=error`)
  }

  // Build today's snapshot now so data is ready on redirect.
  try { await buildSnapshot() } catch (err) { console.error('[Oura] initial snapshot failed:', err) }
  // Webhook registration is slower — fire and forget.
  const webhookUrl = process.env.OURA_WEBHOOK_URL || `${appOrigin}/api/oura/webhook`
  ensureSubscriptions(webhookUrl).catch(err => console.error('[Oura] webhook subscribe failed:', err))

  const res = NextResponse.redirect(`${appOrigin}/?oura=connected`)
  res.cookies.delete('oura_oauth_state')
  return res
}

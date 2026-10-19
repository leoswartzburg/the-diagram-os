// Focus sessions — the deep-work timer (click into deep focus, record how long,
// rename per subject). One open session at a time, server-authoritative
// so the clock survives reloads and follows the user across devices.
import { NextResponse } from 'next/server'
import { getOpenFocus, startFocus, stopFocus, renameOpenFocus, listFocusSince } from '@/lib/conversations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function dayPayload(dayStart: Date) {
  const startMs = dayStart.getTime()
  const endMs = startMs + 86_400_000
  const now = Date.now()
  const sessions = listFocusSince(startMs).filter(s => s.started_at < endMs)
  const totalMs = sessions.reduce((acc, s) => acc + Math.max(0, Math.min(s.ended_at ?? now, endMs) - Math.max(s.started_at, startMs)), 0)
  return { open: getOpenFocus() ?? null, sessions, today_total_ms: totalMs }
}

// GET /api/focus            → today (open session + sessions + total)
// GET /api/focus?date=YYYY-MM-DD → that day's landed sessions (the calendar day view)
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get('date')
    const dayStart = date ? new Date(`${date}T00:00:00`) : new Date()
    if (!date) dayStart.setHours(0, 0, 0, 0)
    if (Number.isNaN(dayStart.getTime())) return NextResponse.json({ open: null, sessions: [], today_total_ms: 0 })
    return NextResponse.json(dayPayload(dayStart))
  } catch (err) {
    return NextResponse.json({ open: null, sessions: [], today_total_ms: 0, error: err instanceof Error ? err.message : 'failed' })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const op = String(body.op || '')
    if (op === 'start') startFocus(String(body.label || 'Deep work'), body.task_id ? String(body.task_id) : '')
    else if (op === 'stop') stopFocus()
    else if (op === 'rename') renameOpenFocus(String(body.label || 'Deep work'))
    else return NextResponse.json({ error: 'unknown op' }, { status: 400 })
    const d = new Date(); d.setHours(0, 0, 0, 0)
    return NextResponse.json(dayPayload(d))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

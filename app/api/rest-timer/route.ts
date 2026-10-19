// Rest-timer push: when a rest timer fires, your phone gets the "next set"
// notification — precisely, via an in-process setTimeout (the 60s notify tick is too
// coarse for 90–180s rests). One timer at a time (single lifter); starting a new one
// replaces the old. Best-effort by design: if push isn't configured or the process
// restarts mid-rest, the in-app beep/GO still fires client-side from the absolute endsAt.
import { NextResponse } from 'next/server'
import { sendPush, isPushConfigured } from '@/lib/push'

export const runtime = 'nodejs'

const g = globalThis as unknown as { __restTimer?: ReturnType<typeof setTimeout> }

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const seconds = Math.min(3600, Math.max(5, Math.round(Number(body.seconds) || 0)))
    const label = String(body.label || 'Next set').slice(0, 80)
    if (g.__restTimer) { clearTimeout(g.__restTimer); g.__restTimer = undefined }
    if (isPushConfigured()) {
      g.__restTimer = setTimeout(() => {
        g.__restTimer = undefined
        void sendPush({ title: 'Rest over — go', body: `${label}. Next set starts now.`, url: '/', tag: 'rest-timer' })
      }, seconds * 1000)
    }
    return NextResponse.json({ ok: true, ends_at: Date.now() + seconds * 1000, push: isPushConfigured() })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function DELETE() {
  if (g.__restTimer) { clearTimeout(g.__restTimer); g.__restTimer = undefined }
  return NextResponse.json({ ok: true })
}

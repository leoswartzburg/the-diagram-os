// Habits — deterministic tracker. GET returns habits + the last
// 42 days of checks + derived streaks (nothing stored that can drift); POST mutates.
import { NextResponse } from 'next/server'
import { listHabits, createHabit, archiveHabit, setHabitCheck, listHabitChecks } from '@/lib/conversations'
import { syncAutoHabitChecks } from '@/lib/habitAuto'
import { localDateStr } from '@/lib/nowList'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function streaks(habits: { id: string }[], checks: { habit_id: string; date: string }[]): Record<string, number> {
  const byHabit = new Map<string, Set<string>>()
  for (const c of checks) {
    if (!byHabit.has(c.habit_id)) byHabit.set(c.habit_id, new Set())
    byHabit.get(c.habit_id)!.add(c.date)
  }
  const out: Record<string, number> = {}
  for (const h of habits) {
    const set = byHabit.get(h.id) ?? new Set<string>()
    let d = new Date()
    // Today unchecked doesn't break the streak — it just hasn't happened yet.
    if (!set.has(localDateStr(d.getTime()))) d = new Date(d.getTime() - 86_400_000)
    let n = 0
    while (set.has(localDateStr(d.getTime()))) { n += 1; d = new Date(d.getTime() - 86_400_000) }
    out[h.id] = n
  }
  return out
}

export async function GET() {
  try {
    syncAutoHabitChecks()   // gym + asleep-by tick themselves (throttled internally)
    const habits = listHabits()
    const since = localDateStr(Date.now() - 42 * 86_400_000)
    const checks = listHabitChecks(since)
    return NextResponse.json({ habits, checks, streaks: streaks(habits, checks) })
  } catch (err) {
    return NextResponse.json({ habits: [], checks: [], streaks: {}, error: err instanceof Error ? err.message : 'failed' })
  }
}

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const op = String(body.op || '')
    if (op === 'create') return NextResponse.json({ habit: createHabit(String(body.name || ''), Number(body.target_per_week) || 7) })
    if (op === 'archive') { archiveHabit(String(body.id || '')); return NextResponse.json({ ok: true }) }
    if (op === 'check' || op === 'uncheck') {
      const date = body.date ? String(body.date) : localDateStr(Date.now())
      setHabitCheck(String(body.id || ''), date, op === 'check')
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'unknown op' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

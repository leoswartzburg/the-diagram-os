// Auto-checked habits (weave item 2) — the system already KNOWS some truths, so those
// habits tick themselves and the user only hand-checks what only they can know (walk,
// reading, …). Zero-friction truth instead of self-reporting:
//   · habit-gym   — a workout in workouts.json that's completed (or has real sets logged)
//   · habit-sleep — Oura's bedtime_start vs the rhythm's asleep-by anchor (cached snapshot
//     only; never a network call from here). Sleep is dated by WAKE day; the bedtime belongs
//     to the previous evening, so an evening bedtime before the anchor checks THAT calendar
//     date, and an after-midnight bedtime checks nothing (it's past the anchor by definition).
// Materialized via INSERT OR IGNORE into the same habit_checks rows as manual taps —
// idempotent, and a re-run never duplicates. Self-catching; throttled to ~30 min.
import { setHabitCheck } from './conversations'
import { localDateStr } from './nowList'
import { readStore } from './workouts'
import { getCachedSnapshot } from './oura'
import { rhythmBounds } from './rhythm'

let _lastRun = 0

export function syncAutoHabitChecks(): void {
  if (Date.now() - _lastRun < 30 * 60_000) return
  _lastRun = Date.now()
  try {
    const workouts = readStore().workouts
    for (let i = 0; i < 7; i++) {
      const date = localDateStr(Date.now() - i * 86_400_000)
      const w = workouts[date]
      if (w && (w.completed || w.blocks?.some(b => b.sets?.some(s => s.done)))) {
        setHabitCheck('habit-gym', date, true)
      }
    }
  } catch (e) {
    console.warn('[habits] gym auto-check failed:', (e as Error).message)
  }
  try {
    const snap = getCachedSnapshot()
    const asleepBy = rhythmBounds().asleepBy   // minutes-of-day (e.g. 1380 = 23:00)
    for (const d of snap?.days ?? []) {
      const bt = d.bedtime_start
      if (!bt) continue
      const b = new Date(bt)
      if (Number.isNaN(b.getTime())) continue
      const m = b.getHours() * 60 + b.getMinutes()
      // Evening bedtimes only (≥17:00) at or before the anchor → check that evening's date.
      if (m >= 17 * 60 && m <= asleepBy) setHabitCheck('habit-sleep', localDateStr(b.getTime()), true)
    }
  } catch (e) {
    console.warn('[habits] sleep auto-check failed:', (e as Error).message)
  }
}

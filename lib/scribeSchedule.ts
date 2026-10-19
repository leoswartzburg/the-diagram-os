// Scribe's autonomous heartbeat. The chronicle is one chapter per day, but it should grow as the
// day unfolds — so a server-side scheduler regenerates today's chapter at set checkpoints
// (morning / afternoon / night), incorporating everything new since the last pass. It runs in the
// Next server process (started from instrumentation.ts), so it fires even when no browser is open,
// as long as the dev server is up. generateScribeDay is hash-guarded, so a checkpoint with no new
// material costs no model call; and it runs on the local model, so the heartbeat is effectively free.
//
// Times are the SERVER's local hours (the host where the data lives), configurable via env:
//   SCRIBE_MORNING_HOUR (10) · SCRIBE_AFTERNOON_HOUR (13) · SCRIBE_NIGHT_HOUR (22)
import { generateScribeDay, generateQuoteOfDay, localDateStr } from './scribe'
import { advanceWord } from './vocab'

const MORNING = clampHour(process.env.SCRIBE_MORNING_HOUR, 10)
const AFTERNOON = clampHour(process.env.SCRIBE_AFTERNOON_HOUR, 13)
const NIGHT = clampHour(process.env.SCRIBE_NIGHT_HOUR, 22)

function clampHour(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : dflt
}

let started = false
let lastSeenDate = ''
const firedToday = new Set<string>()  // checkpoint keys already run for lastSeenDate

async function tick(): Promise<void> {
  try {
    const now = new Date()
    const date = localDateStr(now)

    // Day rolled over → lock yesterday's chapter (autonomous finalize, even if the app was never
    // opened), then start a fresh checkpoint set for the new day.
    if (date !== lastSeenDate) {
      if (lastSeenDate) await generateScribeDay(lastSeenDate, { finalize: true }).catch(() => {})
      lastSeenDate = date
      firedToday.clear()
    }

    const hour = now.getHours()
    const checkpoints: { key: string; hour: number }[] = [
      { key: 'morning', hour: MORNING },
      { key: 'afternoon', hour: AFTERNOON },
      { key: 'night', hour: NIGHT },
    ]
    for (const cp of checkpoints) {
      // Fire once when its hour has arrived. A checkpoint passed before the server started fires
      // on the first tick (catch-up); the hash-guard makes a redundant re-fire a no-op.
      if (hour >= cp.hour && !firedToday.has(cp.key)) {
        firedToday.add(cp.key)
        console.log(`[Scribe] scheduled ${cp.key} update for ${date}`)
        await generateScribeDay(date, { finalize: false }).catch(err =>
          console.warn('[Scribe] scheduled update failed:', err instanceof Error ? err.message : String(err)))
        // Word of the day rotates twice daily — morning + night checkpoints only (not afternoon).
        if (cp.key === 'morning' || cp.key === 'night') { try { advanceWord() } catch { /* non-fatal */ } }
      }
    }

    // Morning-or-later: set today's quote of the day (from yesterday's chapter). Idempotent —
    // once per day. Fires on the first tick at/after the morning hour, incl. a post-morning boot.
    if (hour >= MORNING) await generateQuoteOfDay(date).catch(() => {})
  } catch (err) {
    console.warn('[Scribe] scheduler tick error (ignored):', err instanceof Error ? err.message : String(err))
  }
}

// Start the once-per-minute heartbeat. Idempotent — safe to call more than once.
export function startScribeScheduler(): void {
  if (started) return
  started = true
  console.log(`[Scribe] scheduler started — chapter updates at ${MORNING}:00, ${AFTERNOON}:00, ${NIGHT}:00 (server local time)`)
  setInterval(() => { void tick() }, 60_000)
  void tick()   // run once at startup so a past-due checkpoint catches up immediately
}

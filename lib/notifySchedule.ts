// The notification scheduler — Spectre reaching the user's phone. A 60s
// server-side heartbeat (registered in instrumentation.ts, runs even with no browser open)
// that evaluates the SAME reality the NOW list derives from and pushes at real boundaries only:
//   · due reminder    — a timed task's due moment arrives, still unchecked
//   · block-end nudge  — a linked calendar block ends with unchecked assigned tasks (§7)
//   · rhythm triggers  — the temporal spine (lib/rhythm.ts): the soft cue 15 min before
//                        wind-down, the wind-down call, and the wake push (which absorbed the
//                        old morning digest — ONE coherent morning ping at the wake anchor).
// Rhythm quiet hours: after wind-down begins, task nudges (due/block-end) are suppressed
// until wake — the wind-down is the terminal notification of the day. Spectre's own
// explicit reminders still fire (the user asked for those by name).
// Rhythm triggers use a bounded grace window (fire ≤10 min late after a slow boot, never
// hours late) — the scribeSchedule catch-up semantics are wrong for announcements.
// Every send is keyed through markNotified() so nothing double-fires. All self-catching — a
// dead push service / DB hiccup never crashes the heartbeat. Delivery is via lib/push.ts.
import { listTasks, listBlocks, markNotified, dueReminders, markReminderFired, addInboxEvent, type TaskRow } from './conversations'
import { localDateStr } from './nowList'
import { sendPush, isPushConfigured } from './push'
import { rhythmTimes, rhythmPhase, todayShape, windDownLine } from './rhythm'
import { generateMorningNews } from './news'
import { syncAutoHabitChecks } from './habitAuto'
import { createEvent } from './gcal'

const TICK_MS = 60_000
const WINDOW_MS = 90_000   // catch events whose moment fell within the last tick (+slack)
const RHYTHM_GRACE_MS = 10 * 60_000   // evening announcements may fire up to 10 min late, never more
// The wake push is different: the host machine may be OFF overnight (shut down after
// wind-down), so at the wake anchor there may be no server to send it. The fix: the moment the
// system comes on, fire the morning message. So wake gets a long catch-up window — a boot a
// couple of hours after wake still gets ONE morning push (deduped per day); past noon-ish it
// stays silent (a "morning" ping at 3pm is noise).
const WAKE_CATCHUP_MS = 5 * 60 * 60_000

function isTimed(due: string | null): boolean { return !!due && due.includes('T') }

let _started = false

async function tick(): Promise<void> {
  const now = Date.now()
  // The morning read compiles once the machine is on after wake — independent of push
  // (self-guarded: no-op when today's read exists / a compile is in flight / cooling down).
  try {
    const tw = rhythmTimes(new Date(now)).wake.getTime()
    if (now >= tw && now < tw + WAKE_CATCHUP_MS) void generateMorningNews()
  } catch { /* never blocks the tick */ }
  // Auto-checked habits (weave item 2) — gym from the workout log, asleep-by from Oura.
  // Self-throttled (~30 min) and independent of push.
  try { syncAutoHabitChecks() } catch { /* never blocks the tick */ }
  if (!isPushConfigured()) return
  try {
    const openTasks = listTasks(undefined)   // all todo, non-archived, non-dropped
    const phase = rhythmPhase(new Date(now))
    const quiet = phase === 'winddown' || phase === 'night'   // no task guilt after wind-down

    // 0. Spectre's own reminders — the proactive check-ins it set. Fire as a push in Spectre's
    //    voice, then mark fired so it never repeats. Explicit asks fire even in quiet hours.
    for (const r of dueReminders(now, WINDOW_MS)) {
      markReminderFired(r.id)
      await sendPush({ title: 'Spectre', body: r.message, url: '/', tag: `reminder-${r.id}` })
      addInboxEvent({ kind: 'reminder', title: 'Spectre check-in', body: r.message })
    }

    // R. Rhythm triggers — the temporal spine's boundaries for today.
    const t = rhythmTimes(new Date(now))
    const today = localDateStr(now)
    const inGrace = (d: Date) => d.getTime() <= now && now < d.getTime() + RHYTHM_GRACE_MS
    if (inGrace(t.softCue) && markNotified(`rhythm:softcue:${today}`)) {
      await sendPush({ title: 'Wind-down in 15', body: 'Find your landing spot — a stopping point you choose.', url: '/', tag: 'rhythm-softcue' })
    }
    if (inGrace(t.windDown) && markNotified(`rhythm:winddown:${today}`)) {
      const line = windDownLine(new Date(now))
      await sendPush({ title: 'Wind-down', body: line, url: '/', tag: 'rhythm-winddown', requireInteraction: true })
      addInboxEvent({ kind: 'rhythm', title: 'Wind-down', body: line })
    }
    const wakeMs = t.wake.getTime()
    if (wakeMs <= now && now < wakeMs + WAKE_CATCHUP_MS && markNotified(`rhythm:wake:${today}`)) {
      // The one morning ping: feet on the floor, then the day's shape + digest bits + the
      // nearest North Star milestone. (Absorbs the old NOTIFY_MORNING_HOUR digest — never two
      // morning pushes an hour apart.) Long catch-up window: if the machine was off overnight,
      // the boot IS the trigger.
      const dueToday = openTasks.filter((tk: TaskRow) => tk.due_at && (isTimed(tk.due_at) ? localDateStr(new Date(tk.due_at).getTime()) === today : tk.due_at === today))
      const projectNext = openTasks.filter((tk: TaskRow) => tk.node_id && tk.step !== null).length
      const bits: string[] = []
      if (dueToday.length) bits.push(`${dueToday.length} due today`)
      if (projectNext) bits.push(`${projectNext} on the maps`)
      // Nearest dated North Star step within 45 days — deadlines live where the day starts.
      const nextMilestone = openTasks
        .filter((tk: TaskRow) => tk.node_id === 'north-star' && tk.due_at)
        .map((tk: TaskRow) => ({ tk, days: Math.ceil((new Date(`${String(tk.due_at).slice(0, 10)}T23:59:59`).getTime() - now) / 86_400_000) }))
        .filter(x => x.days >= 0 && x.days <= 45)
        .sort((a, b) => a.days - b.days)[0]
      const shape = todayShape(new Date(now))
      const morningBody = `Good morning — feet on the floor.${shape ? ` ${shape}` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}${nextMilestone ? ` · ${nextMilestone.days}d to ${nextMilestone.tk.title}` : ''}`
      await sendPush({ title: 'Morning', body: morningBody, url: '/', tag: 'rhythm-wake' })
      addInboxEvent({ kind: 'rhythm', title: 'Morning', body: morningBody })
    }

    // Weekly review (weave item 8) — Sunday 16:00, cold state: the North Star walk.
    const nowD = new Date(now)
    if (nowD.getDay() === 0) {
      const review = new Date(nowD); review.setHours(16, 0, 0, 0)
      if (inGrace(review) && markNotified(`review:${today}`)) {
        const line = 'Cold-state review: open the North Star map — what moved this week, and what is next week’s one big rock?'
        await sendPush({ title: 'Weekly review', body: line, url: '/', tag: 'weekly-review' })
        addInboxEvent({ kind: 'review', title: 'Weekly review', body: line })
      }
    }

    // Milestones land on the real calendar (weave item 4) — one all-day event per dated
    // North Star step, once per (task, date). Mark-first so a persistently failing gcal
    // can never spam duplicates; a failure is logged loudly instead.
    for (const tk of openTasks) {
      if (tk.node_id !== 'north-star' || !tk.due_at) continue
      const day = String(tk.due_at).slice(0, 10)
      if (markNotified(`nsmcal:${tk.id}:${day}`)) {
        try {
          await createEvent({ title: `★ ${tk.title}`, start: day, end: day, allDay: true })
          addInboxEvent({ kind: 'north-star', title: 'Milestone on the calendar', body: `${tk.title} — ${day}` })
        } catch (e) {
          console.warn('[notify] milestone → calendar failed:', (e as Error).message)
        }
      }
    }

    // 1. Due reminders — a timed due that arrived within the last window. Quiet after wind-down.
    if (!quiet) {
      for (const tk of openTasks) {
        if (!isTimed(tk.due_at)) continue
        const dueMs = new Date(tk.due_at as string).getTime()
        if (!Number.isFinite(dueMs)) continue
        if (dueMs <= now && dueMs > now - WINDOW_MS) {
          if (markNotified(`due:${tk.id}:${tk.due_at}`)) {
            await sendPush({ title: 'Task due now', body: tk.title, url: '/', tag: `due-${tk.id}` })
          }
        }
      }
    }

    // 2. Block-end nudge — a linked block that ended within the last window with unchecked work.
    //    Quiet after wind-down: a work block ending just after wind-down must not fire guilt into it.
    if (!quiet) {
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
      const blocks = listBlocks(dayStart.getTime(), now + 60_000)
      for (const b of blocks) {
        if (b.end_at <= now && b.end_at > now - WINDOW_MS) {
          const left = openTasks.filter(tk => tk.block_event_id === b.event_id)
          if (left.length && markNotified(`blockend:${b.event_id}`)) {
            const names = left.slice(0, 3).map(tk => tk.title).join(', ')
            await sendPush({
              title: `${b.title || 'Time block'} ended`,
              body: left.length === 1 ? `Still on: ${names}?` : `${left.length} unchecked: ${names}${left.length > 3 ? '…' : ''}`,
              url: '/', tag: `blockend-${b.event_id}`, requireInteraction: true,
            })
          }
        }
      }
    }
  } catch (e) {
    console.warn('[notify] tick failed:', (e as Error).message)
  }
}

export function startNotifyScheduler(): void {
  if (_started) return
  _started = true
  // Small delay so startup (vault/scribe) settles first; then every minute.
  setTimeout(() => { void tick(); setInterval(() => { void tick() }, TICK_MS) }, 15_000)
  console.log('[notify] scheduler started (rhythm triggers: soft cue · wind-down · wake)')
}

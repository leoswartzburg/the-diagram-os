// Rhythm — the temporal spine. Pure and importable client + server (the nowList
// precedent): the ANCHORS below are the ONLY stored values — everything else derives,
// so changing `wake` cascades through the whole system ("one value shifts everything").
// v1 keeps the anchors as code constants; a config row + settings UI is the natural
// upgrade.
//
// ─────────────────────────────────────────────────────────────────────────────
// EDIT THESE TO MATCH YOUR LIFE. The values below are generic DEFAULTS, not
// recommendations: set your real wake time, how much sleep you need, and how long
// your wind-down runs. The wind-down cue, the night quiet hours, the wake push and
// Spectre's time-of-day stance all derive from them.
// ─────────────────────────────────────────────────────────────────────────────

export type RhythmAnchors = {
  wake: string        // 'HH:MM' 24h — THE physiological anchor (fixed wake + morning light)
  sleepHours: number
  windDownLen: number // minutes — the wind-down window, separated from work; long enough to get ready for bed AND fall asleep, counted back from asleepBy
}

export const ANCHORS: RhythmAnchors = {
  wake: '07:00',       // default — edit to your wake time
  sleepHours: 8,       // default — asleep-by = wake − sleepHours
  windDownLen: 60,     // default — wind-down begins this many minutes before asleep-by
}

export type RhythmPhase = 'morning' | 'day' | 'evening' | 'winddown' | 'night'

const DAY_MIN = 24 * 60

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return ((h || 0) * 60 + (m || 0)) % DAY_MIN
}

function fmt(min: number): string {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN
  const h24 = Math.floor(m / 60), mm = m % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(mm).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`
}

// Circular "is minute-of-day m inside [start, end)" — handles windows that wrap midnight.
function inWindow(m: number, start: number, end: number): boolean {
  if (start === end) return false
  return start < end ? m >= start && m < end : m >= start || m < end
}

// The derived boundaries, as minutes-of-day. asleepBy = wake − sleepHours (mod 24).
export function rhythmBounds(a: RhythmAnchors = ANCHORS) {
  const wake = minutesOf(a.wake)
  const asleepBy = (wake - a.sleepHours * 60 + DAY_MIN) % DAY_MIN
  const windDownAt = (asleepBy - a.windDownLen + DAY_MIN) % DAY_MIN
  const softCueAt = (windDownAt - 15 + DAY_MIN) % DAY_MIN
  return { wake, asleepBy, windDownAt, softCueAt }
}

// Boundary moments for a given calendar day (local time) — what the notify scheduler and
// the client timer both key off. Each is the Date on `day` at that minute-of-day.
export function rhythmTimes(day: Date, a: RhythmAnchors = ANCHORS): {
  softCue: Date; windDown: Date; asleepBy: Date; wake: Date
} {
  const b = rhythmBounds(a)
  const at = (min: number) => {
    const d = new Date(day)
    d.setHours(Math.floor(min / 60), min % 60, 0, 0)
    return d
  }
  return { softCue: at(b.softCueAt), windDown: at(b.windDownAt), asleepBy: at(b.asleepBy), wake: at(b.wake) }
}

export function rhythmPhase(now: Date, a: RhythmAnchors = ANCHORS): RhythmPhase {
  const b = rhythmBounds(a)
  const m = now.getHours() * 60 + now.getMinutes()
  if (inWindow(m, b.asleepBy, b.wake)) return 'night'
  if (inWindow(m, b.windDownAt, b.asleepBy)) return 'winddown'
  if (inWindow(m, b.wake, Math.min(b.wake + 180, DAY_MIN - 1))) return 'morning'
  if (inWindow(m, 18 * 60, b.windDownAt)) return 'evening'
  return 'day'
}

// The shape of each weekday (0 = Sunday … 6 = Saturday) — a one-line summary of your
// fixed commitments that Spectre and the wake push read. EDIT THESE: describe your real
// week (classes, work blocks, training, protected time). A generic default is below;
// return '' for a day to leave it unshaped. Calendar-backed editing comes with the
// anchors UI.
const WEEK_SHAPE: Record<number, string> = {
  1: 'workday — morning routine → focused work block → evening winds down',
  2: 'workday — morning routine → focused work block → evening winds down',
  3: 'workday — morning routine → focused work block → evening winds down',
  4: 'workday — morning routine → focused work block → evening winds down',
  5: 'workday — morning routine → focused work block → evening winds down',
  6: 'weekend — rest, errands, people. Protected.',
  0: 'weekend — light day; rest and reset for the week',
}

export function todayShape(now: Date): string {
  return WEEK_SHAPE[now.getDay()] ?? ''
}

// Standing day rules Spectre applies when planning around the rhythm. Edit to taste.
const DAY_RULES = 'on a compressed morning, shorten things rather than skip them; protect sleep and fixed commitments first.'

// The one-line rhythm block for Spectre's context. Changes only when the phase or the
// day changes — cache-friendly. During wind-down/night it carries the protective stance.
export function rhythmContextLine(now: Date, a: RhythmAnchors = ANCHORS): string {
  const b = rhythmBounds(a)
  const phase = rhythmPhase(now, a)
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const shape = todayShape(now)
  const base = `[RHYTHM] Phase: ${phase}. Today (${weekday})${shape ? `: ${shape}` : ''}. Boundaries: wind-down ${fmt(b.windDownAt)} → asleep by ${fmt(b.asleepBy)} → wake ${fmt(b.wake)}. Rules: ${DAY_RULES}`
  if (phase === 'winddown' || phase === 'night') {
    return `${base}\nIt is ${phase === 'night' ? 'past bedtime' : 'wind-down'}: be calm and brief, protect sleep, never open new work — anything unfinished goes on tomorrow's list. If late-night overthinking starts, contain it (≤10 min, grounding, one counter at most), give it a home tomorrow, and land softly. Never answer a "will any of this even matter" thought with an accomplishments list.`
  }
  return base
}

// Rotating wind-down announce lines — a byte-identical nightly script habituates fastest.
// Deliberately time-free so they stay correct whatever the anchors are set to.
export const WIND_DOWN_LINES = [
  'Wind-down time. Close the day — the unfinished thing goes on tomorrow’s list, not on tonight.',
  'Time to wind down. Whatever it is, it will still be good tomorrow. Land it and come down.',
  'Wind-down. The work is done being worked on. This time is yours.',
  'Time to wind down. Save it, stand up, shake it off. Tomorrow-you takes it from here.',
  'Wind-down time — close the loops, then go be a person for a while.',
]

export function windDownLine(now: Date): string {
  return WIND_DOWN_LINES[now.getDate() % WIND_DOWN_LINES.length]
}

// Scribe — the chronicler. Turns a real day (chat + events) into a third-person,
// hero-of-their-own-story chapter. Server-only. The principle: elevate the framing as much as
// it wants, but NEVER invent or inflate a fact — every concrete claim must trace to the source.
// Self-catching: every public fn returns null/no-ops on failure and never throws into a request.
import Anthropic from '@anthropic-ai/sdk'
import {
  getDayMessages, getScribeEntry, listScribeEntries, upsertScribeEntry,
  finalizeScribeEntry, getQuoteOfDay, setQuoteOfDay, type ScribeEntryRow,
  listFocusSince, listHabitChecks, listHabits,
} from './conversations'
import { readStore } from './workouts'
import { isConnected as gcalConnected, listEvents } from './gcal'
import { USER, USER_CAP, USER_POSS, USER_NAME } from './profile'

// Speaker label for the user's turns in the daily bank.
const USER_LABEL = USER_NAME || 'User'

// Writer: Claude HAIKU is PRIMARY — it follows the strict "chronicle only what the conversations
// actually say, invent nothing" rule far better than the local model (gpt-oss was inventing places
// and actions the user never did), and it's cheap + good at short prose. Local gpt-oss stays as a
// down-fallback so a chapter still gets written if Anthropic is unreachable.
const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
const LOCAL_MODEL = 'gpt-oss-20b'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const PER_TURN_CHARS = 520        // trim each chat turn fed to the narrator
const SOURCE_BUDGET_CHARS = 42000 // total daily-bank budget (keep the most recent if over)
const RECENT_CHAPTERS = 7         // "the story so far" context threaded into each chapter

let _client: Anthropic | null = null
function client(): Anthropic { return _client ?? (_client = new Anthropic()) }

// Narrate on the local model (llama-server, non-streaming). Returns null on any failure → Claude
// fallback. low effort for live chapters (fast/cheap), medium for the nightly finalize (richer).
async function narrateLocal(system: string, user: string, effort: 'low' | 'medium'): Promise<string | null> {
  try {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL, stream: false, temperature: 1.0, top_p: 1.0, max_tokens: 1000,
        reasoning_effort: effort, chat_template_kwargs: { reasoning_effort: effort },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) { console.warn('[Scribe] local narration non-OK:', res.status); return null }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content.trim() : null
  } catch (err) {
    console.warn('[Scribe] local narration unreachable — Claude fallback:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// Primary narrator — Claude Haiku. One non-streaming call.
async function narrateClaude(system: string, user: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client().messages.create({ model: CLAUDE_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] })
    const text = (res?.content ?? []).map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : '')).join('').trim()
    return text || null
  } catch (err) {
    console.error('[Scribe] Claude fallback failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Date helpers (LOCAL time — the "day" is the user's day) ──────────────────────────
export function localDateStr(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function dayWindow(date: string): { startMs: number; endMs: number; label: string } {
  const start = new Date(`${date}T00:00:00`)               // local midnight
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  const label = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return { startMs: start.getTime(), endMs: end.getTime(), label }
}

// Human label for a chat's scope (folder_id) so the narrator has context.
const SCOPE_LABELS: Record<string, string> = {
  main: 'general', schedule: 'schedule', body: 'body & recovery', training: 'training',
  projects: 'projects', 'project-diagram': 'The Diagram', 'project-lab': 'Research', 'project-build': 'Side Project',
}
function scopeLabel(folderId: string): string {
  return SCOPE_LABELS[folderId] ?? (folderId.startsWith('project-') ? folderId.slice(8).replace(/-/g, ' ') : folderId)
}
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

// ── Gather a day's source material (the daily bank) ─────────────────────────────
// `sinceMs` = chronicle only material AFTER this point. The chapter is built by APPENDING: each
// checkpoint narrates what's new since the last one, so the morning passage is preserved and the
// afternoon/night passages build on it. Events (workout/calendar) are included only on the OPENING
// pass — they frame the day; later passages chronicle new conversation, and the "do not repeat"
// rule keeps prose from re-covering them.
export async function gatherDay(date: string, sinceMs: number, isOpening: boolean): Promise<{ text: string; msgCount: number; eventCount: number; latestTs: number }> {
  const { startMs, endMs, label } = dayWindow(date)
  const fromMs = sinceMs > startMs ? sinceMs + 1 : startMs

  // 1. Chat since the marker — chronological, grouped by a light session/scope header.
  let msgs: ReturnType<typeof getDayMessages> = []
  try { msgs = getDayMessages(fromMs, endMs) } catch { msgs = [] }
  const lines: string[] = []
  let lastKey = ''
  for (const m of msgs) {
    const key = `${m.session_title}|${m.folder_id}`
    if (key !== lastKey) {
      lines.push(`\n— ${fmtTime(m.timestamp)} · "${m.session_title}" (${scopeLabel(m.folder_id)})`)
      lastKey = key
    }
    const who = m.role === 'user' ? USER_LABEL : 'Spectre'
    const body = String(m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, PER_TURN_CHARS)
    if (body) lines.push(`${who}: ${body}`)
  }
  let chatBlock = lines.join('\n').trim()
  if (chatBlock.length > SOURCE_BUDGET_CHARS) {
    chatBlock = `[earlier parts omitted to fit]\n…${chatBlock.slice(chatBlock.length - SOURCE_BUDGET_CHARS)}`
  }
  const latestTs = msgs.length ? msgs[msgs.length - 1].timestamp : sinceMs

  // 2. Real events — only on the OPENING pass (they frame the day).
  const events: string[] = []
  if (isOpening) {
    try {
      const w = readStore().workouts[date]
      if (w && w.blocks?.length) {
        const done = w.blocks.every(b => b.sets.every(s => s.done))
        const anyLogged = w.blocks.some(b => b.sets.some(s => s.done || s.actualWeight || s.actualReps))
        events.push(`Training: "${w.title}"${w.focus ? ` (${w.focus})` : ''} — ${done ? 'completed' : anyLogged ? 'trained (partial)' : 'planned'}, ${w.blocks.length} lift${w.blocks.length === 1 ? '' : 's'}.`)
      }
    } catch { /* no workout file / shape change — skip */ }
    try {
      if (gcalConnected()) {
        const evs = await listEvents(new Date(startMs).toISOString(), new Date(endMs).toISOString())
        const titles = (evs ?? []).map(e => `${e.allDay ? 'all-day' : fmtTime(new Date(e.start).getTime())} ${e.title}`)
        if (titles.length) events.push(`Calendar: ${titles.slice(0, 12).join('; ')}.`)
      }
    } catch { /* gcal unreachable / token issue — skip silently */ }
    // Deep-work sessions (weave item 5) — the day's real focused hours are chronicle
    // material. ≥10 min only; open sessions excluded (they aren't a fact yet).
    try {
      const focus = listFocusSince(startMs).filter(s => s.ended_at && s.started_at < endMs)
      for (const s of focus) {
        const min = Math.round(((s.ended_at ?? 0) - s.started_at) / 60_000)
        if (min < 10) continue
        const dur = min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`
        events.push(`Deep focus: ${dur} locked on "${s.label}".`)
      }
    } catch { /* focus table optional */ }
    // Habits checked this day — small true facts (never narrate what's unchecked).
    try {
      const checked = listHabitChecks(date).filter(c => c.date === date)
      if (checked.length) {
        const names = new Map(listHabits().map(h => [h.id, h.name]))
        events.push(`Habits kept: ${checked.map(c => names.get(c.habit_id) ?? c.habit_id).join(' · ')}.`)
      }
    } catch { /* habits table optional */ }
  }

  const text = [
    `[DAILY BANK — ${label}${isOpening ? '' : ' · new since the last passage'}]`,
    chatBlock ? `CONVERSATIONS (chronological):${chatBlock}` : 'CONVERSATIONS: (nothing new)',
    events.length ? `EVENTS:\n${events.map(e => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return { text, msgCount: msgs.length, eventCount: events.length, latestTs }
}

// ── The narration prompt (the soul) ─────────────────────────────────────────────
const SCRIBE_SYSTEM = `You are the Scribe — the devoted chronicler who attends ${USER_POSS} life the way a scribe once shadowed a king or a great explorer: at their side through every move, setting down the record so they never have to. You keep the story of their days, and you keep it so it drives them forward.

PURPOSE: this chronicle is a motivator and a memory. Reading it back, ${USER} should feel the momentum of what they are building and clearly recall what they actually did — without ever having lifted a finger to record it. You are the keeper of their saga.

VOICE: third person, past tense, mythic and heroic in TONE — but the drama lives in the language and the sense of significance, never in invented scenery. ${USER_CAP} is the hero of their own story; write so the weight of their real thinking and work lands on them. ${USER_NAME ? `Name them "${USER_NAME}."` : 'Refer to them as "the user" (no name is configured).'} Use the pronouns the conversations make clear; otherwise they/them. Disciplined; every sentence earns its place.

THE ONE INVIOLABLE RULE — TRUTH (read carefully):
Everything you know comes ONLY from ${USER_POSS} conversations with Spectre, given below. Those conversations are the ENTIRE world of facts available to you — there is nothing else. Elevate the LANGUAGE; never the facts.
- Do NOT invent settings, locations, or scenes. NEVER place ${USER} anywhere — not "on the street," "at the office," "in a meeting room," "at their desk," "at home" — unless the conversation explicitly says so.
- Do NOT invent physical actions or movement: no walking, pausing, writing in a notebook, going to a room, picking something up, times of day, weather, objects, other people, or spoken dialogue — unless it appears in the conversation.
- Do NOT infer or embellish outcomes, numbers, names, or feelings that weren't stated.
- Chronicle ONLY the substance of what ${USER} actually discussed, reasoned through, decided, built, or planned in the conversations. If they worked through a tricky design problem, chronicle that thinking and the decision — do not stage it in a place or attach actions they never mentioned.
- If a day (or passage) is thin, keep it short and honest. Never pad with invented scene-setting or filler action.
The heroism is entirely in HOW you frame the REAL substance of their ideas and work. If you find yourself adding a place, a movement, or a detail that isn't in the conversations, delete it.

CONTINUITY: this is one continuing saga. Thread the long arcs shown in "THE STORY SO FAR" so today reads as the next movement, not an isolated note — but only continue threads the source actually advances today.

LENGTH: 3–6 sentences, one cohesive paragraph. No lists, headers, markdown, second person, or quoted raw chat — render everything as narrative.

Output EXACTLY this and nothing else:
TITLE: <a 2–6 word chapter title>
THEMES: <comma-separated threads touched today>
<the chronicle paragraph>`

function recentChaptersContext(excludeDate: string): string {
  let entries: ScribeEntryRow[] = []
  try { entries = listScribeEntries(RECENT_CHAPTERS + 1) } catch { entries = [] }
  const past = entries.filter(e => e.date !== excludeDate).slice(0, RECENT_CHAPTERS).reverse()
  if (!past.length) return '(this is the first chapter)'
  return past.map(e => {
    const themes = (() => { try { return (JSON.parse(e.themes) as string[]).join(', ') } catch { return '' } })()
    return `- ${e.date}${e.title ? ` "${e.title}"` : ''}${themes ? ` [${themes}]` : ''}: ${e.narrative.slice(0, 200)}`
  }).join('\n')
}

function parseNarration(raw: string): { title: string; themes: string[]; narrative: string } {
  const lines = raw.replace(/\r/g, '').split('\n')
  let title = '', themes: string[] = []
  const body: string[] = []
  for (const line of lines) {
    const t = line.match(/^\s*TITLE:\s*(.+)$/i)
    const th = line.match(/^\s*THEMES:\s*(.+)$/i)
    if (t && !title) { title = t[1].trim().replace(/^["']|["']$/g, ''); continue }
    if (th && !themes.length) { themes = th[1].split(',').map(s => s.trim()).filter(Boolean); continue }
    body.push(line)
  }
  return { title, themes, narrative: body.join('\n').trim() }
}

// ── Generate (or extend) a day's chapter ─────────────────────────────────────────
// A day is ONE chapter built by APPENDING. The first checkpoint with material writes the OPENING
// passage (title + opening prose); each later checkpoint writes a CONTINUATION passage covering
// only what's new since the last one, appended below — a running story, never a rewrite. The
// `narrated_through` marker tracks how far we've chronicled, so no material is re-covered (and an
// empty checkpoint is a free no-op). finalize=true also locks the day (status 'final').
// rewrite=true redoes the WHOLE day from scratch as one clean pass (a manual do-over) — ignores the
// existing narrative + marker and regenerates from the full day's conversations.
export async function generateScribeDay(date: string, opts: { finalize?: boolean; rewrite?: boolean } = {}): Promise<ScribeEntryRow | null> {
  const finalize = !!opts.finalize
  const rewrite = !!opts.rewrite
  const { startMs } = dayWindow(date)
  const existing = getScribeEntry(date)
  const hasChapter = !rewrite && !!(existing && existing.narrative.trim())
  const sinceMs = !rewrite && existing && existing.narrated_through > 0 ? existing.narrated_through : startMs

  let g: { text: string; msgCount: number; eventCount: number; latestTs: number }
  try { g = await gatherDay(date, sinceMs, !hasChapter) } catch { return null }

  // Trigger = new conversation since the last passage (chat is the running signal); on an opening/
  // rewrite pass, real events alone can also start the chapter. No new material → no-op.
  const hasNew = g.msgCount > 0 || (!hasChapter && g.eventCount > 0)
  if (!hasNew) {
    if (finalize && existing && existing.status !== 'final') finalizeScribeEntry(date)
    return existing ?? null
  }

  // Claude Haiku is the primary narrator (accurate, disciplined); local gpt-oss is the down-fallback.
  let model = CLAUDE_MODEL
  let raw: string | null
  let title = existing?.title ?? ''
  let themes: string[] = (() => { try { return existing ? (JSON.parse(existing.themes) as string[]) : [] } catch { return [] } })()
  let narrative: string

  if (hasChapter) {
    // CONTINUATION — extend the existing chapter, never rewrite it.
    const userTurn = `THE CHAPTER SO FAR (already written — do NOT rewrite, repeat, or summarize any of it; continue seamlessly FROM it):\n${existing!.narrative}\n\nNEW DEVELOPMENTS since the last passage (chronicle ONLY these, building on the above):\n${g.text}\n\nWrite the NEXT 2–4 sentences of this day's chapter — a seamless continuation covering only what is new, in the same voice. Output ONLY the new passage prose: no TITLE or THEMES lines (the chapter already has them).`
    raw = await narrateClaude(SCRIBE_SYSTEM, userTurn)
    if (!raw) { raw = await narrateLocal(SCRIBE_SYSTEM, userTurn, finalize ? 'medium' : 'low'); model = LOCAL_MODEL }
    if (!raw) return existing
    const passage = parseNarration(raw).narrative || raw.trim()   // strip any stray TITLE/THEMES
    if (!passage) return existing
    narrative = `${existing!.narrative}\n\n${passage}`
  } else {
    // OPENING (or full rewrite) — sets the title + themes from the day's conversations.
    const scope = rewrite ? "today's chapter — cover the whole day so far, cohesively" : 'the OPENING of today\'s chapter'
    const userTurn = `THE STORY SO FAR:\n${recentChaptersContext(date)}\n\n${g.text}\n\nWrite ${scope}, following the rules exactly.${rewrite ? '' : ' (More passages will be appended as the day unfolds — open the day; don\'t try to cover what hasn\'t happened yet.)'}`
    raw = await narrateClaude(SCRIBE_SYSTEM, userTurn)
    if (!raw) { raw = await narrateLocal(SCRIBE_SYSTEM, userTurn, 'low'); model = LOCAL_MODEL }
    if (!raw) return existing ?? null
    const parsed = parseNarration(raw)
    if (!parsed.narrative) return existing ?? null
    title = parsed.title; themes = parsed.themes; narrative = parsed.narrative
  }

  return upsertScribeEntry({
    date,
    status: finalize ? 'final' : 'live',
    title,
    narrative,
    themes,
    source_hash: '',   // legacy column; the narrated_through marker is the dedup now
    source_count: rewrite ? g.msgCount : (existing?.source_count ?? 0) + g.msgCount,
    model,
    narrated_through: g.latestTs,
  })
}

// ── Quote of the day ────────────────────────────────────────────────────────────
// Each morning, read the PRIOR day's chapter, find its lesson, and surface a real, correctly-
// attributed quote from a great scientist/inventor/founder/thinker that speaks to it. Shows in the
// North Star spot. Generated once per day on the local model.
const QUOTE_SYSTEM = `You read a chapter of ${USER_POSS} day and choose a single REAL quotation that speaks to what they were living — a line to sharpen or steady them the next morning.

Method: identify the core lesson, struggle, or theme of the chapter, then recall a genuine, well-known quote from a great scientist, inventor, engineer, entrepreneur, artist, or thinker that addresses it — as if handing ${USER} exactly the words they need today.

RULES:
- The quote MUST be real and CORRECTLY ATTRIBUTED. Use the exact, widely-known wording; never invent a quotation and never guess or fabricate an attribution. If you are not confident a quote is genuine, choose a more famous, unmistakable one instead.
- Prefer people whose work rhymes with what ${USER} is doing.
- One quote only; a sentence or two at most.

Output EXACTLY two lines and nothing else:
QUOTE: <the quotation, no surrounding quotation marks>
AUTHOR: <the person's name>`

export async function generateQuoteOfDay(forDate: string): Promise<void> {
  if (getQuoteOfDay().date === forDate) return   // once per day
  // Draw the lesson from the PRIOR day's chapter.
  const prev = localDateStr(new Date(new Date(`${forDate}T00:00:00`).getTime() - 24 * 60 * 60 * 1000))
  const chapter = getScribeEntry(prev)
  if (!chapter || !chapter.narrative.trim()) return   // no chapter yet → no quote
  const themes = (() => { try { return (JSON.parse(chapter.themes) as string[]).join(', ') } catch { return '' } })()
  const user = `YESTERDAY'S CHAPTER${chapter.title ? ` — "${chapter.title}"` : ''}:\n${chapter.narrative}${themes ? `\n\nThreads: ${themes}` : ''}\n\nChoose today's quote, following the rules exactly.`
  let raw = await narrateClaude(QUOTE_SYSTEM, user)
  if (!raw) raw = await narrateLocal(QUOTE_SYSTEM, user, 'low')
  if (!raw) return
  let q = '', a = ''
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const mq = line.match(/^\s*QUOTE:\s*(.+)$/i); if (mq && !q) q = mq[1].trim()
    const ma = line.match(/^\s*AUTHOR:\s*(.+)$/i); if (ma && !a) a = ma[1].trim()
  }
  q = q.replace(/^["'“”]|["'“”]$/g, '').trim()
  a = a.replace(/^[—–-]\s*/, '').trim()
  if (q && a) setQuoteOfDay(forDate, q, a)
}

// Lazy maintenance, called when the dashboard opens: refresh today's live chapter and finalize
// any unfinalized past day that has material. `nowMs` is passed in so the caller controls "today".
export async function ensureScribeFresh(nowMs: number): Promise<{ today: ScribeEntryRow | null }> {
  const today = localDateStr(new Date(nowMs))
  const yesterday = localDateStr(new Date(nowMs - 24 * 60 * 60 * 1000))
  // Finalize yesterday if it never got locked (first open of a new day).
  try {
    const y = getScribeEntry(yesterday)
    if (!y || y.status !== 'final') await generateScribeDay(yesterday, { finalize: true })
  } catch { /* non-fatal */ }
  // Set today's quote from yesterday's (now-finalized) chapter — idempotent, once/day. This lets a
  // manual ↻ surface the quote before the morning scheduler has run.
  await generateQuoteOfDay(today).catch(() => {})
  const todayEntry = await generateScribeDay(today, { finalize: false }).catch(() => null)
  return { today: todayEntry }
}

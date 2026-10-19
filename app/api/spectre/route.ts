import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { loadSpectreIdentity } from '@/lib/spectreIdentity'
import { USER, USER_POSS, USER_POSS_CAP } from '@/lib/profile'
import { runLocalGptOss } from '@/lib/spectreLocal'
import { isSearchConfigured } from '@/lib/search'

export const dynamic = 'force-dynamic'

const client = new Anthropic()

const MEM0_URL = process.env.MEM0_API_URL ?? 'http://localhost:8000'
// The Mem0 user partition all memories are stored under (single-user system). Keep in sync with
// lib/mem0.ts (the agent path) so both chat paths read and write the same memories.
const MEM0_USER_ID = process.env.MEM0_USER_ID || 'default'

const ACTION_INSTRUCTIONS = `

---

## ACTION PROTOCOL

Always respond in prose first. When executing an action, embed the JSON block within your prose response — the JSON is stripped before display, so your prose IS what the user sees. Never respond with JSON alone and no prose.

CRITICAL: When you confirm any change to schedule, training, projects, or body stats, you MUST include the JSON action object in that same response — never in a follow-up. If you say "Done" or confirm a change without including the JSON action, the UI will not update. Always include the action JSON in the same message as your confirmation.

### Progress update (projects folder):
{"action": "updateProgress", "project": "<diagram|lab|build>", "value": <integer 0-100>}

Project IDs (match fuzzily — "The Diagram", "our OS", "diagram project" all map to "diagram"):
- "diagram" → The Diagram (Personal OS)
- "lab" → Research
- "build" → Side Project
(These are the seeded example projects — names may have been changed; the live project list in your context is authoritative.)

### Project field update (phase, description, or progress):
{"action": "updateProject", "project": "<diagram|lab|build>", "field": "<phase|description|progress>", "value": "<new value>"}

### Calendar sync (schedule folder) — real Google Calendar, two-way:

${USER_POSS_CAP} schedule is their live Google Calendar. The next 7 days of events are injected into your context, each with its event id. To add, move, reschedule, rename, or remove an event, emit ONE of these — it updates Google Calendar AND the UI immediately:

Create a new event:
{"action": "calendarSync", "op": "create", "event": {"title": "...", "start": "ISO 8601", "end": "ISO 8601", "allDay": false, "location": "..."}}

Edit an existing event (reference an event id from the injected calendar context):
{"action": "calendarSync", "op": "update", "eventId": "<google event id>", "event": {"title": "...", "start": "ISO 8601", "end": "ISO 8601", "allDay": false}}

Delete an event:
{"action": "calendarSync", "op": "delete", "eventId": "<google event id>"}

Rules:
- Use full ISO 8601 datetimes in ${USER_POSS} local timezone (e.g. "2026-06-04T15:00:00" plus their UTC offset). Always include an end time — default to 1 hour after start if ${USER} doesn't specify.
- For all-day events set "allDay": true and use date-only strings "YYYY-MM-DD"; the end date is exclusive (the day after).
- For update, send only the fields that change, plus "allDay" whenever you send start/end.
- update and delete require an event id — only events within the injected next-7-days context carry ids you can target. For anything further out, create works for any date.
- When you confirm a change, say in prose that both the schedule and Google Calendar were updated, and include the action JSON in that same message.

### Training arm (gym) — the workout you are looking at is one specific DAY

${USER_POSS_CAP} training arm is a day-by-day workout system backed by a master workout file (workouts.json) and an exercise library with personal records and estimated 1-rep maxes (exercises.json). Your context always tells you the EXACT date currently on screen, the full workout for that day (every exercise, its planned sets/reps/weight/rest, and any actual numbers ${USER} has already logged), whether an exercise's detail subpage is open, and the relevant history/PRs for those exercises. Never ask which workout ${USER} is looking at — you already know.

You do NOT auto-generate workouts. Build or change a workout only when ${USER} asks ("help me build today's workout", "plan this week", "swap in something for my shoulders"). Pull from past workouts and the exercise library so it feels like a training partner who has watched every session. On day one the history is empty — acknowledge that and build from what ${USER} tells you about their goals.

All training actions take an optional "date" ("YYYY-MM-DD"); omit it to act on the day currently on screen. Speak like a knowledgeable training partner, and always include the action JSON in the same message as your confirmation.

Build or fully replace a day's workout:
{"action": "updateWorkout", "date": "2026-06-04", "workout": {"title": "Upper Body Pull", "focus": "Lats", "notes": "...", "blocks": [{"exercise": "Pull-ups", "note": "Weighted", "sets": 4, "reps": "6-8", "weight": "BW+10", "rest": "120s"}]}}
- "sets" is the number of sets; the UI expands it into that many set rows pre-filled with the planned "weight" and "reps". "weight" may be any string ("100", "BW+10", "60kg"). "rest" may be "120s" or "2m".

Log the actual numbers ${USER} hit on one set (1-indexed):
{"action": "logSet", "exercise": "Pull-ups", "set": 1, "weight": "100", "reps": "8"}

Reorder the exercise blocks (e.g. equipment was taken):
{"action": "reorderBlocks", "order": ["Barbell Row", "Pull-ups", "Face Pulls"]}

Set the rest duration for one exercise:
{"action": "setRest", "exercise": "Pull-ups", "rest": "90s"}

(The legacy "updateTraining" action still works and is treated as updateWorkout for the current day.)

### Node update — update a project card's progress, phase, description, or name:
{"action": "updateNode", "id": "<node-id>", "progress": 75, "phase": "Analysis Phase", "description": "...", "name": "..."}
- id is the exact node id (seeded project Hands: "project-lab", "project-build", "project-diagram")
- All fields except "id" are optional — only include what you're changing
- progress is 0–100 integer; phase and description are free text strings
- Use this when ${USER} asks to update a project's progress, phase, description, or name

### Deep research:
{"action": "deepResearch", "query": "<the topic to research>", "plan": { "reasoning": "<why this structure fits>", "agents": [{ "id": 1, "name": "<short display name>", "directive": "<specific research goal>", "queries": ["<query 1>", "<query 2>"], "dependencies": [], "receives_from": [] }], "synthesis_focus": "<what the synthesis should prioritize>" }}
- Use when the user explicitly requests deep research, a deep dive, or thorough investigation of a topic.
- When you have sufficient context about the user's goals and background, include a full "plan" — design agents that are specific to what you know about the user (their projects, interests, stated goals), with non-overlapping directives. Use the minimum agents necessary (simple topics 2, complex interdisciplinary ones up to 6). Set "dependencies"/"receives_from" only when one agent genuinely needs another's findings first; leave them empty otherwise.
- When context is insufficient, OMIT "plan" entirely and the system will plan automatically.
- Always confirm with the user before including a plan — briefly show them the agent directions in prose and ask if they want to adjust before firing. The user reviews and launches the plan from a confirmation card; you do not fire it yourself.`

// Appended only in voice mode. Voice is the PRIMARY output — the on-screen text
// is just a subtitle of what was spoken. Spectre must speak, not write.
const VOICE_INSTRUCTIONS = `

---

## VOICE MODE — ACTIVE

You are in a live spoken conversation with ${USER}. Your words are read aloud — this is the primary output, the text is only a subtitle.

Respond in natural spoken English only. No bullet points, no numbered lists, no markdown, no headers, no asterisks, no emoji. Speak in short, clear sentences as if talking to someone in person. Be direct and concise — a sentence or two is usually enough. Optimize for how your response sounds, not how it looks.

You may still embed action JSON when you need to update a panel; it is stripped before anything is spoken, so never read it aloud or describe it.`

// Spectre can autonomously search the web (CLAUDE mode only — Anthropic's native
// web_search tool). This note is part of the stable, cached base prompt.
const WEB_SEARCH_NOTE = `

---

## WEB SEARCH

You can search the web when a question depends on current or post-training information (recent events, prices, releases, live facts). Search autonomously when it would improve the answer — don't ask permission, and don't mention the mechanics of searching. For things already in context (the injected time, the dashboard state, ${USER_POSS} memory), answer directly without searching.`

// Sentinel emitted into the text stream when a web search begins, so the UI can
// show a "Searching…" indicator. The frontend strips it before display/TTS.
export const SEARCH_MARKER = '[[SPECTRE_SEARCH]]'

let baseSystemPrompt: string | null = null
// `includeWebSearch` is false only for Haiku (lightweight casual chat) — it can't use
// the web_search tool, so it shouldn't be told it can. The cached value is core +
// ACTION_INSTRUCTIONS; WEB_SEARCH_NOTE is appended per-call so the cache stays shared
// and Sonnet/Opus/LOCAL get the identical prompt as before.
function getBaseSystemPrompt(includeWebSearch = true): string {
  if (!baseSystemPrompt) {
    // Same loader as the agent path: spectre_core.md with its HTML-comment editor notes stripped.
    const core = loadSpectreIdentity()
    baseSystemPrompt = core + ACTION_INSTRUCTIONS
  }
  return includeWebSearch ? baseSystemPrompt + WEB_SEARCH_NOTE : baseSystemPrompt
}

async function fetchMemories(query: string, timeoutMs = 8000): Promise<string> {
  console.log(`[Mem0] searching | url=${MEM0_URL} | query=${JSON.stringify(query.slice(0, 120))} | timeout=${timeoutMs}ms`)
  try {
    const res = await fetch(`${MEM0_URL}/v1/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, user_id: MEM0_USER_ID, limit: 8 }),
      // Mem0 is awaited on the critical path before the model call. Voice prioritizes latency:
      // a slow Mem0 degrades to "no memory this turn" fast (1.5s) rather than stalling the
      // spoken reply for up to 8s. Typed turns keep the generous ceiling.
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    console.log(`[Mem0] search response | status=${res.status}`)
    if (!res.ok) {
      const errText = await res.text()
      console.error(`[Mem0] search error body: ${errText}`)
      return ''
    }
    const data = await res.json()
    console.log(`[Mem0] raw response: ${JSON.stringify(data).slice(0, 400)}`)
    // Handle both {results: [...]} and bare array shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(data) ? data : (data.results ?? data.memories ?? [])
    const lines = items
      .filter(m => m.memory || m.content)
      .map(m => `- ${m.memory ?? m.content}`)
    console.log(`[Mem0] injecting ${lines.length} memories into system prompt`)
    if (!lines.length) return ''
    return `\n\n---\n\n[MEMORY — what Spectre already knows about ${USER}]\n${lines.join('\n')}`
  } catch (err) {
    console.error(`[Mem0] fetchMemories failed: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

async function saveTurnToMem0(userMessage: string, assistantMessage: string): Promise<void> {
  try {
    await fetch(`${MEM0_URL}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantMessage },
        ],
        user_id: MEM0_USER_ID,
      }),
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    // Non-fatal — Mem0 may be busy processing a previous save
  }
}

// Anthropic returns a 400 when the messages array contains an empty text block or two
// consecutive same-role turns. The route previously masked that 400 as a generic 502
// ("Claude is unavailable"), which is the intermittent failure being chased here: the
// request is malformed, not Claude. It happens conversation-state-dependently because
// compression (flipping in_context) and edit/retry soft-deletes can leave the verbatim
// history beginning with an assistant turn (landing right after the injected
// assistant:"Understood." primer turn → two assistants in a row) or carrying an empty turn.
// This normalizes the array immediately before the Anthropic call — content-preserving,
// CLAUDE-mode only (LOCAL/llama-server is untouched). Healthy, already-alternating arrays pass
// through unchanged, so normal sends behave exactly as before.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeMessages(raw: any[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || !m.role) continue
    // Drop turns whose STRING content is empty/whitespace (Anthropic 400s on empty text).
    // Array-content turns (image/PDF attachment blocks) are never dropped or merged.
    if (typeof m.content === 'string' && m.content.trim() === '') continue
    const prev = out[out.length - 1]
    // Collapse a consecutive same-role turn into the previous one to guarantee alternation.
    if (prev && prev.role === m.role && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content = `${prev.content}\n\n${m.content}`
      continue
    }
    out.push({ ...m })
  }
  // The first turn must be a user turn — drop any leading assistant turns.
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

export async function POST(req: NextRequest) {
  // `skipMemory` is the single switch for Mem0 (both retrieval AND save). Only the
  // voice greeting sets it. `save` is accepted for backward-compat but no longer
  // gates retrieval — memory is user-global and must be fetched on EVERY normal
  // call regardless of which folder/arm the chat originates from.
  // `model` selects the BACKEND ('claude' = Anthropic API, 'local' = gpt-oss:20b on llama-server :8013). `modelId` is the
  // Claude MODEL VARIANT (Sonnet default vs Opus) chosen via the settings model toggle — a separate
  // axis from the backend switch. Validated to an allowlist below so a bad client value can't 404.
  const { messages, model = 'claude', modelId = 'claude-sonnet-4-6', voice = false, save = true, think = false, skipMemory = false, effort, userText } = await req.json()
  // Only these three Claude variants are selectable (Haiku = lightweight casual chat, Sonnet =
  // default daily driver, Opus = deep work); anything else falls back to Sonnet.
  const claudeModel = (modelId === 'claude-opus-4-6' || modelId === 'claude-sonnet-4-6' || modelId === 'claude-haiku-4-5-20251001') ? modelId : 'claude-sonnet-4-6'
  // Haiku does not support programmatic tool calling with web_search — passing the tool
  // 400s every call. Haiku is conversation-only: no tools, no web-search prose.
  const isHaiku = claudeModel === 'claude-haiku-4-5-20251001'
  // X-Debug-Session: true is set ONLY by debug tooling / Claude Code sessions (never the
  // normal UI). It fully bypasses the memory layer — no Mem0 retrieval, no Mem0 save (and
  // therefore no Qwen3 1.7B extraction + no Qdrant write) — so test calls are never ingested
  // as real user memories. The actual Claude/llama-server call + response are unaffected.
  const debugSession = req.headers.get('x-debug-session') === 'true'
  const useMemory = !debugSession && !skipMemory && save !== false
  if (debugSession) console.log('[Spectre] X-Debug-Session: true — memory layer bypassed (no Mem0 retrieve/save, no Qdrant write)')

  // The actual user input is always the last user-role message (primer is prepended, not appended).
  // Prefer the client-sent clean `userText` for Mem0 retrieval — the last message now carries a
  // volatile-context prefix (time/session/memory scaffolding) that would otherwise pollute the
  // search query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastUserContent = [...messages].reverse().find((m: any) => m.role === 'user')?.content
  const userQuery: string = (typeof userText === 'string' && userText.trim())
    ? userText
    : (typeof lastUserContent === 'string' ? lastUserContent : '')
  console.log(`[Mem0] userQuery resolved: ${JSON.stringify(userQuery.slice(0, 200))} | useMemory=${useMemory}`)

  // Retrieve relevant memories on every turn (8 s timeout, degrades to '' if Mem0
  // is unavailable). Memories are global to the user — folder context never scopes
  // or skips them. Only the greeting (skipMemory) opts out so it speaks instantly.
  const memoryBlock = useMemory ? await fetchMemories(userQuery, voice ? 1500 : 8000) : ''
  // Memory is volatile per turn (re-retrieved per query). Inject it into the CURRENT user turn
  // (the END of the prompt) rather than a system block — otherwise it sits before the big
  // cacheable primer and invalidates the prompt cache every turn (the client already moved the
  // timestamp + session counter to the current turn for the same reason). This is the server
  // half of the stable-prefix fix that keeps prompt caching reused across turns.
  if (memoryBlock) {
    for (let i = messages.length - 1; i >= 0; i--) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = messages[i]
      if (m?.role === 'user') {
        if (typeof m.content === 'string') m.content = `${memoryBlock}\n\n${m.content}`
        else if (Array.isArray(m.content)) m.content = [{ type: 'text', text: `${memoryBlock}\n\n` }, ...m.content]
        break
      }
    }
  }
  // Only the (stable-per-mode) voice instructions remain as a trailing system block.
  // Voice mode shifts Spectre to spoken-prose output (no markdown/lists) — audio is primary.
  const trailingContext = voice ? VOICE_INSTRUCTIONS : ''
  // `systemPrompt` feeds the LOCAL branch. gpt-oss now has a server-executed webSearch
  // tool (Tavily) — so include the WEB_SEARCH_NOTE for local too WHEN a Tavily key is
  // configured (else omit it, like Haiku, so it isn't told about a tool it can't use). The
  // CLAUDE branch builds its own cached system blocks below and is unaffected.
  const localWebSearch = model === 'local' && isSearchConfigured()
  const systemPrompt = getBaseSystemPrompt(model !== 'local' || localWebSearch) + trailingContext

  // ── Prompt inspection (debug only) ──────────────────────────────────────────
  // When SPECTRE_DEBUG_PROMPT=1, dump the fully-assembled prompt to the server
  // console: the system prompt + every message turn (the first user turn carries
  // all the client-assembled blocks — diagram tree, primers, sources, open doc).
  // Each segment is labeled with an estimated token count, plus a grand total, so
  // prompt-size changes are measurable on real turns. Off by default → zero effect
  // on normal calls. (Unrelated to X-Debug-Session, which only gates the Mem0 layer.)
  if (process.env.SPECTRE_DEBUG_PROMPT === '1') {
    const tok = (s: string) => Math.ceil(s.length / 4)
    const turns = Array.isArray(messages) ? messages : []
    let dump = `\n===== [SPECTRE PROMPT DUMP] model=${model} modelId=${modelId} voice=${!!voice} think=${!!think} =====`
    dump += `\n----- SYSTEM (${tok(systemPrompt)} tok / ${systemPrompt.length} chars) -----\n${systemPrompt}`
    let total = systemPrompt.length
    for (const m of turns) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      total += content.length
      dump += `\n----- ${String(m.role).toUpperCase()} (${tok(content)} tok / ${content.length} chars) -----\n${content}`
    }
    dump += `\n===== [END DUMP] total ≈ ${Math.ceil(total / 4)} tokens =====\n`
    console.log(dump)
  }

  const encoder = new TextEncoder()
  const streamHeaders = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  }

  // ── LOCAL mode: gpt-oss:20b via llama-server (:8013) ───────────────────────
  // Native harmony tool calls are converted server-side into the inline
  // {"action":…} JSON the client already parses (see lib/spectreLocal.ts).
  // If llama-server is offline the call DEGRADES to the Claude branch below
  // instead of erroring — the conversation keeps going either way.
  if (model === 'local') {
    const local = await runLocalGptOss({
      systemPrompt,
      messages: sanitizeMessages(messages),
      voice: !!voice,
      think: !!think,
      effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined,
      onComplete: fullResponse => {
        if (useMemory && userQuery && fullResponse) {
          saveTurnToMem0(userQuery, fullResponse).catch(() => {})
        }
      },
    })
    if (local.status === 'ok') {
      return new Response(local.stream, { headers: streamHeaders })
    }
    console.warn('[Spectre] LOCAL backend offline — degrading to Claude for this turn')
  }

  // ── CLAUDE mode: Anthropic API ────────────────────────────────────────────
  // System is split into a stable, prompt-cached base block and a volatile
  // trailing block (per-turn memory + voice). Web search is always available
  // (Claude decides when to use it). Adaptive thinking is enabled only when the
  // Think Mode toggle is on — thinking deltas are never forwarded, so the raw
  // reasoning never reaches the client.
  // NOTE: tools/thinking use 2026 API features the pinned SDK (0.40.1) predates
  // in its TypeScript types; the SDK forwards unknown body fields verbatim, so
  // these work at runtime. `any` keeps the build clean without an SDK upgrade.
  const systemBlocks: unknown[] = [
    { type: 'text', text: getBaseSystemPrompt(!isHaiku), cache_control: { type: 'ephemeral' } },
  ]
  if (trailingContext) systemBlocks.push({ type: 'text', text: trailingContext })

  // Normalize the messages array (drop empty turns, collapse consecutive same-role turns)
  // so a conversation-state quirk can't produce an intermittent 400. CLAUDE-mode only.
  const claudeMessages = sanitizeMessages(messages)
  if (claudeMessages.length === 0) {
    console.error('[Spectre] empty messages array after sanitize — refusing the call (would 400)')
    return new Response('No message to send to Claude.', { status: 400 })
  }
  // Cache the (now byte-stable) primer turn so Anthropic stops re-billing the ~5-6k-token primer
  // on every message. cache_control caches the prefix up to and including this block; the primer
  // is the first user turn of the [primer, 'Understood.', …history, current] structure, and is
  // stable now that the client moved the timestamp/session and the route moved memory to the
  // current turn. (Adds a 2nd ephemeral breakpoint; the base system block is the 1st.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const primerMsg: any = claudeMessages[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (claudeMessages.length >= 2 && primerMsg?.role === 'user' && (claudeMessages[1] as any)?.role === 'assistant') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const primerText = typeof primerMsg.content === 'string'
      ? primerMsg.content
      : Array.isArray(primerMsg.content) ? primerMsg.content.map((b: any) => b?.text ?? '').join('') : String(primerMsg.content ?? '')
    if (primerText) primerMsg.content = [{ type: 'text', text: primerText, cache_control: { type: 'ephemeral' } }]
  }
  // 3rd breakpoint: cache the conversation HISTORY up to (not including) the current turn, so a
  // long Claude thread re-bills only the latest turn instead of re-sending all prior turns at full
  // price each message. The breakpoint goes on the turn BEFORE the current one (which carries the
  // volatile per-turn context and must stay uncached). Only worthwhile once there's real history.
  if (claudeMessages.length >= 5) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hist: any = claudeMessages[claudeMessages.length - 2]
    if (hist && (hist.role === 'user' || hist.role === 'assistant')) {
      if (typeof hist.content === 'string') {
        hist.content = [{ type: 'text', text: hist.content, cache_control: { type: 'ephemeral' } }]
      } else if (Array.isArray(hist.content) && hist.content.length) {
        const last = hist.content[hist.content.length - 1]
        if (last && typeof last === 'object') last.cache_control = { type: 'ephemeral' }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createParams: any = {
    model: claudeModel,
    max_tokens: think ? 16000 : 4096,
    system: systemBlocks,
    messages: claudeMessages,
    stream: true,
  }
  // Tools assembly: Sonnet/Opus get the full web_search tool array; Haiku gets the `tools`
  // key OMITTED entirely (it can't do programmatic tool calling — see isHaiku). Never set
  // `tools: []`, which some API versions reject — the key is either a non-empty array or absent.
  if (!isHaiku) createParams.tools = [{ type: 'web_search_20260209', name: 'web_search' }]
  if (think) createParams.thinking = { type: 'adaptive' }

  let stream
  try {
    stream = await client.messages.create(createParams)
  } catch (err) {
    // FIX 2 — classify the failure so the client can react correctly, and ALWAYS log the
    // real status + type + message (we used to eat this). A TRANSIENT failure (Anthropic
    // overloaded 529, gateway 5xx, connection drop / timeout) returns 503 → the client
    // retries once after 2s and, if it still fails, shows "tap to retry". A HARD/actionable
    // failure (credits, auth, rate-limit) returns 502 with a specific, non-retried reason.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any
    const status: number | undefined = e?.status
    const apiType: string = e?.error?.error?.type ?? e?.error?.type ?? e?.name ?? 'unknown'
    // Prefer the structured Anthropic message; fall back to the SDK error string.
    const apiMsg: string = e?.error?.error?.message ?? e?.message ?? String(err)
    // FULL error body + request shape — logged on EVERY non-200 so the exact reason for a
    // rejection is visible without re-running or guessing. The old code logged only a
    // truncated e.message, which is why intermittent 400s were undiagnosable.
    let fullBody: string
    try { fullBody = JSON.stringify(e?.error ?? e?.response?.data ?? null) } catch { fullBody = String(e?.error) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roleSeq = claudeMessages.map((m: any) => m.role).join(',')
    const approxChars = claudeMessages.reduce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (n: number, m: any) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)
    console.error(
      `[Spectre] messages.create FAILED\n` +
      `  status=${status ?? 'none'} type=${apiType}\n` +
      `  model=${claudeModel} toolsAttached=${!isHaiku} think=${think} voice=${voice}\n` +
      `  msgCount=${claudeMessages.length} roles=[${roleSeq}] ~inputChars=${approxChars}\n` +
      `  message=${apiMsg}\n` +
      `  body=${fullBody}`)

    const isTransient =
      status === 529 || status === 503 || status === 500 || status === 502 || status === 504 ||
      apiType === 'overloaded_error' || /overloaded/i.test(apiMsg) ||
      apiType === 'APIConnectionError' || apiType === 'APIConnectionTimeoutError' ||
      /timed out|timeout|fetch failed|econnreset|network|socket hang up/i.test(apiMsg)
    if (isTransient) {
      return new Response('Spectre is temporarily unreachable — tap to retry', { status: 503 })
    }

    // A real 400 is a MALFORMED REQUEST, never "Claude is down" — surface the actual reason
    // and return 400 (not 502) so it's never confused with an outage or retried as transient.
    // The full body is already logged above. Credit-exhaustion is the one 400 that IS a Claude
    // state, handled explicitly first.
    if (status === 400 && !/credit balance is too low/i.test(apiMsg)) {
      return new Response(`Claude rejected the request: ${apiMsg.slice(0, 240)}`, { status: 400 })
    }

    let message = 'Claude is unavailable right now. Switch to LOCAL mode (settings ⚙ → AI Model → LOCAL) to keep talking.'
    if (status === 400 && /credit balance is too low/i.test(apiMsg)) {
      message = 'Claude is out of API credits. Switch to LOCAL mode (settings ⚙ → AI Model → LOCAL) to keep talking, or add credits at console.anthropic.com.'
    } else if (status === 401) {
      message = 'Claude rejected the API key (check ANTHROPIC_API_KEY). Switch to LOCAL mode to keep talking.'
    } else if (status === 429) {
      message = 'Claude is rate-limited right now. Try again shortly, or switch to LOCAL mode.'
    }
    return new Response(message, { status: 502 })
  }

  const readable = new ReadableStream({
    async start(controller) {
      let fullResponse = ''
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const event of stream as any) {
          if (event.type === 'content_block_start') {
            // A web search has started — signal the UI (stripped before display).
            const cb = event.content_block
            if (cb?.type === 'server_tool_use' && cb?.name === 'web_search') {
              controller.enqueue(encoder.encode(SEARCH_MARKER))
            }
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            // Only text_delta is forwarded — thinking_delta is intentionally dropped.
            controller.enqueue(encoder.encode(event.delta.text))
            fullResponse += event.delta.text
          }
        }
      } catch (streamErr) {
        // A mid-stream failure keeps whatever text already arrived; log for diagnosis.
        console.error('[Spectre] Claude stream iteration failed:', streamErr)
        // The user already saw the partial reply — persist it so Mem0 doesn't lose it.
        if (useMemory && userQuery && fullResponse) saveTurnToMem0(userQuery, fullResponse).catch(() => {})
        controller.close()
        return
      }
      controller.close()

      // Save this turn to Mem0 after the stream ends — fire and forget.
      // The voice-mode greeting opts out (skipMemory) so its hidden prompt
      // never pollutes memory.
      if (useMemory && userQuery && fullResponse) {
        saveTurnToMem0(userQuery, fullResponse).catch(() => {})
      }
    },
  })

  return new Response(readable, { headers: streamHeaders })
}

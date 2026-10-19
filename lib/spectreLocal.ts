// LOCAL LLM backend — gpt-oss:20b served by llama.cpp's llama-server (:8013,
// MoE experts CPU-offloaded, attention/KV on GPU; launched by start-diagram.bat).
//
// WHY NATIVE TOOL CALLS: Spectre's action protocol is inline `{"action":…}` JSON
// embedded in prose, which Claude produces reliably from prompt instructions.
// gpt-oss was trained on the harmony format where tool calls go to a separate
// commentary channel — prompt-injected inline JSON is exactly what it is BAD at
// (the qwen3:14b "tool call format mismatch" failure, repeated). So the LOCAL
// branch registers every Spectre action as a real OpenAI-style tool; llama-server
// parses harmony natively and returns structured tool_calls, which this module
// converts BACK into the inline `{"action":…}` JSON text the client already
// extracts via extractAllSpectreActions(). The client is completely unchanged.
//
// PROSE GUARANTEE: when the model ends a turn on tool_calls with no spoken text
// (common in harmony — the final channel stays empty), we feed `{"ok":true}`
// tool results back and run ONE continuation call so Spectre always confirms in
// prose (critical in voice mode, where text IS the audio). Read-type actions
// (readFile / searchVault / readNotebook / listNotebooks) skip the continuation:
// the client drains those queues itself and regenerates with injected content.

import { tavilySearch, formatSearchResults, isSearchConfigured } from './search'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'

// Sentinel the client strips + uses to show a "Searching the web…" indicator. Kept in sync
// with SEARCH_MARKER in app/api/spectre/route.ts (hardcoded here to avoid a circular import).
const SEARCH_MARKER = '[[SPECTRE_SEARCH]]'
// Bound the agentic search loop so a model that keeps searching can't run forever.
const MAX_SEARCH_ROUNDS = 3

// Reasoning depth: harmony's native Low/Medium/High dial. Voice prioritizes
// latency; Think Mode buys depth. Sent both top-level and as template kwargs —
// llama-server versions differ in which one the gpt-oss template reads.
export function reasoningEffort(voice: boolean, think: boolean, effort?: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  if (voice) return 'low'          // voice ALWAYS prioritizes latency — kills the gpt-oss reasoning pause even when the REASONING bar is MED/HIGH
  if (effort) return effort        // explicit user choice (the REASONING bar) wins for typed turns
  return think ? 'high' : 'medium'
}

// Degrade-safe /health memoization. The 1.5s pre-flight below lets a downed llama-server
// degrade to Claude instead of hanging — but re-probing on EVERY turn adds 1.5s to the
// critical path of a rapid voice conversation. So we cache ONLY the positive ("healthy")
// result for a short TTL: back-to-back turns within the window skip the probe, while ANY
// connection failure in the actual stream (streamChatOnce) resets this to 0 so the very next
// turn re-probes and degrades. The cache can therefore delay (by at most one turn) but never
// SUPPRESS the degrade-to-Claude path. Positive-only by design — an unhealthy result is never
// cached, so a recovering server is picked up immediately.
let llamaHealthyUntil = 0
const HEALTH_TTL_MS = 4000

// Minimal JSON-Schema tool defs for every Spectre action. Descriptions stay
// one-line — the full semantics already live in the system prompt (ACTION
// PROTOCOL + the client-assembled [NAVIGATION AND FILE CONTROL] / [NOTEBOOKS…]
// blocks), which the model reads either way. `additionalProperties: true`
// everywhere so protocol fields not enumerated here still pass through.
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: true },
    },
  }
}
const STR = { type: 'string' } as const
const NUM = { type: 'number' } as const

export const LOCAL_TOOLS = [
  tool('updateProgress', 'Update a project progress bar (0-100).', { project: STR, value: NUM }, ['project', 'value']),
  tool('updateProject', 'Update a project phase/description/progress field.', { project: STR, field: STR, value: STR }, ['project', 'field', 'value']),
  tool('updateNode', 'Update a Diagram node (progress/phase/description/name).', { id: STR, progress: NUM, phase: STR, description: STR, name: STR }, ['id']),
  tool('calendarSync', 'Create/update/delete a Google Calendar event.', { op: STR, event: { type: 'object', additionalProperties: true }, eventId: STR }, ['op']),
  tool('updateWorkout', 'Build or fully replace a day\'s workout.', { date: STR, workout: { type: 'object', additionalProperties: true } }, ['workout']),
  tool('logSet', 'Log actual weight/reps for one set (1-indexed).', { exercise: STR, set: NUM, weight: STR, reps: STR, date: STR }, ['exercise', 'set']),
  tool('reorderBlocks', 'Reorder the exercise blocks of a workout day.', { order: { type: 'array', items: STR }, date: STR }, ['order']),
  tool('setRest', 'Set rest duration for one exercise.', { exercise: STR, rest: STR, date: STR }, ['exercise', 'rest']),
  tool('deepResearch', 'Launch the deep-research pipeline on a topic.', { query: STR, plan: { type: 'object', additionalProperties: true } }, ['query']),
  tool('readFile', 'Read a project Source file\'s contents.', { id: STR }, ['id']),
  tool('searchVault', 'Semantic search over the Metalmind knowledge vault.', { query: STR, node_id: STR, limit: NUM }, ['query']),
  tool('webSearch', 'Search the web for current, factual, or post-training information (recent events, prices, releases, live facts). Call this when the answer depends on up-to-date information; do not ask permission. The results are returned to you to answer from.', { query: STR }, ['query']),
  tool('createDocument', 'Create a NEW Document (a content page) in a project\'s Notebooks and save the full markdown body into it, in one step. Use for ANY expression of wanting to keep, save, note, or write up content ("save this", "keep that", "make a note", "jot this down") — exact wording never matters; the intent does. Infer a short title yourself; never ask for one. "content" must be the complete markdown — never empty. Optional node_id targets a different project.', { title: STR, content: STR, node_id: STR, parent_id: STR }, ['title', 'content']),
  tool('createNotebook', 'Create an EMPTY Notebook folder (a container that holds Documents). It cannot hold content — to save content, use createDocument instead.', { title: STR, type: STR, parent_id: STR, content: STR }, ['title', 'type']),
  tool('readNotebook', 'Read an existing Document\'s full content by id (ids are listed in the [DIAGRAM TREE] and [NOTEBOOKS IN THIS PROJECT] directory — resolve names against those; never ask the user for an id). Call this whenever the user asks you to read, check, review, summarize, or give feedback on a document; the content is returned to you to respond from.', { id: STR }, ['id']),
  tool('listNotebooks', 'List all Notebooks and Documents in the current project.', {}),
  tool('writeToNotebook', 'Append to or replace the content of an EXISTING Document by id. To save new content, use createDocument.', { id: STR, content: STR, mode: STR }, ['id', 'content', 'mode']),
  tool('navigateTo', 'Navigate the UI to an Arm or Hand of The Diagram.', { node_id: STR, node_name: STR }, ['node_id', 'node_name']),
  tool('openNotebook', 'Open a notebook/Document in the UI (view or edit mode; id from the directory blocks). This only changes the screen — to comment on its content, also call readNotebook.', { id: STR, mode: STR }, ['id']),
  tool('openFile', 'Open a Source file preview in the UI.', { id: STR }, ['id']),
  tool('openSession', 'Open a chat session (recent/new/specific).', { mode: STR, session_id: STR, node_id: STR }, ['mode']),
  tool('searchSessions', 'Find a past conversation by topic/title.', { query: STR, node_id: STR, open_result: { type: 'boolean' } }, ['query']),
]

// Actions whose results the CLIENT injects by re-calling /api/spectre — after
// emitting these the turn should simply end; a server continuation would answer
// without the data and then be discarded by the client's regenerate.
const CLIENT_DRAIN_ACTIONS = new Set(['readFile', 'searchVault', 'readNotebook', 'listNotebooks'])

type ToolCallAcc = { name: string; args: string }

// gpt-oss has no vision — flatten array-content turns (image/PDF attachment
// blocks) to their text parts so the OpenAI-compat endpoint never sees them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function flattenForLocal(messages: any[]): { role: string; content: string }[] {
  return (Array.isArray(messages) ? messages : [])
    .map(m => {
      if (typeof m?.content === 'string') return { role: m.role, content: m.content }
      if (Array.isArray(m?.content)) {
        const text = m.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image attached — vision unavailable in LOCAL mode]' : ''))
          .filter(Boolean)
          .join('\n\n')
        return { role: m.role, content: text }
      }
      return { role: m?.role ?? 'user', content: '' }
    })
    .filter(m => m.content.trim() !== '')
}

// ── Context fitting ───────────────────────────────────────────────────────────
// llama-server hard-rejects prompts over n_ctx (HTTP 400 exceed_context_size_error) —
// it never truncates. The client's window builder targets Claude (compression only
// fires at 70k tokens), so a huge turn (an 80k-char readFile/[OPEN NOTEBOOK] block) can overflow the local ctx before the
// client ever compresses — and every LOCAL turn then dies with what looks like an
// outage. Fit BEFORE sending: keep the system prompt + the primer pair (first user
// turn + its 'Understood.' ack) + as many of the NEWEST turns as fit a char budget,
// dropping the oldest middle. If the primer alone busts the budget (a 32k-char
// [OPEN NOTEBOOK] block can), its middle is cut — instructions and recency survive.
const LOCAL_N_CTX = Number(process.env.LLM_N_CTX ?? 131072)
const GEN_RESERVE_TOK = 4096   // headroom for harmony reasoning + the answer
const CHARS_PER_TOK = 3.6      // conservative for markdown/code-heavy text
const INPUT_BUDGET_CHARS = Math.floor((LOCAL_N_CTX - GEN_RESERVE_TOK) * CHARS_PER_TOK)

export function fitLocalContext(
  systemPrompt: string,
  msgs: { role: string; content: string }[],
  reserveChars = 0,   // hold back room for content appended later (e.g. web-search results)
): { role: string; content: string }[] {
  if (!msgs.length) return msgs
  let budget = INPUT_BUDGET_CHARS - systemPrompt.length - 1200 - reserveChars   // template + tools overhead
  // Primer pair: the client sends [primer(user), 'Understood.'(assistant), ...turns].
  const head: { role: string; content: string }[] = []
  let rest = msgs
  if (msgs.length >= 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant') {
    head.push(msgs[0], msgs[1]); rest = msgs.slice(2)
  } else {
    head.push(msgs[0]); rest = msgs.slice(1)
  }
  // Primer too big on its own → cut its middle; the instructional head + tail survive.
  if (head[0].content.length > budget * 0.6) {
    const keep = Math.max(6000, Math.floor(budget * 0.5))
    const c = head[0].content
    if (c.length > keep) {
      const front = Math.floor(keep * 0.7)
      head[0] = { ...head[0], content: `${c.slice(0, front)}\n\n…[context trimmed to fit the local model]…\n\n${c.slice(c.length - (keep - front))}` }
      console.warn(`[Spectre/local] context fit: primer cut ${c.length} → ${keep} chars`)
    }
  }
  budget -= head.reduce((n, m) => n + m.content.length, 0)
  // Take the newest turns that fit (always at least the newest, hard-cut if gigantic —
  // e.g. an 80k-char readFile injection in the last user turn).
  const tail: { role: string; content: string }[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = rest[i].content.length
    if (cost > budget) {
      if (tail.length === 0) {
        const room = Math.max(4000, budget)
        tail.unshift({ ...rest[i], content: rest[i].content.slice(0, room) + '\n…[truncated to fit the local model]' })
        budget = 0
      }
      break
    }
    tail.unshift(rest[i])
    budget -= cost
  }
  // Keep alternation after the 'Understood.' ack: the tail must start with a user turn.
  while (tail.length && tail[0].role !== 'user') tail.shift()
  const dropped = rest.length - tail.length
  if (dropped > 0 && tail.length) {
    console.warn(`[Spectre/local] context fit: dropped ${dropped} oldest turn(s) to fit n_ctx=${LOCAL_N_CTX}`)
    tail[0] = { ...tail[0], content: `[${dropped} earlier message${dropped === 1 ? '' : 's'} in this conversation omitted to fit the local model's context]\n\n${tail[0].content}` }
  }
  return [...head, ...tail]
}

// One streamed /v1/chat/completions call. onText receives content deltas;
// returns the accumulated tool calls + whether any visible text was produced.
async function streamChatOnce(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>,
  onText: (t: string) => void,
): Promise<{ toolCalls: ToolCallAcc[]; textLen: number; ok: boolean; errBody?: string }> {
  let res: Response
  try {
    res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    // Connection refused/dropped — the server went down since the (possibly cached) health
    // probe. Invalidate the health cache so the NEXT turn re-probes and degrades to Claude.
    llamaHealthyUntil = 0
    console.error('[Spectre/local] llama-server connection failed:', err instanceof Error ? err.message : String(err))
    return { toolCalls: [], textLen: 0, ok: false, errBody: 'connection failed' }
  }
  if (!res.ok || !res.body) {
    if (res.status >= 500) llamaHealthyUntil = 0   // server-side fault → re-probe next turn
    const errBody = await res.text().catch(() => '')
    console.error('[Spectre/local] llama-server non-OK:', res.status, errBody)
    return { toolCalls: [], textLen: 0, ok: false, errBody }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let textLen = 0
  const toolCalls: ToolCallAcc[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const data = line.startsWith('data: ') ? line.slice(6).trim() : ''
      if (!data || data === '[DONE]') continue
      try {
        const obj = JSON.parse(data)
        const delta = obj.choices?.[0]?.delta
        if (!delta) continue
        // delta.reasoning_content (harmony analysis channel) is intentionally
        // dropped — same policy as Claude thinking_delta.
        if (typeof delta.content === 'string' && delta.content) {
          onText(delta.content)
          textLen += delta.content.length
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0
            if (!toolCalls[i]) toolCalls[i] = { name: '', args: '' }
            if (tc.function?.name) toolCalls[i].name = tc.function.name
            if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments
          }
        }
      } catch { /* malformed SSE line — skip */ }
    }
  }
  return { toolCalls: toolCalls.filter(t => t?.name), textLen, ok: true }
}

// Serialize an accumulated tool call into the inline action JSON the client
// already parses ({"action": <name>, ...args}).
function toActionJson(tc: ToolCallAcc): string | null {
  try {
    const args = tc.args.trim() ? JSON.parse(tc.args) : {}
    return JSON.stringify({ action: tc.name, ...args })
  } catch {
    console.error('[Spectre/local] unparseable tool args for', tc.name, '—', tc.args.slice(0, 200))
    return null
  }
}

export type LocalRunResult =
  | { status: 'ok'; stream: ReadableStream<Uint8Array> }
  | { status: 'offline' }

// Run a full LOCAL turn. Returns 'offline' if llama-server can't be reached at
// all (caller falls back to Claude — graceful degradation, never a dead end).
export async function runLocalGptOss(opts: {
  systemPrompt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
  voice: boolean
  think: boolean
  effort?: 'low' | 'medium' | 'high'
  onComplete: (fullResponse: string) => void
}): Promise<LocalRunResult> {
  // Fast pre-flight so a downed llama-server costs ~1s, not a hung stream. Skipped when a
  // recent probe was healthy (see llamaHealthyUntil) so a rapid voice conversation doesn't
  // re-pay 1.5s every turn; any in-stream connection failure invalidates the cache.
  if (Date.now() >= llamaHealthyUntil) {
    try {
      const health = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' })
      if (!health.ok) return { status: 'offline' }
    } catch {
      return { status: 'offline' }
    }
    llamaHealthyUntil = Date.now() + HEALTH_TTL_MS
  }

  const effort = reasoningEffort(opts.voice, opts.think, opts.effort)
  // LOCAL-only system note: ACTION_INSTRUCTIONS (shared with Claude) says to embed
  // action JSON in prose, but gpt-oss has NATIVE tools registered — when it follows the
  // prose instruction instead, it tends to write pretty-printed JSON the client can't
  // reliably treat as a tool call. Steer it to the native path explicitly.
  const localSystem = opts.systemPrompt
    + '\n\n## TOOL CALLS (LOCAL MODE)\nYou have native tools registered for every action above. CALL the tool — never write {"action": …} JSON as text in your reply.'
  // Web search is a SERVER-EXECUTED tool (gpt-oss calls webSearch → we run Tavily → feed
  // results back → it answers). Only offered when a Tavily key is configured. Reserve
  // context headroom so appended search results don't overflow llama-server's n_ctx.
  const searchOn = isSearchConfigured()
  const tools = searchOn ? LOCAL_TOOLS : LOCAL_TOOLS.filter(t => t.function.name !== 'webSearch')
  const fitted = fitLocalContext(localSystem, flattenForLocal(opts.messages), searchOn ? MAX_SEARCH_ROUNDS * 3200 : 0)
  const systemMsg = { role: 'system', content: localSystem }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseBody: Record<string, any> = {
    model: 'gpt-oss-20b',
    stream: true,
    tools,
    // gpt-oss recommended sampling (model card): temperature 1.0, top_p 1.0.
    temperature: 1.0,
    top_p: 1.0,
    reasoning_effort: effort,
    chat_template_kwargs: { reasoning_effort: effort },
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = ''
      const emit = (t: string) => {
        controller.enqueue(encoder.encode(t))
        full += t
      }
      try {
        // ── Agentic web-search loop ──────────────────────────────────────────────
        // Stream a turn. If the model called webSearch, run Tavily server-side, append the
        // results as tool messages, and stream again — up to MAX_SEARCH_ROUNDS. Non-search
        // tool calls (UI/data actions) accumulate to be handled after the loop. The grounded
        // answer streams to the client directly; webSearch itself is never shown.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const convo: any[] = [systemMsg, ...fitted]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actionCalls: ToolCallAcc[] = []   // client-handled tool calls (everything except webSearch)
        let result = await streamChatOnce({ ...baseBody, messages: convo }, emit)
        if (!result.ok && full.length === 0) {
          // Distinguish "prompt still too big" (a context problem, not an outage) from a
          // genuine server error — the old blanket "offline" message sent the user chasing a
          // healthy server.
          emit(result.errBody?.includes('exceed_context_size')
            ? 'This conversation is too long for the local model even after trimming — start a new chat for LOCAL mode, or switch this one to a Claude model.'
            : 'The local model returned an error. Check the llama-server window, or switch the model selector to a Claude variant.')
        }
        let searchRounds = 0
        while (true) {
          const searchCalls = result.toolCalls.filter(tc => tc.name === 'webSearch')
          actionCalls.push(...result.toolCalls.filter(tc => tc.name !== 'webSearch'))
          if (searchCalls.length === 0 || searchRounds >= MAX_SEARCH_ROUNDS) break
          emit(SEARCH_MARKER)   // UI "Searching the web…" indicator (stripped before display)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const assistantToolCalls = searchCalls.map((tc, i) => ({
            id: `s${searchRounds}_${i}`, type: 'function',
            function: { name: 'webSearch', arguments: tc.args || '{}' },
          }))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolMsgs: any[] = []
          // Bound each round's appended results to ~the per-round reserved headroom, so several
          // search calls in one round can't cumulatively overflow n_ctx on the next re-stream
          // (which would 400 silently after text had already streamed).
          const perCall = Math.max(800, Math.floor(3000 / Math.max(1, searchCalls.length)))
          for (let i = 0; i < searchCalls.length; i++) {
            let q = ''
            try { q = String(JSON.parse(searchCalls[i].args || '{}').query ?? '') } catch { /* bad args */ }
            const sr = q ? await tavilySearch(q, { maxResults: 5, includeAnswer: true }) : { ok: false, query: '', results: [] }
            toolMsgs.push({ role: 'tool', tool_call_id: `s${searchRounds}_${i}`, content: q ? formatSearchResults(sr, { maxChars: perCall, perHitChars: Math.min(700, Math.floor(perCall / 4)) }) : 'No query provided.' })
          }
          convo.push({ role: 'assistant', content: '', tool_calls: assistantToolCalls }, ...toolMsgs)
          searchRounds++
          result = await streamChatOnce({ ...baseBody, messages: convo }, emit)
        }

        // Serialize the client-handled tool calls into inline action JSON (webSearch excluded).
        const serialized = actionCalls.map(tc => ({ tc, json: toActionJson(tc) }))
        for (const s of serialized) if (s.json) emit(`\n${s.json}\n`)
        const anyDropped = serialized.some(s => !s.json)
        const hasClientDrain = actionCalls.some(tc => CLIENT_DRAIN_ACTIONS.has(tc.name))

        // Continuation pass produces spoken prose when the model acted/searched silently.
        // Skipped when a client-drain action is pending (the client regenerates for those).
        const needsProse = !hasClientDrain && (
          (actionCalls.length > 0 && (result.textLen < 2 || anyDropped)) ||
          (searchRounds > 0 && result.textLen < 2)   // searched but never answered → make it answer
        )
        if (needsProse) {
          if (result.textLen > 0) emit('\n\n')
          // convo already carries any search tool results; append the action tool results
          // (ok/failed) so the model can confirm them too.
          const followup = [...convo]
          if (actionCalls.length) {
            followup.push({
              role: 'assistant', content: '',
              tool_calls: actionCalls.map((tc, i) => ({ id: `a_${i}`, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } })),
            })
            actionCalls.forEach((_tc, i) => followup.push({
              role: 'tool', tool_call_id: `a_${i}`,
              content: serialized[i].json
                ? '{"ok":true,"note":"action dispatched to the UI"}'
                : '{"ok":false,"error":"malformed tool arguments — this action was NOT executed. Tell the user it failed; do not claim success."}',
            }))
          }
          // No tools on the continuation — it exists to produce prose, and removing them
          // prevents a silent second action/search loop.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { tools: _omit, ...prose } = baseBody
          await streamChatOnce({ ...prose, messages: followup }, emit)
        }
        // Never end on a blank reply: a late re-stream failure (e.g. an n_ctx 400 after results
        // were appended) won't trip the first-stream guard above, because the SEARCH_MARKER or
        // earlier text already made `full` non-empty. If nothing VISIBLE was produced, say so.
        if (full.split(SEARCH_MARKER).join('').trim().length === 0) {
          emit('I hit a problem finishing that with the local model — try again, or switch this chat to a Claude model.')
        }
      } catch (err) {
        console.error('[Spectre/local] stream failed:', err)
      }
      controller.close()
      // Strip the search sentinel from what's saved to memory (it's a UI-only marker).
      if (full) opts.onComplete(full.split(SEARCH_MARKER).join(''))
    },
  })

  return { status: 'ok', stream }
}

// THE AGENTIC LOOP — drives a model with tools until it produces a final answer, executing every
// tool call through the shared executor and feeding the result back. Identical shape for both
// providers; only the wire format differs (Anthropic tool_use/tool_result vs OpenAI tool_calls/tool
// messages), which the adapters + this file localize. This is the proper, model-agnostic version of
// what the old client "drain" hack did by re-calling the route.
import Anthropic from '@anthropic-ai/sdk'
import { toAnthropicTools, toOpenAITools, type ToolCall, type ToolResult } from './adapters'
import { executeTool, type ExecCtx } from './executor'
import type { ToolDef } from './registry'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
let _client: Anthropic | null = null
const client = () => _client ?? (_client = new Anthropic())

// ── Output ceilings ────────────────────────────────────────────────────────────────
// max_tokens is a CAP, not a reservation: the model stops at end_turn on its own, so a
// generous ceiling costs nothing on a short reply but keeps a long technical answer from
// being guillotined mid-sentence. A flat 1500 here did exactly that — when this path became
// the default for typed chat it silently cut the answer ceiling to well under the legacy
// /api/spectre route's 4096, so every long explanation stopped mid-thought (e.g. a long
// technical answer that simply ended at "…algorithmically detect the steady").
// Streaming has no HTTP-timeout ceiling, so it takes the full documented default; the
// non-streaming nested loop stays lower to stay inside the SDK's request timeout. Local
// gpt-oss is bounded by the 120s fetch timeout at ~55 tok/s, not by the model.
const MAX_TOKENS_STREAM = 64000
const MAX_TOKENS_SYNC = 16000
const MAX_TOKENS_LOCAL = 8192

// Hitting the ceiling is rare now, but it must never be SILENT — a reply that just stops
// reads as Spectre malfunctioning. Say so, and make the recovery obvious.
const TRUNCATION_NOTE = '\n\n*(I hit my length limit mid-answer — say "continue" and I\'ll pick up exactly where I left off.)*'

export type LoopStep = { call: ToolCall; result: ToolResult }
export type LoopResult = {
  model: string
  text: string                                   // the final answer
  ui: NonNullable<ToolResult['ui']>[]            // UI effects the client must apply (navigate/open/refresh/proxy)
  trace: LoopStep[]                              // every tool call + its result, in order
  rounds: number
  error?: string
}

// ── Streaming variant ──────────────────────────────────────────────────────────────
// Events emitted live while the loop runs: text deltas as the model produces them, and a
// status line per tool execution (the client renders it as the silent status indicator).
// UI effects + done are sent by the route from the returned aggregate, AFTER the loop.
export type LoopEvent =
  | { type: 'text'; delta: string }
  | { type: 'status'; label: string; kind: 'reading' | 'searching' | 'vault'; tool: string }

// Friendly per-tool status labels + which indicator style the client should use.
const STATUS: Record<string, { label: string; kind: 'reading' | 'searching' | 'vault' }> = {
  web_search: { label: 'Searching the web', kind: 'searching' },
  search_documents: { label: 'Searching the project', kind: 'vault' },
  read_document: { label: 'Reading the document', kind: 'reading' },
  list_documents: { label: 'Checking the documents', kind: 'reading' },
  read_file: { label: 'Reading the file', kind: 'reading' },
  save_document: { label: 'Saving the document', kind: 'searching' },
  append_to_document: { label: 'Updating the document', kind: 'searching' },
  create_folder: { label: 'Creating the folder', kind: 'searching' },
  calendar_event: { label: 'Updating the calendar', kind: 'searching' },
  update_project: { label: 'Updating the project', kind: 'searching' },
  navigate: { label: 'Navigating', kind: 'searching' },
  open_document: { label: 'Opening the document', kind: 'searching' },
  open_file: { label: 'Opening the file', kind: 'searching' },
  open_session: { label: 'Opening the conversation', kind: 'searching' },
  search_sessions: { label: 'Finding the conversation', kind: 'searching' },
  search_chats: { label: 'Searching past conversations', kind: 'searching' },
  read_chat: { label: 'Reading a past conversation', kind: 'reading' },
  update_workout: { label: 'Updating the workout', kind: 'searching' },
  log_set: { label: 'Logging the set', kind: 'searching' },
  reorder_blocks: { label: 'Reordering the workout', kind: 'searching' },
  set_rest: { label: 'Setting the rest timer', kind: 'searching' },
  deep_research: { label: 'Preparing deep research', kind: 'searching' },
}
export function statusFor(tool: string): LoopEvent {
  const s = STATUS[tool] ?? { label: 'Working', kind: 'searching' as const }
  return { type: 'status', label: `${s.label}…`, kind: s.kind, tool }
}

// When the model runs tools but narrates nothing (a bare navigate/open/save turn), fall back
// to the honest tool acks instead of leaving the answer empty ("I didn't produce a reply.").
function fallbackText(trace: LoopStep[]): string {
  return trace.filter(s => s.result.ok && s.result.content).map(s => s.result.content).join(' ')
}

// Execute a call ONCE per turn. A weak local model will re-fire the same tool across rounds
// (e.g. navigate('body') four times) instead of terminating; a repeat of an identical
// (name+args) call is not re-executed — it gets a firm "already done, reply now" result and
// its UI effect isn't duplicated — so the loop converges instead of thrashing.
async function execOnce(call: ToolCall, ctx: ExecCtx, seen: Set<string>, trace: LoopStep[], ui: NonNullable<ToolResult['ui']>[]): Promise<ToolResult> {
  // add_task keys on title+project (not full args): a weak local model will loop, re-adding the
  // SAME task with drifting placement args and spraying duplicates. A genuine second task with an
  // identical title in one turn isn't a real case; asking again works.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a: any = call.args ?? {}
  const sig = call.name === 'add_task'
    ? `add_task|${String(a.title ?? '').trim().toLowerCase()}|${String(a.project ?? '')}`
    : `${call.name}|${JSON.stringify(a)}`
  if (seen.has(sig)) return { id: call.id, name: call.name, ok: true, content: 'Already handled this exact call — do not repeat it; give your final reply to the user now.' }
  seen.add(sig)
  const result = await executeTool(call, ctx)
  trace.push({ call, result })
  if (result.ui) ui.push(result.ui)
  return result
}

export async function runToolLoopStream(
  opts: Parameters<typeof runToolLoop>[0],
  onEvent: (ev: LoopEvent) => void,
): Promise<LoopResult> {
  const maxRounds = opts.maxRounds ?? 5
  const ui: NonNullable<ToolResult['ui']>[] = []
  const trace: LoopStep[] = []
  try {
    if (opts.provider === 'claude') return await claudeLoopStream(opts, ui, trace, maxRounds, onEvent)
    return await localLoopStream(opts, ui, trace, maxRounds, onEvent)
  } catch (err) {
    return { model: opts.modelId ?? opts.provider, text: '', ui, trace, rounds: trace.length, error: err instanceof Error ? err.message : String(err) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claudeLoopStream(opts: any, ui: any[], trace: LoopStep[], maxRounds: number, emit: (ev: LoopEvent) => void): Promise<LoopResult> {
  const model = opts.modelId || 'claude-sonnet-4-6'
  const anthTools = toAnthropicTools(opts.tools)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [...(opts.history ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'user', content: opts.userText }]
  let full = ''
  let rounds = 0
  const seen = new Set<string>()
  for (; rounds < maxRounds; rounds++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = await client().messages.create({ model, max_tokens: MAX_TOKENS_STREAM, system: opts.system, tools: anthTools, messages, stream: true } as any)
    // Accumulate content blocks in order: text streams out live, tool_use inputs assemble
    // from input_json_delta fragments and parse at the end of the message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = []
    let stopReason = ''
    let roundText = ''
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block
        if (b?.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, _json: '' }
        else if (b?.type === 'text') blocks[ev.index] = { type: 'text', text: '' }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          const blk = blocks[ev.index]
          if (blk?.type === 'text') blk.text += d.text
          roundText += d.text; full += d.text
          emit({ type: 'text', delta: d.text })
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const blk = blocks[ev.index]
          if (blk?.type === 'tool_use') blk._json += d.partial_json
        }
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = blocks.filter(Boolean).map((b: any) => {
      if (b.type !== 'tool_use') return { type: 'text', text: b.text }
      let input: Record<string, unknown> = {}
      try { input = b._json ? JSON.parse(b._json) : {} } catch { /* malformed input stays empty */ }
      return { type: 'tool_use', id: b.id, name: b.name, input }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUses = content.filter((b: any) => b.type === 'tool_use')
    if (stopReason !== 'tool_use' || toolUses.length === 0) {
      // Truncated mid-answer: report it instead of ending on a severed sentence.
      if (stopReason === 'max_tokens') { full += TRUNCATION_NOTE; emit({ type: 'text', delta: TRUNCATION_NOTE }) }
      break
    }
    messages.push({ role: 'assistant', content })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = []
    for (const tu of toolUses) {
      emit(statusFor(tu.name))
      const call: ToolCall = { id: tu.id, name: tu.name, args: (tu.input ?? {}) as Record<string, unknown> }
      const result = await execOnce(call, opts.ctx as ExecCtx, seen, trace, ui)
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result.content, is_error: !result.ok })
    }
    messages.push({ role: 'user', content: results })   // all parallel results in ONE user message
    if (roundText) { full += '\n\n'; emit({ type: 'text', delta: '\n\n' }) }   // next round starts a fresh paragraph
  }
  if (!full.trim()) { const fb = fallbackText(trace); if (fb) { full = fb; emit({ type: 'text', delta: fb }) } }
  return { model, text: full, ui, trace, rounds: rounds + 1 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function localLoopStream(opts: any, ui: any[], trace: LoopStep[], maxRounds: number, emit: (ev: LoopEvent) => void): Promise<LoopResult> {
  const model = 'gpt-oss-20b'
  const oaiTools = toOpenAITools(opts.tools)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'system', content: opts.system }, ...(opts.history ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'user', content: opts.userText }]
  let full = ''
  let rounds = 0
  const seen = new Set<string>()
  for (; rounds < maxRounds; rounds++) {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: true, temperature: 0.3, top_p: 0.9, max_tokens: MAX_TOKENS_LOCAL,
        tools: oaiTools, tool_choice: 'auto', reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' },
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok || !res.body) return { model, text: full, ui, trace, rounds, error: `llama HTTP ${res.status}` }
    // SSE reader — the proven shape from spectreLocal.streamChatOnce: forward delta.content
    // live, accumulate delta.tool_calls by index (arguments arrive as string fragments).
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let roundText = ''
    let finishReason = ''
    const acc: { id?: string; name: string; args: string }[] = []
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
          if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason
          const delta = obj.choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content) {
            roundText += delta.content; full += delta.content
            emit({ type: 'text', delta: delta.content })
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0
              if (!acc[i]) acc[i] = { id: tc.id, name: '', args: '' }
              if (tc.id) acc[i].id = tc.id
              if (tc.function?.name) acc[i].name = tc.function.name
              if (tc.function?.arguments) acc[i].args += tc.function.arguments
            }
          }
        } catch { /* skip malformed SSE line */ }
      }
    }
    const calls = acc.filter(Boolean).filter(t => t.name)
    if (!calls.length) {
      // 'length' is llama-server's max_tokens equivalent — same honesty rule as Claude.
      if (finishReason === 'length') { full += TRUNCATION_NOTE; emit({ type: 'text', delta: TRUNCATION_NOTE }) }
      break
    }
    const withIds = calls.map((t, i) => ({ ...t, id: t.id || `c${rounds}_${i}` }))
    messages.push({
      role: 'assistant', content: roundText,
      tool_calls: withIds.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })),
    })
    for (const t of withIds) {
      emit(statusFor(t.name))
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(t.args || '{}') } catch { /* empty */ }
      const call: ToolCall = { id: t.id, name: t.name, args }
      const result = await execOnce(call, opts.ctx as ExecCtx, seen, trace, ui)
      messages.push({ role: 'tool', tool_call_id: t.id, content: result.content })
    }
    if (roundText) { full += '\n\n'; emit({ type: 'text', delta: '\n\n' }) }
  }
  if (!full.trim()) { const fb = fallbackText(trace); if (fb) { full = fb; emit({ type: 'text', delta: fb }) } }
  return { model, text: full, ui, trace, rounds: rounds + 1 }
}

export async function runToolLoop(opts: {
  provider: 'claude' | 'local'
  modelId?: string
  system: string
  userText: string
  tools: ToolDef[]
  ctx: ExecCtx
  history?: { role: 'user' | 'assistant'; content: string }[]
  maxRounds?: number
}): Promise<LoopResult> {
  const maxRounds = opts.maxRounds ?? 5
  const ui: NonNullable<ToolResult['ui']>[] = []
  const trace: LoopStep[] = []
  try {
    if (opts.provider === 'claude') return await claudeLoop(opts, ui, trace, maxRounds)
    return await localLoop(opts, ui, trace, maxRounds)
  } catch (err) {
    return { model: opts.modelId ?? opts.provider, text: '', ui, trace, rounds: trace.length, error: err instanceof Error ? err.message : String(err) }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claudeLoop(opts: any, ui: any[], trace: LoopStep[], maxRounds: number): Promise<LoopResult> {
  const model = opts.modelId || 'claude-sonnet-4-6'
  const anthTools = toAnthropicTools(opts.tools)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [...(opts.history ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'user', content: opts.userText }]
  let finalText = ''
  let rounds = 0
  const seen = new Set<string>()
  for (; rounds < maxRounds; rounds++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client().messages.create({ model, max_tokens: MAX_TOKENS_SYNC, system: opts.system, tools: anthTools, messages } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = res.content ?? []
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const toolUses = blocks.filter(b => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
      finalText = res.stop_reason === 'max_tokens' ? text + TRUNCATION_NOTE : text
      break
    }
    messages.push({ role: 'assistant', content: blocks })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = []
    for (const tu of toolUses) {
      const call: ToolCall = { id: tu.id, name: tu.name, args: (tu.input ?? {}) as Record<string, unknown> }
      const result = await execOnce(call, opts.ctx as ExecCtx, seen, trace, ui)
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result.content, is_error: !result.ok })
    }
    messages.push({ role: 'user', content: results })   // all parallel results in ONE user message
  }
  return { model, text: finalText.trim() || fallbackText(trace), ui, trace, rounds: rounds + 1 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function localLoop(opts: any, ui: any[], trace: LoopStep[], maxRounds: number): Promise<LoopResult> {
  const model = 'gpt-oss-20b'
  const oaiTools = toOpenAITools(opts.tools)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'system', content: opts.system }, ...(opts.history ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'user', content: opts.userText }]
  let finalText = ''
  let rounds = 0
  const seen = new Set<string>()
  for (; rounds < maxRounds; rounds++) {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, temperature: 0.3, top_p: 0.9, max_tokens: MAX_TOKENS_LOCAL,
        tools: oaiTools, tool_choice: 'auto', reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' },
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { model, text: finalText, ui, trace, rounds, error: `llama HTTP ${res.status}` }
    const data = await res.json()
    const choice = data?.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    const toolCalls = msg.tool_calls ?? []
    if (!toolCalls.length) {
      const text = typeof msg.content === 'string' ? msg.content : ''
      finalText = choice.finish_reason === 'length' ? text + TRUNCATION_NOTE : text
      break
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls })
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch { /* empty */ }
      const call: ToolCall = { id: tc.id ?? '', name: tc.function?.name ?? '', args }
      const result = await execOnce(call, opts.ctx as ExecCtx, seen, trace, ui)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
    }
  }
  return { model, text: finalText.trim() || fallbackText(trace), ui, trace, rounds: rounds + 1 }
}

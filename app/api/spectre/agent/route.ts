// The unified tool-framework chat endpoint. One agentic loop serves BOTH Claude and local gpt-oss
// from the same tool registry — the model picks tools natively, the server executes them and feeds
// results back. This is the flag-gated replacement for the old prose-action + client-scraper +
// drain pipeline. Old /api/spectre is untouched and stays the default until this is proven on-device.
//
// v2 is STREAMING: the response is newline-delimited JSON events —
//   {type:'text', delta}                    — answer tokens, live, across every loop round
//   {type:'status', label, kind, tool}      — one per tool execution (silent status indicator)
//   {type:'ui', effects[]}                  — all UI effects, once, after the loop
//   {type:'done', model, rounds, error?}    — always the last event
// Mem0 is still deliberately absent (keeping action calls off the prose channel is the point);
// retrieval on this path is a documented follow-up.
import { getNode } from '@/lib/conversations'
import { toolsForContext } from '@/lib/tools/registry'
import { runToolLoop, runToolLoopStream } from '@/lib/tools/loop'
import { loadSpectreIdentity, TOOLS_BEHAVIOR } from '@/lib/spectreIdentity'
import { fetchMemories, saveTurnToMem0 } from '@/lib/mem0'
import type { ExecCtx } from '@/lib/tools/executor'
import { USER, USER_CAP } from '@/lib/profile'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await req.json().catch(() => ({}))
  const text = String(body.text || '')
  const modelId = String(body.modelId || 'claude-sonnet-4-6')
  const provider: 'claude' | 'local' = /local/.test(modelId) ? 'local' : 'claude'
  const projectNodeId = body.projectNodeId ? String(body.projectNodeId) : null
  const scope = body.scope ? String(body.scope) : (projectNodeId || 'main')
  const viewedDate = body.viewedDate ? String(body.viewedDate) : undefined
  // The active session id, so search_chats can exclude the conversation the user is in right now.
  const sessionId = body.sessionId ? String(body.sessionId) : null

  // Recent turns for context (client sends a bounded window). Only user/assistant text.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }))
    .slice(-12)

  const locName = (projectNodeId && getNode(projectNodeId)?.name) || (getNode(scope)?.name) || 'the dashboard'
  // The client assembles the live-awareness context (diagram tree + node primer + live dashboard/
  // arm data) via composeAgentContext — it holds the live refs. Fall back to a bare location line
  // if absent (older client / direct call). The per-minute timestamp rides the USER turn so the
  // system prefix stays stable for the prompt cache.
  const clientContext = body.context ? String(body.context) : ''
  const contextBlock = clientContext || `Current location: ${locName}.`
  const nowLine = body.now ? String(body.now) : ''
  // Full Spectre identity (spectre_core.md, live-reloaded) + the tool-behavior contract + live
  // context. Identity gives Spectre its voice; TOOLS_BEHAVIOR is appended AFTER so it stays
  // authoritative on tool mechanics; the live context lets it SEE the user's day.
  // VOICE MODE (the "vertical line vertical line" bug — TTS reading table pipes aloud) — when the reply
  // will be HEARD, not read, Spectre must know it: no tables, no markdown, no visual
  // structure of any kind. Conversational prose only. The client also strips markdown
  // before TTS, but the model not producing it in the first place is the real fix.
  const voiceNote = body.voice === true
    ? `\n\n---\n\nVOICE MODE — this conversation is SPOKEN. ${USER_CAP} is listening, often with their hands busy; they cannot see your reply. Absolute rules: NO tables, NO markdown formatting, NO pipes, NO bullet or numbered lists, NO headers, NO code blocks — nothing visual. Speak in natural conversational sentences, the way you would say it out loud. If data is tabular by nature, summarize the few values that matter in prose. You still have the full conversation context and all your tools.
TURN-TAKING (this is a conversation, not a lecture): replies are SHORT — one to three sentences, then yield the floor. One thought at a time. Never monologue; if there is genuinely more to say, give the single most important piece and end with something that invites them to continue ("want the next part?", "should I keep going?") — at most one brief question. Match their energy: a short remark gets a short reply. They must never sit through a minute of listening; the rhythm is back-and-forth.`
    : ''
  const system = `${loadSpectreIdentity()}\n\n---\n\n${TOOLS_BEHAVIOR}\n\n---\n\n${contextBlock}\n\nResolve document/file ids by calling list_documents when you need them; never ask ${USER} for an id.${voiceNote}`
  // Mem0 skipped for the hidden greeting or when explicitly disabled.
  const skipMemory = body.skipMemory === true
  // Voice prioritizes latency: a slow Mem0 degrades to "no memory this turn" fast (1.5s) rather
  // than stalling the spoken reply; typed keeps the generous ceiling.
  const voice = body.voice === true
  const memTimeout = voice ? 1500 : 4000

  // runNested drives tell_secretary's nested Secretary loop. The Secretary is LOCAL-FIRST
  // (the Librarian precedent + near-$0): it runs on local gpt-oss even when
  // Spectre itself is on Claude, and only falls back to the parent turn's model if the local
  // stack is unreachable. Returns a minimal shape so the executor never imports the loop's types.
  const runNested: ExecCtx['runNested'] = async (o) => {
    let res = await runToolLoop({ provider: 'local', modelId: 'local-gpt-oss', system: o.system, userText: o.userText, tools: o.tools, ctx: o.ctx, maxRounds: o.maxRounds })
    if (res.error && provider !== 'local') {
      res = await runToolLoop({ provider, modelId, system: o.system, userText: o.userText, tools: o.tools, ctx: o.ctx, maxRounds: o.maxRounds })
    }
    return { text: res.text, ui: res.ui, steps: res.trace.map(s => ({ ok: s.result.ok, content: s.result.content })) }
  }
  const ctx: ExecCtx = { scope, projectNodeId, sessionId, viewedDate, userText: text, runNested }
  const tools = toolsForContext(!!projectNodeId)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => { try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch { /* client went away */ } }
      try {
        // Memory retrieval on the CURRENT user turn (off the cacheable system prefix). A tight
        // ceiling so a slow Mem0 degrades to "no memory this turn" instead of stalling the reply.
        const memBlock = skipMemory ? '' : await fetchMemories(text, memTimeout)
        const userText = [nowLine, memBlock, text].filter(Boolean).join('\n\n')
        // Generous round budget so a "read these several papers and plan" turn can read them all
        // (Claude often reads many in ONE round via parallel tool calls) and still synthesize.
        const result = await runToolLoopStream(
          { provider, modelId, system, userText, tools, ctx, history, maxRounds: 10 },
          ev => send(ev),
        )
        send({ type: 'ui', effects: result.ui })
        send({ type: 'done', model: result.model, rounds: result.rounds, error: result.error })
        // Save the exchange (fire-and-forget) — clean user text in, so Mem0 isn't polluted.
        if (!skipMemory && result.text.trim()) void saveTurnToMem0(text, result.text)
      } catch (err) {
        send({ type: 'done', error: err instanceof Error ? err.message : 'failed' })
      }
      try { controller.close() } catch { /* already closed */ }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

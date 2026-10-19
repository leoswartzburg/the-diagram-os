// Tool-selection probe — the test harness for the unified framework. Given a user message and a
// scope, it renders the registry into each model's native tool format and asks the model which
// tool(s) it would call, WITHOUT executing anything. This is how we verify that ONE clean registry
// + a slim prompt makes BOTH Claude and local gpt-oss reliably pick the right tool with the right
// args — the whole thesis of the overhaul. Safe: it never runs a tool, so nothing mutates.
import Anthropic from '@anthropic-ai/sdk'
import { toAnthropicTools, toOpenAITools, type ToolCall } from './adapters'
import type { ToolDef } from './registry'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
let _client: Anthropic | null = null
const client = () => _client ?? (_client = new Anthropic())

// The ENTIRE instructional prompt the models get for tools — deliberately tiny. The per-tool
// descriptions in the registry carry the rest. (Contrast the old ~2.5k tokens of prose per turn.)
export const TOOLS_SYSTEM = `You are Spectre, the AI operating system of The Diagram. You have tools that let you act on the system — navigate the workspace, save and read documents, manage the calendar, search, run research, update projects and workouts. When a request needs an action, or needs information you'd have to look up, CALL the right tool. When it's just conversation, reply normally. Never describe the tools, print JSON, or narrate the mechanics of calling them — use the native tool interface.`

export type ProbeResult = { model: string; calls: ToolCall[]; text: string; stopReason: string; error?: string }

export async function probeClaude(system: string, text: string, tools: ToolDef[], modelId: string): Promise<ProbeResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client().messages.create({
      model: modelId,
      max_tokens: 1024,
      system,
      tools: toAnthropicTools(tools),
      messages: [{ role: 'user', content: text }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = res.content ?? []
    const calls: ToolCall[] = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }))
    const out = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    return { model: modelId, calls, text: out, stopReason: res.stop_reason ?? '' }
  } catch (err) {
    return { model: modelId, calls: [], text: '', stopReason: '', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function probeLocal(system: string, text: string, tools: ToolDef[]): Promise<ProbeResult> {
  try {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oss-20b', stream: false, temperature: 0.3, top_p: 0.9, max_tokens: 1024,
        tools: toOpenAITools(tools), tool_choice: 'auto',
        reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return { model: 'gpt-oss-20b', calls: [], text: '', stopReason: '', error: `HTTP ${res.status}` }
    const data = await res.json()
    const choice = data?.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch { /* leave empty on unparseable args */ }
      return { id: tc.id ?? '', name: tc.function?.name ?? '', args }
    })
    return { model: 'gpt-oss-20b', calls, text: typeof msg.content === 'string' ? msg.content : '', stopReason: choice.finish_reason ?? '' }
  } catch (err) {
    return { model: 'gpt-oss-20b', calls: [], text: '', stopReason: '', error: err instanceof Error ? err.message : String(err) }
  }
}

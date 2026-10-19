// ── ADAPTERS — render the one registry into each model's native tool format ───────
//
// This is the ONLY place the two models differ. The registry is the message; these are the
// two languages it gets printed in. Claude speaks Anthropic's tool format; local gpt-oss (via
// llama-server) speaks OpenAI's. Same tools, same names, same schemas — different envelope.
// Everything downstream (normalizing calls, executing them, feeding results back) is shared,
// which is what makes switching models mid-conversation seamless.
import type { ToolDef } from './registry'

// Anthropic native tools: { name, description, input_schema }.
// Passed as the `tools` array on the Messages API call; Claude replies with `tool_use` blocks.
export function toAnthropicTools(tools: ToolDef[]) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

// OpenAI-style tools: { type:'function', function:{ name, description, parameters } }.
// Passed as the `tools` array to llama-server; gpt-oss replies with `tool_calls`.
// additionalProperties:true mirrors the previously-working local tool schema (protocol fields
// the harmony template may add still pass validation).
export function toOpenAITools(tools: ToolDef[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: { ...t.parameters, additionalProperties: true },
    },
  }))
}

// ── One normalized call shape both providers converge on ──────────────────────────
// Claude `tool_use` blocks and gpt-oss `tool_calls` both get mapped to this, so the executor
// and history layer never care which model produced it.
export type ToolCall = {
  id: string          // provider-supplied call id (for pairing the result back)
  name: string        // tool name from the registry
  args: Record<string, unknown>
}

// The result of running one ToolCall — fed back to the model as a tool_result (agentic loop),
// and/or surfaced to the client as a UI effect. `ok` is the honest signal: the model only ever
// claims success it actually received.
export type ToolResult = {
  id: string
  name: string
  ok: boolean
  // For 'read' tools: the content the model should answer from. For 'mutate'/'ui': a short ack.
  content: string
  // Optional UI effects for the client to apply. A server-executed mutate emits refresh/open hints
  // so the screen catches up; a client-only tool (navigate, gym, deep-research) is validated + acked
  // server-side and its call is proxied verbatim in `client_action` for the client to perform.
  ui?: {
    navigate?: string                                    // node id to navigate to
    open_document?: { id: string; mode?: string }
    open_file?: string
    refresh?: string[]                                   // panels to reload: 'notebooks' | 'calendar' | 'nodes'
    client_action?: { name: string; args: Record<string, unknown> }   // proxied client-only tool
  }
}

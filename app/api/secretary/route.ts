// The Secretary's chat endpoint — the direct access path (the map overlay's docked bar +
// the personal-scope variant). Stateless like /api/spectre/agent: the client owns session
// persistence (folder_id 'secretary-<nodeId>' / 'secretary-main'). Same NDJSON event
// stream as the agent route. NO Mem0 on this path, by design.
import { runToolLoopStream } from '@/lib/tools/loop'
import { toolsForSecretary, secretarySystemFor } from '@/lib/tools/secretary'
import type { ExecCtx } from '@/lib/tools/executor'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await req.json().catch(() => ({}))
  const text = String(body.text || '')
  const modelId = String(body.modelId || 'local-gpt-oss')   // local-first (Librarian precedent); Claude by request
  const provider: 'claude' | 'local' = /local/.test(modelId) ? 'local' : 'claude'
  const nodeId = body.node_id ? String(body.node_id) : null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }))
    .slice(-10)

  // Per-turn system prompt: identity + timestamp + the live T1/T2 task listing. The refs
  // snapshot rides ExecCtx so the executor resolves exactly what the model was shown.
  const { system, refs } = secretarySystemFor(nodeId, new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
  const ctx: ExecCtx = { scope: nodeId ?? 'main', projectNodeId: nodeId, actor: 'secretary', taskRefs: refs, userText: text }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => { try { controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n')) } catch { /* client gone */ } }
      try {
        const result = await runToolLoopStream(
          { provider, modelId, system, userText: text, tools: toolsForSecretary(), ctx, history, maxRounds: 6 },
          ev => send(ev),
        )
        send({ type: 'ui', effects: result.ui })
        send({ type: 'done', model: result.model, rounds: result.rounds, error: result.error, trace: result.trace.map(s => ({ tool: s.call.name, ok: s.result.ok, content: s.result.content })) })
      } catch (err) {
        send({ type: 'done', error: err instanceof Error ? err.message : 'failed' })
      }
      try { controller.close() } catch { /* already closed */ }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  })
}

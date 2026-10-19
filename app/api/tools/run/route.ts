// Test-only endpoint: run the full agentic tool loop for one message with a given model, and
// return the final answer + the tool trace + the UI effects. Executes real reads and (if the
// message asks for one) real mutations — use with care. Seeds the real /api/spectre rewrite.
import { NextResponse } from 'next/server'
import { toolsForContext } from '@/lib/tools/registry'
import { runToolLoop } from '@/lib/tools/loop'
import { TOOLS_SYSTEM } from '@/lib/tools/probe'
import type { ExecCtx } from '@/lib/tools/executor'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const text = String(body.text || '')
    const projectNodeId = body.projectNodeId ? String(body.projectNodeId) : null
    const scope = body.scope ? String(body.scope) : (projectNodeId || 'main')
    const provider = body.provider === 'local' ? 'local' : 'claude'
    const modelId = String(body.modelId || 'claude-sonnet-4-6')
    const ctx: ExecCtx = { scope, projectNodeId, viewedDate: body.viewedDate ? String(body.viewedDate) : undefined }
    const tools = toolsForContext(!!projectNodeId)
    const result = await runToolLoop({ provider, modelId, system: TOOLS_SYSTEM, userText: text, tools, ctx })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

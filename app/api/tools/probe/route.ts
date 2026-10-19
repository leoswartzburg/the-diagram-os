// Test-only endpoint for the unified tool framework. Renders the registry for a scope, asks a
// model which tool(s) it would call for a message, and returns the result WITHOUT executing.
// Used to measure tool-selection reliability across Claude and local gpt-oss. Safe (no mutation).
// slice:'secretary' probes the Secretary's task-tool slice with its real per-turn system prompt
// (identity + timestamp + live T1/T2 task listing) — the pre-build tool-selection battery.
import { NextResponse } from 'next/server'
import { toolsForContext } from '@/lib/tools/registry'
import { toolsForSecretary, secretarySystemFor } from '@/lib/tools/secretary'
import { probeClaude, probeLocal, TOOLS_SYSTEM } from '@/lib/tools/probe'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const text = String(body.text || '')
    const scope: 'core' | 'project' = body.scope === 'project' ? 'project' : 'core'
    const which = body.which === 'claude' ? 'claude' : body.which === 'local' ? 'local' : 'both'
    const modelId = String(body.modelId || 'claude-sonnet-4-6')
    const secretary = body.slice === 'secretary'
    const tools = secretary ? toolsForSecretary() : toolsForContext(scope === 'project')
    const system = secretary
      ? secretarySystemFor(body.node_id ? String(body.node_id) : null, new Date().toLocaleString()).system
      : TOOLS_SYSTEM
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { text, scope: secretary ? 'secretary' : scope, toolCount: tools.length }
    if (which === 'claude' || which === 'both') out.claude = await probeClaude(system, text, tools, modelId)
    if (which === 'local' || which === 'both') out.local = await probeLocal(system, text, tools)
    return NextResponse.json(out)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { promisify } from 'util'
import { exec as _exec } from 'child_process'
import { isAuthorizedSystemRequest, validToken } from '@/lib/systemAuth'

export const dynamic = 'force-dynamic'
const exec = promisify(_exec)

async function ollamaPs(): Promise<string> {
  try {
    const { stdout } = await exec('ollama ps')
    return stdout
  } catch {
    return ''
  }
}

// POST { action: 'stop' | 'status', model?: string }
// General Ollama model unload/status control. (The voice failover no longer
// uses this — the local stack is always-on and /api/tts degrades internally.)
export async function POST(req: NextRequest) {
  if (!isAuthorizedSystemRequest(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const action: string = body?.action

  if (action === 'status') {
    return NextResponse.json({ ok: true, loaded: await ollamaPs() })
  }

  if (action === 'stop') {
    const model = body?.model
    if (!validToken(model)) {
      return NextResponse.json({ error: 'invalid model' }, { status: 400 })
    }
    // May already be stopped — ignore the error and verify via `ollama ps`.
    try { await exec(`ollama stop ${model}`) } catch { /* not loaded */ }

    // Poll until the model is gone from the loaded set (max ~8s).
    let unloaded = false
    for (let i = 0; i < 8; i++) {
      const ps = await ollamaPs()
      if (!ps.includes(model)) { unloaded = true; break }
      await new Promise(r => setTimeout(r, 1000))
    }
    return NextResponse.json({ ok: true, unloaded })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}

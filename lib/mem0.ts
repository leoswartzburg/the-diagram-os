// Mem0 — Spectre's persistent memory (self-hosted, local). Retrieval before a turn, save after.
// Extracted so the unified tool-framework path (/api/spectre/agent) shares the exact behavior the
// legacy /api/spectre route has always had. Self-catching: Mem0 down → "" / no-op, never throws.
import { USER } from './profile'

const MEM0_URL = process.env.MEM0_API_URL ?? 'http://localhost:8000'
// The Mem0 user id all memories are stored under (single-user system). Keep in sync with
// mem0/server.py's default and app/api/spectre/route.ts.
const MEM0_USER_ID = process.env.MEM0_USER_ID || 'default'

// Search the user's memories relevant to the current turn, formatted as a [MEMORY] block to prepend
// to the user turn (keeping it off the cacheable system prefix). Empty string when thin/down.
export async function fetchMemories(query: string, timeoutMs = 8000): Promise<string> {
  try {
    const res = await fetch(`${MEM0_URL}/v1/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, user_id: MEM0_USER_ID, limit: 8 }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    if (!res.ok) return ''
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(data) ? data : (data.results ?? data.memories ?? [])
    const lines = items.filter(m => m.memory || m.content).map(m => `- ${m.memory ?? m.content}`)
    if (!lines.length) return ''
    return `[MEMORY — what Spectre already knows about ${USER}]\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

// Save a completed exchange for extraction/consolidation. Fire-and-forget (never awaited on the
// critical path). The clean user text is passed separately so action mechanics don't pollute Mem0.
export async function saveTurnToMem0(userMessage: string, assistantMessage: string): Promise<void> {
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

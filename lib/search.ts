// ── Web search (Tavily) ───────────────────────────────────────────────────────────
// Model-agnostic web search so Spectre can ground answers in live information regardless
// of backend (Claude or local gpt-oss). Tavily returns clean, LLM-ready extracted content
// in one REST call — no separate scrape/fetch step. Used by BOTH the chat path
// (lib/spectreLocal.ts server-executes a webSearch tool call) and the deep-research pipeline
// (app/api/research replaces Anthropic's native web_search with this).
//
// ERROR POLICY: never throws. A missing key / network failure / Tavily error returns
// { ok:false, results:[] } so callers degrade silently (the model just answers without it).
//
// SETUP: add TAVILY_API_KEY=tvly-... to .env.local (free tier: tavily.com → 1,000/mo).

const TAVILY_URL = 'https://api.tavily.com/search'

export type SearchHit = { title: string; url: string; content: string; score?: number }
export type SearchResponse = { ok: boolean; query: string; answer?: string; results: SearchHit[] }

// True when a key is present — lets the route/tools advertise web search only when it works.
export function isSearchConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY
}

export async function tavilySearch(
  query: string,
  opts: {
    maxResults?: number
    depth?: 'basic' | 'advanced'   // 'advanced' = deeper crawl + fuller content (research)
    includeAnswer?: boolean         // Tavily's own synthesized answer (handy for chat)
    includeRawContent?: boolean     // full extracted page text (research agents digest this)
    signal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<SearchResponse> {
  const q = (query || '').trim()
  if (!q) return { ok: false, query: '', results: [] }
  const key = process.env.TAVILY_API_KEY
  if (!key) {
    console.warn('[search] TAVILY_API_KEY not set — web search unavailable')
    return { ok: false, query: q, results: [] }
  }
  const {
    maxResults = 5, depth = 'basic', includeAnswer = true,
    includeRawContent = false, signal, timeoutMs = 15000,
  } = opts
  // Chain the caller's abort signal with our own timeout so STOP and the ceiling both fire.
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: q,
        search_depth: depth,
        max_results: Math.max(1, Math.min(20, maxResults)),
        include_answer: includeAnswer,
        include_raw_content: includeRawContent,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn('[search] Tavily non-OK:', res.status, await res.text().catch(() => ''))
      return { ok: false, query: q, results: [] }
    }
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: SearchHit[] = (Array.isArray(data?.results) ? data.results : []).map((r: any) => ({
      title: String(r?.title ?? r?.url ?? 'Untitled'),
      url: String(r?.url ?? ''),
      // raw_content (full page) when requested, else the snippet — both are clean text.
      content: String(r?.raw_content || r?.content || '').trim(),
      score: typeof r?.score === 'number' ? r.score : undefined,
    })).filter((r: SearchHit) => r.url)
    return { ok: true, query: q, answer: data?.answer ? String(data.answer) : undefined, results }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/abort/i.test(msg)) console.warn('[search] Tavily aborted (timeout/stop):', q.slice(0, 60))
    else console.warn('[search] Tavily error:', msg)
    return { ok: false, query: q, results: [] }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// Compact a search response into a token-bounded block for prompt injection (chat tool
// result / research findings). Caps total length and per-hit content so a big crawl can't
// blow the context window.
export function formatSearchResults(r: SearchResponse, opts: { maxChars?: number; perHitChars?: number } = {}): string {
  const { maxChars = 6000, perHitChars = 1200 } = opts
  if (!r.results.length) return r.ok ? `No web results found for "${r.query}".` : `Web search is unavailable for "${r.query}".`
  let out = ''
  if (r.answer) out += `Answer: ${r.answer}\n\n`
  for (let i = 0; i < r.results.length; i++) {
    const h = r.results[i]
    const body = h.content.length > perHitChars ? h.content.slice(0, perHitChars) + '…' : h.content
    const entry = `[${i + 1}] ${h.title}\n${h.url}\n${body}\n\n`
    if (out.length + entry.length > maxChars) break
    out += entry
  }
  return out.trim()
}

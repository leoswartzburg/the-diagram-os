// ── Full-page content fetch (Playwright service) ─────────────────────────────────────
// Tavily discovers URLs; this fetches the FULL readable text of each page with a real headless
// browser (handles JS-rendered / dynamic content a raw fetch can't). Used ONLY by the deep-research
// pipeline's Deep + Exhaustive modes — never conversational chat search.
//
// ERROR POLICY: never throws. If the Playwright container is down or a fetch fails, the affected
// URL comes back ok:false (empty text) so the caller degrades gracefully to Tavily's snippet.
//
// The container is `playwright` in docker-compose (POST /fetch on :8009). Override with PLAYWRIGHT_URL.

const PLAYWRIGHT_URL = process.env.PLAYWRIGHT_URL ?? 'http://localhost:8009'

export type PageLink = { url: string; text: string }
export type PageContent = { url: string; ok: boolean; status: number; title: string; text: string; links: PageLink[] }

// Fast pre-flight so a downed container costs ~1.5s, not a hung research run.
export async function isPlaywrightUp(timeoutMs = 1800): Promise<boolean> {
  try {
    const r = await fetch(`${PLAYWRIGHT_URL}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    return r.ok
  } catch {
    return false
  }
}

// Fetch full content for a batch of URLs. Returns one PageContent per input URL (order preserved);
// failures are ok:false rather than thrown. `followLinks` returns discovered on-page links (for the
// Exhaustive crawl). `signal` chains the research run's abort so STOP kills an in-flight fetch.
export async function fetchPages(
  urls: string[],
  opts: { maxChars?: number; followLinks?: boolean; maxLinks?: number; concurrency?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PageContent[]> {
  const list = (urls || []).filter(u => typeof u === 'string' && /^https?:/i.test(u)).slice(0, 50)
  if (!list.length) return []
  const { maxChars = 20000, followLinks = false, maxLinks = 40, concurrency = 4, signal, timeoutMs = 60000 } = opts
  // Chain the run's abort with a generous batch ceiling.
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${PLAYWRIGHT_URL}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: list, maxChars, followLinks, maxLinks, concurrency }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn('[fetchContent] playwright non-OK:', res.status)
      return list.map(url => ({ url, ok: false, status: 0, title: '', text: '', links: [] }))
    }
    const data = await res.json()
    const results: PageContent[] = Array.isArray(data?.results) ? data.results : []
    // Normalize + guarantee one entry per requested URL.
    const byUrl = new Map(results.map((r: PageContent) => [r.url, r]))
    return list.map(url => byUrl.get(url) ?? { url, ok: false, status: 0, title: '', text: '', links: [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/abort/i.test(msg)) console.warn('[fetchContent] playwright aborted (stop/timeout)')
    else console.warn('[fetchContent] playwright error (container down?):', msg)
    return list.map(url => ({ url, ok: false, status: 0, title: '', text: '', links: [] }))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

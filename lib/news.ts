// The morning read — "Curated For You", made real. Compiled once per day, in the morning,
// on the LOCAL model (gpt-oss — free) from live Tavily search over the TOPICS list below
// (edit it to your interests). The point: a 5-minute breakfast read that replaces phone
// scrolling and reconnects you with what you're building toward — so every summary says
// why it matters, never generic filler.
// Alongside the items: a short Spectre "morning note" grounded in yesterday's Scribe
// chapter + today's rhythm shape. Zero fabrication — thin results → fewer items, honestly.
// Error policy: house vault rule — never throws into a caller; a dead Tavily/LLM leaves
// the day absent (the route reports 'compiling' and a later tick retries after cooldown).
import Anthropic from '@anthropic-ai/sdk'
import { getNewsDay, upsertNewsDay, getScribeEntry, addInboxEvent } from './conversations'
import { localDateStr } from './nowList'
import { todayShape } from './rhythm'
import { tavilySearch, formatSearchResults, isSearchConfigured } from './search'
import { USER_POSS } from './profile'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
const LOCAL_MODEL = 'gpt-oss-20b'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const FAIL_COOLDOWN_MS = 10 * 60_000

export type NewsItem = { title: string; summary: string; source: string; url: string; topic: string }

// ─────────────────────────────────────────────────────────────────────────────
// EDIT THESE TO YOUR INTERESTS. Each entry is one live web search; `topic` is the short
// tag shown on the card, `query` is what gets searched. Order = priority when results are
// thin. The defaults below are generic placeholders.
// ─────────────────────────────────────────────────────────────────────────────
const TOPICS: { topic: string; query: string }[] = [
  { topic: 'AI research', query: 'AI machine learning research breakthrough news' },
  { topic: 'software', query: 'software engineering developer tools open source news' },
  { topic: 'science', query: 'science research discovery news this week' },
  { topic: 'tech', query: 'technology industry news hardware devices' },
  { topic: 'local AI', query: 'local LLM on-device AI open-weights model agents news' },
]
const TOPIC_TAGS = TOPICS.map(t => t.topic).join(' / ')

let _client: Anthropic | null = null
function client(): Anthropic { return _client ?? (_client = new Anthropic()) }

// Local-first LLM call (the Scribe pattern): gpt-oss non-streaming, Haiku fallback.
async function localChat(system: string, user: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  try {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL, stream: false, temperature: 1.0, top_p: 1.0, max_tokens: maxTokens,
        reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? { text: content.trim(), model: LOCAL_MODEL } : null
  } catch { return null }
}
async function claudeChat(system: string, user: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client().messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    const text = (res?.content ?? []).map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : '')).join('').trim()
    return text ? { text, model: CLAUDE_MODEL } : null
  } catch { return null }
}
async function curatorChat(system: string, user: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  return (await localChat(system, user, maxTokens)) ?? (await claudeChat(system, user, maxTokens))
}

// Tolerant JSON-array extraction: strip fences, slice first '[' to last ']'.
function parseItems(raw: string): NewsItem[] | null {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const a = cleaned.indexOf('['), b = cleaned.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    const arr = JSON.parse(cleaned.slice(a, b + 1))
    if (!Array.isArray(arr)) return null
    const items: NewsItem[] = []
    for (const it of arr) {
      const title = String(it?.title ?? '').trim()
      const url = String(it?.url ?? '').trim()
      if (!title || !/^https?:\/\//.test(url)) continue
      items.push({
        title,
        summary: String(it?.summary ?? '').trim(),
        source: String(it?.source ?? '').trim() || new URL(url).hostname.replace(/^www\./, ''),
        url,
        topic: String(it?.topic ?? '').trim(),
      })
      if (items.length >= 6) break
    }
    return items
  } catch { return null }
}

const CURATOR_SYSTEM = `You curate ${USER_POSS} 5-minute morning read, built around their interests: ${TOPIC_TAGS} (the topic list the results were searched from). The read exists to replace morning phone-scrolling and reconnect them with what they are building toward.

From the web results provided, pick the 4–6 genuinely most interesting, most recent items. Output ONLY a JSON array:
[{"title": "...", "summary": "...", "source": "...", "url": "...", "topic": "..."}]

Rules:
- Use ONLY the provided results — every url must come verbatim from them. Never invent items.
- "summary": 2–3 sentences. Lead with what happened, end with why it matters to someone following these topics. Concrete, no hype.
- "source": the publication/site name. "topic": one short tag (${TOPIC_TAGS}).
- Prefer new results over evergreen pages; skip listicles, ads, and duplicates of the same story.
- Thin results → fewer items. Nothing usable → output [].`

const NOTE_SYSTEM = `You are Spectre — ${USER_POSS} AI, writing their 3–4 sentence morning note for breakfast. Grounded and specific: reference what actually happened yesterday (from the chapter, if given) without inventing anything, name today's shape, and point them forward — where their attention goes first. Warm, steady, zero guilt, zero pep-talk clichés. If they were wrestling with something yesterday, acknowledge it in one clause and anchor them to the concrete next step. Never fabricate events. Output the note text only.`

let _inflight: Promise<NewsItem[] | null> | null = null
let _lastFailAt = 0

// Compile today's read if it doesn't exist. Self-guarded: instant no-op when the day is
// already compiled, single-flight when a compile is running, cooldown after a failure.
export async function generateMorningNews(force = false): Promise<NewsItem[] | null> {
  const today = localDateStr(Date.now())
  if (!force) {
    const existing = getNewsDay(today)
    if (existing) { try { return JSON.parse(existing.items_json) } catch { return [] } }
    if (Date.now() - _lastFailAt < FAIL_COOLDOWN_MS) return null
  }
  if (_inflight) return _inflight
  _inflight = (async () => {
    try {
      if (!isSearchConfigured()) {
        upsertNewsDay({ date: today, items_json: '[]', morning_note: 'No live searches — add TAVILY_API_KEY to compile the morning read.', model: 'none' })
        return []
      }
      // 1. Search each topic (parallel; self-catching per topic).
      const searches = await Promise.all(TOPICS.map(async t => {
        const r = await tavilySearch(t.query, { maxResults: 4, timeoutMs: 20_000 })
        return { topic: t.topic, block: formatSearchResults(r, { maxChars: 2400, perHitChars: 550 }) }
      }))
      const corpus = searches.map(s => `### TOPIC: ${s.topic}\n${s.block}`).join('\n\n')
      // 2. Curate on the local model (Haiku fallback).
      const curated = await curatorChat(CURATOR_SYSTEM, corpus, 1600)
      const items = curated ? parseItems(curated.text) : null
      if (!items) { _lastFailAt = Date.now(); console.warn('[news] curation failed — will retry after cooldown'); return null }
      // 3. Spectre's morning note (yesterday's chapter + today's shape). Best-effort.
      let note = ''
      let noteModel = ''
      try {
        const yesterday = localDateStr(Date.now() - 86_400_000)
        const ch = getScribeEntry(yesterday)
        const user = `Yesterday's chapter${ch?.narrative ? `:\n${ch.narrative.slice(0, 1600)}` : ': (no chapter was written)'}\n\nToday's shape: ${todayShape(new Date())}`
        const n = await curatorChat(NOTE_SYSTEM, user, 300)
        if (n) { note = n.text; noteModel = n.model }
      } catch { /* the read stands without the note */ }
      upsertNewsDay({ date: today, items_json: JSON.stringify(items), morning_note: note, model: curated?.model ?? noteModel })
      if (items.length) addInboxEvent({ kind: 'news', title: 'Morning read compiled', body: `${items.length} stories on your topics — with breakfast.` })
      console.log(`[news] morning read compiled — ${items.length} items (${curated?.model})`)
      return items
    } catch (e) {
      _lastFailAt = Date.now()
      console.warn('[news] compile failed:', (e as Error).message)
      return null
    } finally {
      _inflight = null
    }
  })()
  return _inflight
}

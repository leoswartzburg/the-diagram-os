import { NextRequest, NextResponse } from 'next/server'
import { listScribeEntries, getScribeEntry, getQuoteOfDay, getWordOfDay, type ScribeEntryRow } from '@/lib/conversations'
import { generateScribeDay, generateQuoteOfDay, ensureScribeFresh, localDateStr } from '@/lib/scribe'
import { advanceWord, pronFor } from '@/lib/vocab'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// The Chronicle. GET = read stored entries (fast, no LLM). POST = generate/refresh.
// Everything self-catches so the ribbon never errors the dashboard.

function payload(): { latest: ScribeEntryRow | null; entries: ScribeEntryRow[]; today: string; quote: { quote: string; author: string }; word: { word: string; def: string; pron: string } } {
  let entries: ScribeEntryRow[] = []
  try { entries = listScribeEntries(180) } catch { entries = [] }
  // "today" is the SERVER's local day (where the data lives + messages are timestamped). The client
  // uses this for the TODAY label instead of the browser clock — the app may be accessed remotely across tz.
  const today = localDateStr(new Date())
  const latest = (() => { try { return getScribeEntry(today) ?? entries[0] ?? null } catch { return entries[0] ?? null } })()
  const quote = (() => { try { const q = getQuoteOfDay(); return { quote: q.quote, author: q.author } } catch { return { quote: '', author: '' } } })()
  const word = (() => { try { const w = getWordOfDay(); return { word: w.word, def: w.def, pron: pronFor(w.word) } } catch { return { word: '', def: '', pron: '' } } })()
  return { latest: latest ?? null, entries, today, quote, word }
}

export async function GET() {
  return NextResponse.json(payload())
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  try {
    if (body?.rewrite) {
      // Manual "redo today" — regenerate the whole day cleanly from scratch, then refresh the quote.
      const date = body.date ? String(body.date) : localDateStr(new Date())
      await generateScribeDay(date, { rewrite: true })
      await generateQuoteOfDay(date).catch(() => {})
    } else if (body?.date) {
      // Explicit (re)generation of one day — a nightly trigger, etc.
      await generateScribeDay(String(body.date), { finalize: !!body.finalize })
    } else {
      // Lazy maintenance — refresh today's live chapter + finalize an unlocked past day.
      await ensureScribeFresh(Date.now())
    }
  } catch (err) {
    console.error('[Scribe] generate failed:', err instanceof Error ? err.message : String(err))
    // fall through — return whatever is stored
  }
  // Seed the first word of the day if none is set yet (the scheduler rotates it 2x/day thereafter).
  try { if (!getWordOfDay().word) advanceWord() } catch { /* non-fatal */ }
  return NextResponse.json(payload())
}

// The morning read — Curated For You. GET returns today's compiled items (or kicks off
// a compile and reports 'compiling'); ?refresh=1 forces a recompile. Generation runs on
// the local model via lib/news.ts and is also auto-triggered by the notify scheduler
// once the machine is on in the morning.
import { NextResponse } from 'next/server'
import { getNewsDay } from '@/lib/conversations'
import { generateMorningNews } from '@/lib/news'
import { localDateStr } from '@/lib/nowList'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1'
    const today = localDateStr(Date.now())
    if (!refresh) {
      const row = getNewsDay(today)
      if (row) {
        let items = []
        try { items = JSON.parse(row.items_json) } catch { /* empty */ }
        return NextResponse.json({ date: today, status: 'ready', items, morning_note: row.morning_note, model: row.model })
      }
    }
    void generateMorningNews(refresh)   // fire-and-forget; self-guarded single-flight
    return NextResponse.json({ date: today, status: 'compiling', items: [], morning_note: '' })
  } catch (err) {
    return NextResponse.json({ date: '', status: 'error', items: [], morning_note: '', error: err instanceof Error ? err.message : 'failed' }, { status: 200 })
  }
}

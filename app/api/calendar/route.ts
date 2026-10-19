import { NextRequest, NextResponse } from 'next/server'
import {
  isConnected, listEvents, createEvent, updateEvent, deleteEvent,
  type EventInput, type CalendarEvent,
} from '@/lib/gcal'
import { listNodes, getBlock, upsertBlock, findSeriesLink, isTombstoned, sweepBlocks } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

// ── Block auto-matcher — THE single choke point ─────────────────
// Every calendar fetch funnels through this GET, so this is where a "Research 10–5"
// event deterministically becomes a project-linked time block. Zero AI. Rules:
//  · existing links get their stored time/title refreshed (reschedules stay true)
//  · tombstones (matched='unlinked', by id or series) are NEVER resurrected
//  · a manual link on any instance of a recurring series covers every instance
//  · title match = resolveNode tiers (exact → contains, ≥3 chars) against project Hands
//  · the reconcile sweep runs ONLY on the recurring ~7-day fetch (never month browsing),
//    is range-scoped, and never touches past blocks (ended ≠ deleted)
// Self-catching: block bookkeeping must never break the calendar fetch.
function autoMatchBlocks(events: CalendarEvent[], windowStartMs: number, windowEndMs: number, isWeekFetch: boolean): void {
  try {
    const hands = listNodes().filter(n => n.level === 'hand' && n.parent_id === 'projects')
    const present = new Set<string>()
    for (const e of events) {
      present.add(e.id)
      if (e.allDay) continue                       // blocks are timed; all-day events can still be linked manually
      const startMs = new Date(e.start).getTime()
      const endMs = new Date(e.end).getTime()
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
      const existing = getBlock(e.id)
      if (existing) {
        if (existing.matched !== 'unlinked') upsertBlock({ ...existing, title: e.title, start_at: startMs, end_at: endMs })
        continue
      }
      if (isTombstoned(e.id, e.recurringEventId)) continue
      const series = e.recurringEventId ? findSeriesLink(e.recurringEventId) : undefined
      if (series) {
        upsertBlock({ event_id: e.id, node_id: series.node_id, matched: 'manual', recurring_event_id: e.recurringEventId ?? '', title: e.title, start_at: startMs, end_at: endMs })
        continue
      }
      const lc = e.title.trim().toLowerCase()
      if (lc.length < 3) continue
      const hit = hands.find(h => h.name.toLowerCase() === lc)
        ?? hands.find(h => lc.includes(h.name.toLowerCase()) || h.name.toLowerCase().includes(lc))
      if (hit) upsertBlock({ event_id: e.id, node_id: hit.id, matched: 'auto', recurring_event_id: e.recurringEventId ?? '', title: e.title, start_at: startMs, end_at: endMs })
    }
    // Only sweep when the fetch actually returned events — an empty result is a genuinely
    // empty week OR a transient/partial Google response, and inferring "deleted" from nothing
    // would wipe every future link (see sweepBlocks' guard).
    if (isWeekFetch && events.length > 0) sweepBlocks(windowStartMs, windowEndMs, present)
  } catch (err) {
    console.error('[Blocks] auto-match failed (calendar fetch unaffected):', err)
  }
}

// GET /api/calendar?timeMin=ISO&timeMax=ISO — list events in a range.
// Used by both the lean 7-day window (Spectre context + What's Next) and the
// full month view. Returns [] (200) when not connected so the UI can show a
// connect CTA instead of erroring.
export async function GET(req: NextRequest) {
  if (!isConnected()) return NextResponse.json({ connected: false, events: [] })

  const url = new URL(req.url)
  const timeMin = url.searchParams.get('timeMin') ?? new Date().toISOString()
  const timeMax = url.searchParams.get('timeMax')
    ?? new Date(Date.now() + 7 * 864e5).toISOString()

  try {
    const events = await listEvents(timeMin, timeMax)
    // Week-sized fetch (the recurring 15-min poll) = matcher + sweep; anything bigger
    // (month browsing) = matcher only, so browsing March can never orphan current links.
    const startMs = new Date(timeMin).getTime()
    const endMs = new Date(timeMax).getTime()
    const isWeekFetch = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs <= 9 * 864e5
    autoMatchBlocks(events, startMs, endMs, isWeekFetch)
    return NextResponse.json({ connected: true, events })
  } catch (err) {
    console.error('[GCal] listEvents failed:', err)
    // A revoked/expired REFRESH token surfaces as `invalid_grant` — Google expires refresh tokens
    // after ~7 days while the OAuth app is in "Testing" publishing status. `isConnected()` still
    // reports true (the token string is on disk), so without this the UI shows a silently-empty
    // calendar and never offers to reconnect. Report not-connected → the existing "Connect Google
    // Calendar" CTA appears, and one click re-auths to a fresh token. (No data is lost — events
    // live in Google's cloud; only the local grant died.)
    let blob = err instanceof Error ? err.message : String(err)
    try { blob += ' ' + JSON.stringify(err) } catch { /* circular — message is enough */ }
    if (/invalid_grant|token has been expired or revoked|invalid_request|unauthorized_client/i.test(blob)) {
      return NextResponse.json({ connected: false, events: [], reason: 'token_revoked' })
    }
    return NextResponse.json({ connected: true, events: [], error: 'list_failed' }, { status: 502 })
  }
}

// POST /api/calendar — single write entry point (Diagram → Google Calendar).
// Body: { op: 'create' | 'update' | 'delete', event?: EventInput, eventId?: string }
export async function POST(req: NextRequest) {
  if (!isConnected()) {
    return NextResponse.json({ error: 'not_connected' }, { status: 409 })
  }

  let body: { op?: string; event?: EventInput; eventId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const { op, event, eventId } = body
  try {
    switch (op) {
      case 'create': {
        if (!event) return NextResponse.json({ error: 'missing_event' }, { status: 400 })
        return NextResponse.json({ event: await createEvent(event) })
      }
      case 'update': {
        if (!eventId || !event) return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
        return NextResponse.json({ event: await updateEvent(eventId, event) })
      }
      case 'delete': {
        if (!eventId) return NextResponse.json({ error: 'missing_eventId' }, { status: 400 })
        await deleteEvent(eventId)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'unknown_op' }, { status: 400 })
    }
  } catch (err) {
    console.error(`[GCal] ${op} failed:`, err)
    return NextResponse.json({ error: 'gcal_write_failed' }, { status: 502 })
  }
}

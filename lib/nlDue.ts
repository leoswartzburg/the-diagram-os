// ── Natural-language due parsing — ONE deterministic code path for every writer ─────
// Used by the quick-add inputs (client), the /api/tasks POST route, and the Secretary's
// add_task/update_task executor cases (which pass the model's raw NL `due` string here and
// NEVER trust model date arithmetic). chrono-node with forwardDate so "at 9am" typed at 2pm
// means TOMORROW 9am, not five hours ago. Convention (matches the calendar layer):
//   'YYYY-MM-DD'      → untimed / all-day due ("tomorrow", "friday")
//   full ISO (UTC Z)  → timed due ("at 4pm", "9:30 tomorrow")
//   null              → no due parsed
import * as chrono from 'chrono-node'

export type ParsedDue = { due_at: string | null; matchedText: string }

export function parseDue(text: string, refMs = Date.now()): ParsedDue {
  const t = (text || '').trim()
  if (!t) return { due_at: null, matchedText: '' }
  try {
    const results = chrono.parse(t, new Date(refMs), { forwardDate: true })
    if (!results.length) return { due_at: null, matchedText: '' }
    const r = results[0]
    let d = r.start.date()
    if (r.start.isCertain('hour')) {
      // Daytime bias: a bare hour with no am/pm ("dry cleaning at 5") is read by chrono as AM
      // and then forward-dated to tomorrow MORNING — the opposite of intent. Interpret a small
      // unknown-meridiem hour as PM; if that PM time has already passed today, roll to the same
      // PM time TOMORROW (never tomorrow-AM).
      if (!r.start.isCertain('meridiem')) {
        const h = r.start.get('hour') ?? d.getHours()
        if (h >= 1 && h < 12) {
          const pm = new Date(refMs); pm.setHours(h + 12, r.start.get('minute') ?? 0, 0, 0)
          if (pm.getTime() < refMs) pm.setDate(pm.getDate() + 1)
          d = pm
        }
      }
      return { due_at: d.toISOString(), matchedText: r.text }
    }
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
    return { due_at: `${y}-${m}-${day}`, matchedText: r.text }
  } catch {
    return { due_at: null, matchedText: '' }
  }
}

// Quick-add helper: parse the due out of a capture sentence and return the cleaned title.
// "get groceries at 9am" → { title: "get groceries", due_at: <ISO 9am> }. A capture with no
// time defaults to TODAY (untimed) so it always surfaces on the NOW list.
export function parseQuickAdd(text: string, refMs = Date.now()): { title: string; due_at: string | null } {
  const { due_at, matchedText } = parseDue(text, refMs)
  let title = (text || '').trim()
  if (matchedText) {
    title = title.replace(matchedText, ' ').replace(/\s+(at|on|by|before|after|this|next)\s*$/i, ' ').replace(/\s{2,}/g, ' ').trim()
  }
  if (!title) title = (text || '').trim()
  const d = new Date(refMs)
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { title, due_at: due_at ?? today }
}

// ── THE NOW LIST — the deterministic heart of the task system ──────────────────────
// A PURE function: no I/O, no LLM, no stored output. It derives "what matters right now"
// from current reality (time, today's linked blocks, the open tasks) every time it's called,
// which is what makes the whole system update-based instead of planning-based: a late
// arrival or a 3-hour task changes NOTHING stored — the list simply re-derives.
// Importable from both the client (dashboard widget, 60s tick) and the server (Phase 2
// notification decisions) — same rules, one implementation.

export type NowTask = {
  id: string
  node_id: string
  title: string
  status: string
  step: number | null
  lane: number
  due_at: string | null      // null · 'YYYY-MM-DD' (untimed) · full ISO (timed)
  block_event_id: string
  position: number
  created_at: number
}

export type NowBlock = {
  event_id: string
  node_id: string
  title: string
  start_at: number           // ms
  end_at: number             // ms
}

export type NowNudgeState = Record<string, { resolution?: 'still-going' | 'dismissed'; extendedUntil?: number }>

export type NowSection =
  | { kind: 'active-block'; block: NowBlock; tasks: NowTask[] }
  | { kind: 'due-now'; tasks: NowTask[] }
  | { kind: 'carried-over'; block: NowBlock; tasks: NowTask[] }
  | { kind: 'upcoming-block'; block: NowBlock; tasks: NowTask[] }
  | { kind: 'today'; tasks: NowTask[] }
  | { kind: 'next-up'; tasks: NowTask[] }
  | { kind: 'yesterday'; count: number; tasks: NowTask[] }

const DUE_NOW_LOOKAHEAD_MS = 15 * 60 * 1000
const NEXT_UP_PER_PROJECT = 2

const isTimed = (due: string | null): boolean => !!due && due.includes('T')
const dueMs = (due: string): number => new Date(due).getTime()

export function localDateStr(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The date a due belongs to, in LOCAL time (timed dues convert; date-only strings pass through).
const dueDateStr = (due: string): string => (isTimed(due) ? localDateStr(dueMs(due)) : due)

// Map order — the project's own sequence IS the to-do order inside a block.
const mapOrder = (a: NowTask, b: NowTask): number =>
  ((a.step ?? Infinity) - (b.step ?? Infinity)) || (a.lane - b.lane) || (a.position - b.position) || (a.created_at - b.created_at)

export function nowList(
  nowMs: number,
  blocks: NowBlock[],
  tasks: NowTask[],
  nudges: NowNudgeState = {},
): { sections: NowSection[] } {
  const today = localDateStr(nowMs)
  const open = tasks.filter(t => t.status === 'todo')
  const surfaced = new Set<string>()  // a task appears ONCE, in its highest-priority section
  const take = (list: NowTask[]): NowTask[] => {
    const out: NowTask[] = []
    for (const t of list) if (!surfaced.has(t.id)) { surfaced.add(t.id); out.push(t) }
    return out
  }
  const assigned = (eventId: string): NowTask[] =>
    open.filter(t => t.block_event_id === eventId).sort(mapOrder)

  const todayBlocks = blocks
    .filter(b => b.start_at < b.end_at && localDateStr(b.start_at) === today)
    .sort((a, b) => a.start_at - b.start_at)

  // A "still going" answer softly extends the block's active window — locally only, gcal untouched.
  const effectiveEnd = (b: NowBlock): number => Math.max(b.end_at, nudges[b.event_id]?.extendedUntil ?? 0)

  const sections: NowSection[] = []

  // 1. Active block — the linked block containing now; overlaps → most-recent start wins.
  const active = todayBlocks
    .filter(b => b.start_at <= nowMs && nowMs < effectiveEnd(b))
    .sort((a, b) => b.start_at - a.start_at)[0]
  if (active) {
    const ts = take(assigned(active.event_id))
    if (ts.length) sections.push({ kind: 'active-block', block: active, tasks: ts })
  }

  // 2. Due now — timed dues that have arrived (15-min lookahead). The lookahead ms bound is
  //    the only gate needed; a local-date clause would wrongly hide a task due in the next few
  //    minutes when that window crosses local midnight.
  const dueNow = take(open
    .filter(t => isTimed(t.due_at) && dueMs(t.due_at!) <= nowMs + DUE_NOW_LOOKAHEAD_MS)
    .sort((a, b) => dueMs(a.due_at!) - dueMs(b.due_at!)))
  if (dueNow.length) sections.push({ kind: 'due-now', tasks: dueNow })

  // 3. Carried over — a block with unchecked work that is EITHER ended OR a still-running
  //    block that lost the active-block race (overlapping blocks: the non-winner surfaces
  //    here instead of vanishing). Only genuinely-upcoming blocks (start in the future) are
  //    left to §4. Visible regardless of nudge state; recovery buttons render here.
  for (const b of todayBlocks) {
    if (b === active) continue
    const ended = effectiveEnd(b) <= nowMs
    const containsNow = b.start_at <= nowMs && nowMs < effectiveEnd(b)
    if (!ended && !containsNow) continue
    const ts = take(assigned(b.event_id))
    if (ts.length) sections.push({ kind: 'carried-over', block: b, tasks: ts })
  }

  // 4. Upcoming blocks — later today, with their loaded checklists.
  for (const b of todayBlocks) {
    if (b.start_at <= nowMs) continue
    const ts = take(assigned(b.event_id))
    if (ts.length) sections.push({ kind: 'upcoming-block', block: b, tasks: ts })
  }

  // 5. Today — everything on today's docket: untimed dues (every bare quick-add defaults
  //    here — a capture is never invisible) AND timed dues later today that haven't reached
  //    the due-now window yet, so the day is visible in full, not just its next 15 minutes.
  //    Untimed first, then timed in clock order.
  const todayTasks = take(open
    .filter(t => t.due_at && dueDateStr(t.due_at) === today)
    .sort((a, b) => {
      const ta = isTimed(a.due_at), tb = isTimed(b.due_at)
      if (ta !== tb) return ta ? 1 : -1
      if (ta && tb) return dueMs(a.due_at!) - dueMs(b.due_at!)
      return (a.node_id === '' ? 0 : 1) - (b.node_id === '' ? 0 : 1) || a.position - b.position || a.created_at - b.created_at
    }))
  if (todayTasks.length) sections.push({ kind: 'today', tasks: todayTasks })

  // 6. Next up — the top 1–2 unfinished MAP tasks per project, no block required. A
  //    chaotic zero-calendar day still shows the projects' own next moves.
  const byProject = new Map<string, NowTask[]>()
  for (const t of open) {
    if (!t.node_id || t.step === null || surfaced.has(t.id)) continue
    const list = byProject.get(t.node_id) ?? []
    list.push(t)
    byProject.set(t.node_id, list)
  }
  const nextUp: NowTask[] = []
  for (const list of byProject.values()) nextUp.push(...take(list.sort(mapOrder).slice(0, NEXT_UP_PER_PROJECT)))
  if (nextUp.length) sections.push({ kind: 'next-up', tasks: nextUp })

  // 7. Yesterday — ONE compact expandable row for overdue work: neither silent loss at
  //    midnight nor the guilt-pile. (Timed dues already surfaced by §2 stay there.)
  const overdue = take(open
    .filter(t => t.due_at && dueDateStr(t.due_at) < today)
    .sort((a, b) => dueDateStr(a.due_at!) < dueDateStr(b.due_at!) ? -1 : 1))
  if (overdue.length) sections.push({ kind: 'yesterday', count: overdue.length, tasks: overdue })

  return { sections }
}

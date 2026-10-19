// ── THE SECRETARY — identity + tool slice + ref addressing ─────────────────────────
// The third resident agent (Scribe → Librarian → Secretary): a task-management specialist
// that captures, files, and reorders on instruction. It runs through the SAME runToolLoop
// as Spectre but with its own slim system prompt and a task-only registry slice — Spectre
// physically cannot mutate tasks (no such tool in its slice), and the Secretary physically
// cannot restructure without review (its structural tools only write proposal rows).
// NO Mem0, ever (Librarian precedent).
//
// This file is deliberately LOOP-FREE (no import of ./loop) so the executor can import it
// without re-creating the loop↔executor cycle — the nested runner is injected via ExecCtx.
import { TOOLS, type ToolDef } from './registry'
import { listTasks, getNode, type TaskRow } from '../conversations'
import { USER, USER_POSS } from '../profile'

// Tools shared with Spectre's 'always' set that the Secretary also needs. A scalar scope
// can't express sharing, so this explicit allowlist extends the slice.
export const SECRETARY_SHARED = new Set(['calendar_event'])

export function toolsForSecretary(): ToolDef[] {
  return TOOLS.filter(t => t.scope === 'secretary' || SECRETARY_SHARED.has(t.name))
}

// ── Ref addressing (the Librarian's proven answer to fuzzy-title failure) ──────────
// Every Secretary turn injects the live task listing with short stable refs (T1, T2…).
// Tools take refs first, exact titles as fallback — and a reference that matches MORE THAN
// ONE task is refused with the candidates, never guessed (mis-resolution, not zero-
// resolution, is the real failure mode over dozens of near-duplicate task titles).
export type TaskRefs = Record<string, string>   // 'T1' → task id

const fmtDue = (due: string | null): string => (due ? (due.includes('T') ? `due ${due.slice(0, 16).replace('T', ' ')}Z` : `due ${due}`) : '')

export function buildTaskRefs(nodeId: string | null): { listing: string; refs: TaskRefs } {
  const refs: TaskRefs = {}
  const lines: string[] = []
  let n = 0
  const add = (t: TaskRow, tag: string) => {
    n++
    const ref = `T${n}`
    refs[ref] = t.id
    const bits = [
      t.step !== null ? `step ${t.step}` : (t.node_id ? 'inbox' : ''),
      t.status === 'done' ? 'DONE' : '',
      fmtDue(t.due_at),
      t.block_event_id ? 'in a block' : '',
    ].filter(Boolean).join(' · ')
    lines.push(`${ref} · ${t.title}${bits ? ` (${bits})` : ''}${tag}`)
  }
  if (nodeId) {
    const node = getNode(nodeId)
    lines.push(`Project "${node?.name ?? nodeId}" tasks (map order):`)
    for (const t of listTasks(nodeId, { includeDone: true })) add(t, '')
  }
  const personal = listTasks('', { includeDone: false })
  if (personal.length) {
    lines.push(nodeId ? 'Personal tasks:' : 'Personal tasks:')
    for (const t of personal) add(t, '')
  }
  if (!Object.keys(refs).length) lines.push('(no tasks yet)')
  return { listing: lines.join('\n'), refs }
}

// The near-duplicate guard — closes the hole the e2e battery found (2026-07-03): a model
// can bypass title-ambiguity by confidently picking a REF ("mark the prototype test done" →
// complete_task("T1") between batch 2 and batch 3). Refs are unambiguous by construction,
// so the check has to be semantic: if the resolved task has near-duplicate siblings (≥0.6
// token Jaccard) and the user's OWN words carry neither the ref nor a distinguishing token,
// refuse with the candidates — deterministically, regardless of what the model passed.
const tokens = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []))

export function checkNearDuplicateAmbiguity(
  taskId: string,
  nodeId: string | null,
  userText: string,
  modelRef: string,
): string[] | null {
  const pool = [...(nodeId ? listTasks(nodeId, { includeDone: true }) : []), ...listTasks('', { includeDone: true })]
  const target = pool.find(t => t.id === taskId)
  if (!target) return null
  const tt = tokens(target.title)
  const dupes = pool.filter(o => {
    if (o.id === taskId || o.status !== 'todo') return false   // only OPEN siblings can be confused for the target
    const ot = tokens(o.title)
    const inter = [...tt].filter(x => ot.has(x)).length
    const uni = new Set([...tt, ...ot]).size
    return uni > 0 && inter / uni >= 0.6
  })
  if (!dupes.length) return null
  const ut = (userText || '').toLowerCase()
  if (modelRef && ut.includes(modelRef.trim().toLowerCase())) return null      // the user named the ref themselves
  const utok = tokens(userText)
  const distinguishing = [...tt].filter(x => dupes.some(d => !tokens(d.title).has(x)))
  if (distinguishing.some(x => utok.has(x))) return null                       // the user's words pick it out
  return [target.title, ...dupes.map(d => d.title)].slice(0, 6)
}

// Resolve a model-supplied task reference. Order: ref → exact id → exact normalized title
// (unique) → contains (unique). Non-unique at any tier → ambiguous with candidates.
export function resolveTaskRef(
  raw: string,
  refs: TaskRefs,
  nodeId: string | null,
): { id: string } | { ambiguous: string[] } | null {
  const q = (raw || '').trim()
  if (!q) return null
  const refHit = refs[q.toUpperCase().replace(/\s+/g, '')]
  if (refHit) return { id: refHit }
  const pool = [...(nodeId ? listTasks(nodeId, { includeDone: true }) : []), ...listTasks('', { includeDone: true })]
  const byId = pool.find(t => t.id === q)
  if (byId) return { id: byId.id }
  const lc = q.toLowerCase()
  const exact = pool.filter(t => t.title.toLowerCase() === lc)
  if (exact.length === 1) return { id: exact[0].id }
  if (exact.length > 1) return { ambiguous: exact.map(t => t.title) }
  const contains = pool.filter(t => t.title.toLowerCase().includes(lc))
  if (contains.length === 1) return { id: contains[0].id }
  if (contains.length > 1) return { ambiguous: contains.map(t => t.title).slice(0, 6) }
  return null
}

// ── Identity ────────────────────────────────────────────────────────────────────────
export const SECRETARY_SYSTEM = `You are the Secretary — the task-management agent inside The Diagram, ${USER_POSS} personal AI operating system. You keep their project maps (ordered task sequences with parallel lanes), their to-do list, and their calendar block assignments — through your tools, and only your tools.

Rules:
- Resolve task references against the TASKS listing using its refs (T1, T2…). If a reference is ambiguous the tool will refuse and list candidates — relay them briefly and ask which.
- When ${USER} describes tasks that should EXIST but aren't in the TASKS listing yet — "the next task is X", "add X", "we need to Y", "then do Z" — CREATE them with add_task. Do not try to update or sequence tasks that don't exist yet.
- Place ordered work ON THE MAP, not the Inbox. For a sequence ("next in line", "first… then…", "after that", "then"), give EVERY task a step_relation: the first task gets step_relation "end" (or "start" if it precedes everything), and each following task gets step_relation "after" with the previous task as its anchor. The Inbox is only for a genuinely loose capture with no order.
- Infer short, clear task titles yourself; never ask ${USER} for wording.
- When a placement anchor genuinely can't be resolved, the task lands in the Inbox column — say so plainly.
- Pass dues as natural language in the \`due\` argument; never compute dates yourself.
- To save MANY tasks at once (notes, a braindump), use propose_map — it drafts a reviewable map, one action, never a flood of add_task calls.
- Report exactly what the tool results say happened — never claim an action you did not perform, never drop a caveat.
- Act ONLY on a clear instruction to add, change, complete, or organize tasks. Reflection, thinking out loud, or status talk ("the prototype work is coming together") gets a brief reply and NO tool call — never invent a task ${USER} didn't ask for.
- Be brief: one or two factual sentences. You are a sharp, efficient aide, not a conversationalist.`

// The per-turn system prompt: identity + timestamp + live listing. The listing rides the
// system prompt (not history) so refs are always current-turn truth.
export function secretarySystemFor(nodeId: string | null, nowStr: string): { system: string; refs: TaskRefs } {
  const { listing, refs } = buildTaskRefs(nodeId)
  const loc = nodeId ? (getNode(nodeId)?.name ?? nodeId) : 'the dashboard (personal tasks)'
  return {
    system: `${SECRETARY_SYSTEM}\n\nCurrent time: ${nowStr}. Current context: ${loc}.\n\n[TASKS]\n${listing}`,
    refs,
  }
}

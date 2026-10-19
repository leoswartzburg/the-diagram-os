// Applying a reviewed Secretary proposal — the Librarian-contract executor. A proposal
// (secretary_proposals.actions_json) is a typed action list produced by propose_map /
// propose_restructure. Nothing here runs until the user approves in the review panel; then only
// the approved actions execute. Every action is REVALIDATED against live rows at apply time
// (task must still exist) and fails loudly per-action rather than silently retargeting —
// the guard the Librarian already proves is necessary.
import {
  getSecretaryProposalById, updateSecretaryProposal, getTask, getLiveTask, createTask, updateTask,
  resolveStepPlacement, createPhase, listPhases,
} from '../conversations'
import { randomUUID } from 'crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Action = Record<string, any>

export function applyProposal(proposalId: string, approved: number[]): { applied: number; failed: string[] } {
  const p = getSecretaryProposalById(proposalId)
  if (!p) return { applied: 0, failed: ['proposal not found'] }
  let actions: Action[] = []
  try { actions = JSON.parse(p.actions_json) } catch { return { applied: 0, failed: ['corrupt proposal'] } }
  const approvedSet = new Set(approved)
  const group = randomUUID()
  const nodeId = p.node_id
  const failed: string[] = []
  let applied = 0

  // Phase name → id cache (create-on-first-use), and the running map of proposal-entry
  // index → the task id it created, so a create can anchor to an EARLIER proposal entry.
  const phaseByName = new Map<string, string>()
  for (const ph of listPhases(nodeId)) phaseByName.set(ph.name.toLowerCase(), ph.id)
  const ensurePhase = (name: string): string => {
    const key = name.trim().toLowerCase()
    if (phaseByName.has(key)) return phaseByName.get(key)!
    const created = createPhase({ node_id: nodeId, name: name.trim() })
    phaseByName.set(key, created.id)
    return created.id
  }
  const createdByIndex = new Map<number, string>()

  actions.forEach((act, i) => {
    if (!approvedSet.has(i)) return
    try {
      const op = String(act.op || '')
      if (op === 'create') {
        // Anchor: an existing task (anchor_id) OR an earlier entry in this proposal
        // (anchor_title → the id we created for it this run). Symbolic titles resolve now.
        let anchorId: string | undefined = act.anchor_id && getLiveTask(act.anchor_id) ? act.anchor_id : undefined
        if (!anchorId && act.anchor_title) {
          const earlier = actions.findIndex((o, j) => j < i && String(o.title || '').toLowerCase() === String(act.anchor_title).toLowerCase())
          if (earlier >= 0 && createdByIndex.has(earlier)) anchorId = createdByIndex.get(earlier)
        }
        const rel = (act.step_relation || 'end') as 'after' | 'before' | 'parallel' | 'start' | 'end'
        const placed = (rel === 'start' || rel === 'end' || anchorId) ? resolveStepPlacement(nodeId, rel, anchorId) : { step: null as number | null, lane: 0 }
        const phaseId = act.phase ? ensurePhase(String(act.phase)) : ''
        const t = createTask({ node_id: nodeId, title: String(act.title || 'Untitled'), notes: act.notes ? String(act.notes) : '', step: placed.step, lane: placed.lane, phase_id: phaseId, source: 'secretary', actor: 'secretary', group_id: group })
        createdByIndex.set(i, t.id)
        applied++
      } else if (op === 'move') {
        if (!getLiveTask(act.task_id)) { failed.push(`move: task gone`); return }
        const rel = (act.step_relation || 'end') as 'after' | 'before' | 'parallel' | 'start' | 'end'
        const anchorId = act.anchor_id && getLiveTask(act.anchor_id) ? act.anchor_id : undefined
        const placed = resolveStepPlacement(nodeId, rel, anchorId)
        updateTask(act.task_id, { step: placed.step, lane: placed.lane }, { actor: 'secretary', group_id: group })
        applied++
      } else if (op === 'delete') {
        if (!getLiveTask(act.task_id)) { failed.push(`delete: task gone`); return }
        updateTask(act.task_id, { status: 'dropped' }, { actor: 'secretary', group_id: group })
        applied++
      } else if (op === 'set_phase') {
        // Dedupe ids — a proposal can pin the same task under two refs/titles.
        const ids: string[] = [...new Set((act.task_ids || []) as string[])].filter((id: string) => getLiveTask(id))
        if (!ids.length) { failed.push('set_phase: no live tasks'); return }
        const phaseId = ensurePhase(String(act.phase || 'Phase'))
        for (const id of ids) updateTask(id, { phase_id: phaseId }, { actor: 'secretary', group_id: group })
        applied++
      } else if (op === 'merge') {
        // Dedupe FIRST — without this, task_ids ['X','X'] passes the 2+ guard, then the
        // slice(1) loop soft-drops X itself, destroying the very task the merge preserves.
        const ids: string[] = [...new Set((act.task_ids || []) as string[])].filter((id: string) => getLiveTask(id))
        if (ids.length < 2) { failed.push('merge: needs 2+ live tasks'); return }
        // Keep the first (retitled), fold the others' notes in, soft-drop the rest.
        const survivors = ids.map(id => getTask(id)!).filter(Boolean)
        const keep = survivors[0]
        const mergedNotes = survivors.map(t => t.notes).filter(Boolean).join('\n')
        updateTask(keep.id, { title: String(act.into_title || keep.title), notes: mergedNotes }, { actor: 'secretary', group_id: group })
        for (const t of survivors.slice(1)) updateTask(t.id, { status: 'dropped' }, { actor: 'secretary', group_id: group })
        applied++
      } else {
        failed.push(`unknown op "${op}"`)
      }
    } catch (err) {
      failed.push(`${act.op}: ${err instanceof Error ? err.message : 'failed'}`)
    }
  })

  updateSecretaryProposal(proposalId, { status: 'applied' })
  return { applied, failed }
}

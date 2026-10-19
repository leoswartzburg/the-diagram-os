// THE EXECUTOR — the single place a tool call actually runs. Model-agnostic: it takes one
// normalized ToolCall (from either Claude or gpt-oss) and returns one ToolResult.
//
//   read   → run server-side, return the content the model should answer from (the agentic loop).
//   mutate → run the REAL helper server-side, return honest success (no more "claimed but didn't")
//            + a `ui` hint so the client refreshes/opens the affected panel.
//   ui / client-only → validate what we can server-side (resolve the id/target, honest ok/fail),
//            then hand the call back to the client via `ui.client_action` to perform on-screen.
//
// This replaces BOTH the scattered client `applySpectreAction` switch AND the fragile "drain" hack.
// Server-only (fs + SQLite); every branch is self-catching.
import {
  listNodes, getNode, updateNode, listAllNotebooks, getNotebook, createNotebook, updateNotebook, getFile,
  listTasks, getTask, createTask, updateTask, resolveStepPlacement, listBlocks,
  createSecretaryProposal, createReminder, listReminders, cancelReminder,
  searchChatsGlobal, getSession, getMessages, recallPlaceName,
} from '../conversations'
import { tiptapToMarkdown, markdownToTiptap } from '../notebookMd'
import { searchVault, syncNotebookToVault } from '../vault'
import { tavilySearch, formatSearchResults, isSearchConfigured } from '../search'
import { extractText } from '../fileText'
import { parseDue } from '../nlDue'
import { buildTaskRefs, resolveTaskRef, checkNearDuplicateAmbiguity, secretarySystemFor, toolsForSecretary, type TaskRefs } from './secretary'
import { createEvent, updateEvent, deleteEvent, isConnected as gcalConnected } from '../gcal'
import type { ToolCall, ToolResult } from './adapters'
import { USER_NAME, USER_POSS, USER_POSS_CAP } from '../profile'

// The current on-screen context, so tools like save_document / list_documents know "here".
// actor: attribution for task_events ('secretary' inside a Secretary loop) — it doubles as
// the tell_secretary recursion guard. taskRefs: the T1/T2 ref→id snapshot built when the
// Secretary turn started (its listing rides the system prompt; the executor resolves the
// same refs here).
export type ExecCtx = {
  scope: string
  projectNodeId: string | null
  // The ACTIVE session this turn belongs to — search_chats excludes it (finding the
  // conversation you're currently in isn't recall).
  sessionId?: string | null
  viewedDate?: string
  actor?: 'user' | 'secretary'
  taskRefs?: TaskRefs
  // The user's verbatim words this turn — the near-duplicate ambiguity guard checks the RESOLVED
  // task against them (a model can pick a ref confidently; the user's wording is the ground truth).
  userText?: string
  // Injected by the route (loop lives above the executor, so this dodges the import cycle):
  // runs a NESTED tool loop for tell_secretary. Returns a minimal shape so the executor never
  // imports LoopResult. Absent inside a nested loop → tell_secretary refuses (recursion guard,
  // layered with the actor check).
  runNested?: (o: {
    system: string; userText: string
    tools: import('./registry').ToolDef[]
    ctx: ExecCtx; maxRounds?: number
  }) => Promise<{ text: string; ui: NonNullable<ToolResult['ui']>[]; steps: { ok: boolean; content: string }[] }>
}

const S = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

// Resolve a project/place by node id first, then exact name, then a fuzzy contains-match.
function resolveNode(nameOrId: string) {
  const q = nameOrId.trim()
  if (!q) return undefined
  const nodes = listNodes()
  const byId = nodes.find(n => n.id === q)
  if (byId) return byId
  const lc = q.toLowerCase()
  const exact = nodes.find(n => n.name.toLowerCase() === lc)
  if (exact) return exact
  return nodes.find(n => n.name.toLowerCase().includes(lc) || lc.includes(n.name.toLowerCase()))
}

function mdOfNotebook(nb: { content: string }): string {
  if (!nb.content || !nb.content.trim()) return ''
  try { return tiptapToMarkdown(JSON.parse(nb.content)).trim() } catch { return '' }
}

// ── Chat-recall formatting (search_chats / read_chat) ─────────────────────────────
const recallDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const recallTerms = (q: string) =>
  q.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(t => t.length >= 2).slice(0, 6)

// One transcript line. Research-card rows are giant JSON blobs the model shouldn't chew on;
// any single oversized message is capped so one readFile-era injection can't eat the budget.
function recallLine(m: { role: string; content: string; timestamp: number }): string {
  let c = m.content.startsWith('[RESEARCH_RESULT]') ? '[deep-research result card]' : m.content.trim()
  if (c.length > 1500) c = c.slice(0, 1500) + ' …[message truncated]'
  const t = new Date(m.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `[${t}] ${m.role === 'user' ? (USER_NAME || 'User') : 'Spectre'}: ${c}`
}

const CLIENT_ONLY = new Set(['update_workout', 'log_set', 'reorder_blocks', 'set_rest', 'open_session', 'search_sessions', 'deep_research'])
const ACK: Record<string, string> = {
  update_workout: "Updated the workout.", log_set: 'Logged the set.', reorder_blocks: 'Reordered the exercises.',
  set_rest: 'Rest updated.', open_session: 'Opening the conversation.', search_sessions: 'Looking for that conversation.',
  deep_research: 'Setting up the deep-research plan for your review.',
}

export async function executeTool(call: ToolCall, ctx: ExecCtx): Promise<ToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a: any = call.args || {}
  const done = (ok: boolean, content: string, ui?: ToolResult['ui']): ToolResult => ({ id: call.id, name: call.name, ok, content, ui })

  try {
    // Client-only tools: validate nothing server-side, ack + proxy the call to the client.
    if (CLIENT_ONLY.has(call.name)) return done(true, ACK[call.name] ?? 'Done.', { client_action: { name: call.name, args: a } })

    switch (call.name) {
      // ── reads ──────────────────────────────────────────────────────────────
      case 'web_search': {
        if (!isSearchConfigured()) return done(false, 'Web search is not configured (no TAVILY_API_KEY).')
        const r = await tavilySearch(S(a.query))
        if (!r.ok || !r.results.length) return done(true, `No useful web results for "${S(a.query)}".`)
        return done(true, formatSearchResults(r, { maxChars: 4000 }))
      }
      case 'search_documents': {
        if (!ctx.projectNodeId) return done(false, 'Not inside a project — no documents to search here.')
        const results = await searchVault(S(a.query), ctx.projectNodeId, 6, 0.4)
        if (!results || !results.length) return done(true, `No matching passages for "${S(a.query)}".`)
        return done(true, `Passages matching "${S(a.query)}":\n\n${results.map((r, i) => `[${i + 1}] ${r.title}\n${r.text}`).join('\n\n')}`)
      }
      case 'read_document': {
        const nb = getNotebook(S(a.id))
        if (!nb || nb.is_archived || nb.type !== 'notebook') return done(false, `No document with id "${S(a.id)}".`)
        return done(true, `Document "${nb.title}":\n\n${mdOfNotebook(nb) || '(empty)'}`)
      }
      case 'list_documents': {
        if (!ctx.projectNodeId) return done(false, 'Not inside a project.')
        const all = listAllNotebooks(ctx.projectNodeId)
        const docs = all.filter(n => n.type === 'notebook')
        const lines: string[] = []
        for (const f of all.filter(n => n.type === 'folder')) {
          lines.push(`[folder] ${f.title} (${f.id})`)
          for (const d of docs.filter(x => x.parent_id === f.id)) lines.push(`   - ${d.title} (${d.id})`)
        }
        for (const d of docs.filter(x => !x.parent_id)) lines.push(`- ${d.title} (${d.id})`)
        return done(true, lines.length ? lines.join('\n') : '(no documents in this project yet)')
      }
      case 'read_file': {
        const file = getFile(S(a.id))
        if (!file || file.is_archived) return done(false, `No source file with id "${S(a.id)}".`)
        const { text } = await extractText(file)
        return done(true, `File "${file.filename}":\n\n${(text || '(no extractable text)').slice(0, 40000)}`)
      }

      // ── Conversational recall — Spectre's deep memory of every past chat ──────
      case 'search_chats': {
        let folderId: string | null = null
        if (a.place) {
          const p = S(a.place).trim()
          if (/^(main|dashboard|core)$/i.test(p)) folderId = 'main'
          else {
            const node = resolveNode(p)
            if (!node) return done(false, `There's no place named "${p}" to search — omit \`place\` to search everywhere.`)
            folderId = node.id
          }
        }
        const q = S(a.query ?? '').trim()
        const hits = searchChatsGlobal(q, { folderId, limit: a.limit !== undefined ? num(a.limit) : undefined, excludeSessionId: ctx.sessionId ?? null })
        if (!hits.length) return done(true, q ? `No past conversations match "${q}"${folderId ? ' there' : ''}. Try different keywords, or omit \`place\`.` : 'No past conversations found.')
        const lines = hits.map((h, i) => {
          const head = `${i + 1}. "${h.title}" — ${h.place} · last active ${recallDate(h.updated_at)} · ${h.message_count} messages · session_id: ${h.session_id}`
          const ex = h.excerpts.map(e => `   > ${e}`).join('\n')
          return ex ? `${head}\n${ex}` : head
        })
        return done(true, `${q ? `Past conversations matching "${q}"` : 'Most recent conversations'}:\n\n${lines.join('\n\n')}\n\nCall read_chat with a session_id to pull the full discussion.`)
      }
      case 'read_chat': {
        const sess = getSession(S(a.session_id))
        // The privacy line search_chats draws (spiral/secretary never surface) holds here
        // too, so a remembered or guessed id can't reach around the filter.
        if (!sess || /^(secretary-|spiral-)/.test(sess.folder_id)) return done(false, `No conversation with id "${S(a.session_id)}" — get ids from search_chats.`)
        const msgs = getMessages(sess.id).filter(m => !m.is_compressed)
        if (!msgs.length) return done(true, `"${sess.title}" has no messages.`)
        const header = `Conversation "${sess.title}" — ${recallPlaceName(sess.folder_id)} · ${recallDate(sess.created_at)}${sess.updated_at - sess.created_at > 86_400_000 ? ` → ${recallDate(sess.updated_at)}` : ''} · ${msgs.length} messages`
        const BUDGET = 18000
        const q = S(a.query ?? '').trim()
        if (q) {
          // Topic mode: windows of ±2 messages around every match, in order, gaps marked.
          const terms = recallTerms(q)
          const matched = new Set<number>()
          msgs.forEach((m, i) => {
            const lc = m.content.toLowerCase()
            if (lc.includes(q.toLowerCase()) || terms.some(t => lc.includes(t))) {
              for (let j = Math.max(0, i - 2); j <= Math.min(msgs.length - 1, i + 2); j++) matched.add(j)
            }
          })
          if (matched.size) {
            const ordered = [...matched].sort((x, y) => x - y)
            const parts: string[] = []
            let used = 0, prev = -2
            for (const i of ordered) {
              const l = recallLine(msgs[i])
              if (used + l.length > BUDGET) { parts.push('…[more matches omitted — ask about a narrower topic to see them]'); break }
              if (i !== prev + 1 && parts.length) parts.push('[…]')
              parts.push(l); used += l.length; prev = i
            }
            return done(true, `${header}\nPassages about "${q}":\n\n${parts.join('\n\n')}`)
          }
          // No match → fall through to the tail, honestly noted.
        }
        const parts: string[] = []
        let used = 0
        for (let i = msgs.length - 1; i >= 0; i--) {
          const l = recallLine(msgs[i])
          if (used + l.length > BUDGET && parts.length) break
          parts.unshift(l); used += l.length
        }
        const notes = [
          q ? `(Nothing here matches "${q}" — showing the most recent portion instead.)` : '',
          parts.length < msgs.length ? `(Showing the most recent ${parts.length} of ${msgs.length} messages — pass \`query\` to pull earlier passages about a topic.)` : '',
        ].filter(Boolean).join('\n')
        return done(true, `${header}${notes ? `\n${notes}` : ''}\n\n${parts.join('\n\n')}`)
      }

      // ── mutates (real success server-side) ───────────────────────────────────
      case 'save_document': {
        const target = a.project ? resolveNode(S(a.project)) : (ctx.projectNodeId ? getNode(ctx.projectNodeId) : undefined)
        if (!target || target.level !== 'hand' || target.parent_id !== 'projects') return done(false, 'save_document needs a project to save into, and none resolved.')
        let content = JSON.stringify(markdownToTiptap(''))
        try { content = JSON.stringify(markdownToTiptap(S(a.content))) } catch { /* fall back to empty doc */ }
        const nb = createNotebook({ node_id: target.id, title: S(a.title) || 'Untitled', type: 'notebook', content, created_by: 'spectre' })
        void syncNotebookToVault(nb.id)
        return done(true, `Saved "${nb.title}" to ${target.name}.`, { refresh: ['notebooks'], open_document: { id: nb.id, mode: 'view' } })
      }
      case 'create_folder': {
        const target = a.project ? resolveNode(S(a.project)) : (ctx.projectNodeId ? getNode(ctx.projectNodeId) : undefined)
        if (!target || target.level !== 'hand' || target.parent_id !== 'projects') return done(false, 'create_folder needs a project, and none resolved.')
        const nb = createNotebook({ node_id: target.id, title: S(a.title) || 'Untitled', type: 'folder', created_by: 'spectre' })
        return done(true, `Created folder "${nb.title}" in ${target.name}.`, { refresh: ['notebooks'] })
      }
      case 'append_to_document': {
        const nb = getNotebook(S(a.id))
        if (!nb || nb.is_archived || nb.type !== 'notebook') return done(false, `No document with id "${S(a.id)}".`)
        const mode = a.mode === 'replace' ? 'replace' : 'append'
        const next = mode === 'replace' ? S(a.content) : `${mdOfNotebook(nb)}\n\n${S(a.content)}`.trim()
        updateNotebook(nb.id, { content: JSON.stringify(markdownToTiptap(next)) })
        void syncNotebookToVault(nb.id)
        return done(true, `${mode === 'replace' ? 'Rewrote' : 'Added to'} "${nb.title}".`, { refresh: ['notebooks'] })
      }
      case 'calendar_event': {
        if (!gcalConnected()) return done(false, 'Google Calendar is not connected.')
        const op = S(a.op)
        const ev = a.event || {}
        const input = { title: ev.title, start: ev.start, end: ev.end, allDay: ev.all_day ?? ev.allDay, location: ev.location }
        if (op === 'create') { const c = await createEvent(input); return done(true, `Added "${c.title}" to your calendar.`, { refresh: ['calendar'] }) }
        if (op === 'update') { if (!a.event_id) return done(false, 'Updating an event needs its event_id.'); const c = await updateEvent(S(a.event_id), input); return done(true, `Updated "${c.title}".`, { refresh: ['calendar'] }) }
        if (op === 'delete') { if (!a.event_id) return done(false, 'Deleting an event needs its event_id.'); await deleteEvent(S(a.event_id)); return done(true, 'Removed the event.', { refresh: ['calendar'] }) }
        return done(false, `Unknown calendar op "${op}".`)
      }
      case 'update_project': {
        const node = resolveNode(S(a.project))
        if (!node) return done(false, `No project matches "${S(a.project)}".`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const patch: any = {}
        if (a.progress !== undefined) patch.progress = num(a.progress)
        if (a.phase !== undefined) patch.phase = S(a.phase)
        if (a.description !== undefined) patch.description = S(a.description)
        if (a.name !== undefined) patch.name = S(a.name)
        updateNode(node.id, patch)
        return done(true, `Updated ${node.name}.`, { refresh: ['nodes'] })
      }

      // ── Task system (Secretary slice) ─────────────────
      // Ambiguity rule everywhere: a reference matching >1 task REFUSES with candidates —
      // never guesses. Acks echo the RESOLVED title verbatim so a mis-read is visible the
      // moment it happens. Dues are parsed here with chrono (never model date arithmetic).
      case 'add_task': {
        const target = a.project ? resolveNode(S(a.project)) : (ctx.projectNodeId ? getNode(ctx.projectNodeId) : undefined)
        const nodeId = target && target.level === 'hand' && target.parent_id === 'projects' ? target.id : ''
        let step: number | null = null, lane = 0
        let placementNote = ''
        const relation = S(a.step_relation) as 'after' | 'before' | 'parallel' | 'start' | 'end' | ''
        if (nodeId && relation) {
          let anchorId: string | undefined
          if (a.anchor) {
            const r = resolveTaskRef(S(a.anchor), ctx.taskRefs ?? {}, nodeId)
            if (r && 'ambiguous' in r) return done(false, `"${S(a.anchor)}" matches more than one task: ${r.ambiguous.map(t => `"${t}"`).join(', ')} — which one?`)
            // The anchor must belong to the TARGET project (the ref snapshot may have been
            // built for a different scope) — otherwise resolveStepPlacement ignores it and the
            // task silently lands at the end while we'd falsely report a real step.
            if (r) { const at = getTask(r.id); if (at && at.node_id === nodeId) anchorId = r.id; else placementNote = ` — the anchor "${S(a.anchor)}" isn't in that project, so it's in the Inbox for sorting` }
          }
          if ((anchorId || relation === 'start' || relation === 'end') && !placementNote) {
            const placed = resolveStepPlacement(nodeId, relation, anchorId)
            step = placed.step; lane = placed.lane
          } else {
            placementNote = ` — couldn't find the anchor "${S(a.anchor)}", so it's in the Inbox for sorting`
          }
        } else if (nodeId && !relation) {
          placementNote = ' (in the Inbox — say where it goes and I\'ll place it)'
        }
        const due = a.due ? parseDue(S(a.due)).due_at : null
        const task = createTask({
          node_id: nodeId, title: S(a.title), notes: S(a.notes ?? ''), step, lane, due_at: due,
          source: 'secretary', actor: ctx.actor ?? 'secretary',
        })
        const where = nodeId ? (getNode(nodeId)?.name ?? 'the project') : 'your personal list'
        const dueNote = due ? (due.includes('T') ? ` due ${new Date(due).toLocaleString()}` : ` due ${due}`) : ''
        return done(true, `Added "${task.title}" to ${where}${step !== null ? ` at step ${task.step}` : placementNote}${dueNote}.`, { refresh: ['tasks'] })
      }
      case 'complete_task':
      case 'reopen_task': {
        const r = resolveTaskRef(S(a.task), ctx.taskRefs ?? {}, ctx.projectNodeId)
        if (!r) return done(false, `No task matches "${S(a.task)}".`)
        if ('ambiguous' in r) return done(false, `"${S(a.task)}" matches more than one task: ${r.ambiguous.map(t => `"${t}"`).join(', ')} — which one?`)
        const near = checkNearDuplicateAmbiguity(r.id, ctx.projectNodeId, ctx.userText ?? '', S(a.task))
        if (near) return done(false, `${USER_POSS_CAP} wording could mean more than one task: ${near.map(t => `"${t}"`).join(', ')} — ask which one before acting.`)
        const task = updateTask(r.id, { status: call.name === 'complete_task' ? 'done' : 'todo' }, { actor: ctx.actor ?? 'secretary' })
        if (!task) return done(false, 'That task no longer exists.')
        return done(true, `${call.name === 'complete_task' ? 'Checked off' : 'Reopened'} "${task.title}".`, { refresh: ['tasks'] })
      }
      case 'update_task': {
        const r = resolveTaskRef(S(a.task), ctx.taskRefs ?? {}, ctx.projectNodeId)
        if (!r) return done(false, `No task matches "${S(a.task)}".`)
        if ('ambiguous' in r) return done(false, `"${S(a.task)}" matches more than one task: ${r.ambiguous.map(t => `"${t}"`).join(', ')} — which one?`)
        const near = checkNearDuplicateAmbiguity(r.id, ctx.projectNodeId, ctx.userText ?? '', S(a.task))
        if (near) return done(false, `${USER_POSS_CAP} wording could mean more than one task: ${near.map(t => `"${t}"`).join(', ')} — ask which one before acting.`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const patch: any = {}
        if (a.title !== undefined) patch.title = S(a.title)
        if (a.notes !== undefined) patch.notes = S(a.notes)
        if (a.due !== undefined) patch.due_at = /^(none|clear)$/i.test(S(a.due)) ? null : parseDue(S(a.due)).due_at
        const task = updateTask(r.id, patch, { actor: ctx.actor ?? 'secretary' })
        if (!task) return done(false, 'That task no longer exists.')
        return done(true, `Updated "${task.title}".`, { refresh: ['tasks'] })
      }
      case 'assign_to_block': {
        const eventQ = S(a.event)
        const now = Date.now()
        const week = listBlocks(now - 24 * 3600 * 1000, now + 7 * 24 * 3600 * 1000)
        const block = week.find(b => b.event_id === eventQ)
          ?? week.find(b => b.title.toLowerCase() === eventQ.toLowerCase())
          ?? week.find(b => b.title.toLowerCase().includes(eventQ.toLowerCase()))
        if (!block) return done(false, `No linked calendar block matches "${eventQ}" this week. Link the event to a project first.`)
        const wanted: string[] = Array.isArray(a.tasks) ? a.tasks.map(S) : [S(a.tasks)]
        const doneTitles: string[] = []
        for (const w of wanted) {
          // Resolve against the SAME universe the model was shown (ctx scope), not the block's
          // project — otherwise a ref/title could target a task the model never saw.
          const r = resolveTaskRef(w, ctx.taskRefs ?? {}, ctx.projectNodeId)
          if (!r) return done(false, `No task matches "${w}".`)
          if ('ambiguous' in r) return done(false, `"${w}" matches more than one task: ${r.ambiguous.map(t => `"${t}"`).join(', ')} — which one?`)
          const near = checkNearDuplicateAmbiguity(r.id, ctx.projectNodeId, ctx.userText ?? '', w)
          if (near) return done(false, `"${w}" could mean more than one task: ${near.map(t => `"${t}"`).join(', ')} — which one?`)
          const t = updateTask(r.id, { block_event_id: block.event_id }, { actor: ctx.actor ?? 'secretary' })
          if (t) doneTitles.push(t.title)
        }
        return done(true, `Assigned ${doneTitles.map(t => `"${t}"`).join(', ')} to "${block.title || 'the block'}".`, { refresh: ['tasks'] })
      }
      case 'list_tasks': {
        const target = a.project ? resolveNode(S(a.project)) : (ctx.projectNodeId ? getNode(ctx.projectNodeId) : undefined)
        const { listing, refs } = buildTaskRefs(target?.id ?? null)
        // Re-sync the ref snapshot so a follow-up complete/update resolves against THIS listing
        // (ctx is shared by reference across loop rounds), not the stale turn-start one. Only
        // when the listing is for the current context — a cross-project listing keeps its own refs.
        if ((target?.id ?? null) === ctx.projectNodeId) ctx.taskRefs = refs
        return done(true, listing)
      }
      case 'propose_map': {
        if (!ctx.projectNodeId) return done(false, 'propose_map needs a project context.')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = (Array.isArray(a.tasks) ? a.tasks : []).filter((t: any) => t && S(t.title).trim())
        if (!entries.length) return done(false, 'No valid tasks in the proposal.')
        // Validate + pin what's resolvable NOW (Librarian pattern): anchors that reference
        // EXISTING tasks resolve to ids at creation; anchors naming earlier entries stay
        // symbolic (they don't exist yet) and resolve at apply time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actions = entries.map((t: any) => {
          const act: Record<string, unknown> = { op: 'create', title: S(t.title).trim() }
          if (t.notes) act.notes = S(t.notes)
          if (t.phase) act.phase = S(t.phase)
          const rel = S(t.step_relation)
          if (rel) {
            act.step_relation = rel
            if (t.anchor) {
              const r = resolveTaskRef(S(t.anchor), ctx.taskRefs ?? {}, ctx.projectNodeId)
              if (r && 'id' in r) act.anchor_id = r.id
              else act.anchor_title = S(t.anchor)
            }
          }
          return act
        })
        createSecretaryProposal({ node_id: ctx.projectNodeId, actions_json: JSON.stringify(actions), summary: S(a.summary) || `Draft map: ${actions.length} tasks` })
        return done(true, `Drafted ${actions.length} tasks as a proposal for ${USER_POSS} review — nothing is created until approved.`, { refresh: ['proposals'] })
      }
      case 'propose_restructure': {
        if (!ctx.projectNodeId) return done(false, 'propose_restructure needs a project context.')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = Array.isArray(a.actions) ? a.actions : []
        const actions: Record<string, unknown>[] = []
        const dropped: string[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const act of raw as any[]) {
          const op = S(act?.op)
          if (!['move', 'merge', 'delete', 'set_phase'].includes(op)) { dropped.push(`unknown op "${op}"`); continue }
          const pin = (refOrTitle: string): string | null => {
            const r = resolveTaskRef(refOrTitle, ctx.taskRefs ?? {}, ctx.projectNodeId)
            return r && 'id' in r ? r.id : null
          }
          if (op === 'move' || op === 'delete') {
            const id = pin(S(act.task))
            if (!id) { dropped.push(`${op}: can't resolve "${S(act.task)}"`); continue }
            const out: Record<string, unknown> = { op, task_id: id }
            if (op === 'move') {
              out.step_relation = S(act.step_relation) || 'end'
              if (act.anchor) { const aid = pin(S(act.anchor)); if (aid) out.anchor_id = aid; else { dropped.push(`move: can't resolve anchor "${S(act.anchor)}"`); continue } }
            }
            actions.push(out)
          } else {
            const rawTasks = (Array.isArray(act.tasks) ? act.tasks : []).map(S)
            const ids = [...new Set(rawTasks.map((x: string) => pin(x)).filter(Boolean) as string[])]
            const unresolved = rawTasks.filter((x: string) => !pin(x))
            if (unresolved.length) dropped.push(`${op}: couldn't resolve ${unresolved.map((x: string) => `"${x}"`).join(', ')}`)
            // merge needs 2+ distinct live tasks — applyProposal rejects fewer, so don't store a
            // proposal that can never apply.
            if (op === 'merge' && ids.length < 2) { dropped.push(`merge: needs 2+ resolvable tasks (got ${ids.length})`); continue }
            if (!ids.length) { dropped.push(`${op}: no resolvable tasks`); continue }
            const out: Record<string, unknown> = { op, task_ids: ids }
            if (op === 'merge') out.into_title = S(act.into_title) || 'Merged task'
            if (op === 'set_phase') out.phase = S(act.phase) || 'Phase'
            actions.push(out)
          }
        }
        if (!actions.length) return done(false, `Nothing resolvable to propose${dropped.length ? ` (${dropped.join('; ')})` : ''}.`)
        createSecretaryProposal({ node_id: ctx.projectNodeId, actions_json: JSON.stringify(actions), summary: S(a.summary) || `Restructure: ${actions.length} actions` })
        const note = dropped.length ? ` (${dropped.length} unresolvable entr${dropped.length === 1 ? 'y' : 'ies'} dropped: ${dropped.join('; ')})` : ''
        return done(true, `Proposed ${actions.length} structural change${actions.length === 1 ? '' : 's'} for ${USER_POSS} review${note}.`, { refresh: ['proposals'] })
      }

      // ── Reminders — Spectre's proactive follow-ups (fire as push via notifySchedule) ──
      case 'set_reminder': {
        const parsed = parseDue(S(a.when))
        if (!parsed.due_at) return done(false, `I couldn't work out when "${S(a.when)}" is — give me a clearer time.`)
        // A date-only ("tomorrow") reminder defaults to 9am that day; a timed one fires exactly.
        let dueMs: number
        if (parsed.due_at.includes('T')) dueMs = new Date(parsed.due_at).getTime()
        else { const d = new Date(`${parsed.due_at}T09:00:00`); dueMs = d.getTime() }
        if (!Number.isFinite(dueMs)) return done(false, `That reminder time didn't resolve.`)
        const msg = S(a.message).trim() || 'Checking in.'
        createReminder({ due_at: dueMs, message: msg, scope: ctx.scope })
        return done(true, `Reminder set for ${new Date(dueMs).toLocaleString()} — I'll check in: "${msg}"`)
      }
      case 'list_reminders': {
        const rows = listReminders('pending')
        if (!rows.length) return done(true, 'No reminders are set right now.')
        return done(true, `Pending reminders:\n${rows.map(r => `- ${new Date(r.due_at).toLocaleString()}: ${r.message}`).join('\n')}`)
      }
      case 'cancel_reminder': {
        const q = S(a.match).toLowerCase().trim()
        const rows = listReminders('pending')
        const hit = rows.find(r => r.message.toLowerCase().includes(q)) ?? (rows.length === 1 ? rows[0] : undefined)
        if (!hit) return done(false, rows.length ? `Which one? Pending: ${rows.map(r => `"${r.message}"`).join(', ')}` : 'There are no pending reminders to cancel.')
        cancelReminder(hit.id)
        return done(true, `Cancelled the reminder: "${hit.message}".`)
      }

      // ── Delegation — Spectre → the Secretary (nested loop) ────────────────────
      case 'tell_secretary': {
        if (ctx.actor === 'secretary') return done(false, 'Already the Secretary — cannot delegate further.')
        if (!ctx.runNested) return done(false, 'Secretary delegation is only available on the tool-framework path.')
        // The model sometimes names the project loosely (or invents a name — local gpt-oss
        // wrote "test project" while ON a real project's map). An unresolvable/invalid name must
        // fall back to the CURRENT project, never fall through to personal scope — that was
        // the "Secretary adds a step and nothing appears on the map" bug.
        const isProjHand = (n?: ReturnType<typeof getNode>) => !!n && n.level === 'hand' && n.parent_id === 'projects'
        const named = a.project ? resolveNode(S(a.project)) : undefined
        const fromCtx = ctx.projectNodeId ? getNode(ctx.projectNodeId) : undefined
        const target = isProjHand(named) ? named : (isProjHand(fromCtx) ? fromCtx : named)
        const projId = isProjHand(target) ? target!.id : null
        const nowStr = new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        const { system, refs } = secretarySystemFor(projId, nowStr)
        const verbatim = S(a.verbatim)
        const userText = verbatim ? `${S(a.instruction)}\n\n(${USER_POSS_CAP} exact words: "${verbatim}")` : S(a.instruction)
        const nestedCtx: ExecCtx = { scope: projId ?? ctx.scope, projectNodeId: projId, actor: 'secretary', taskRefs: refs, userText: verbatim || S(a.instruction) }
        const r = await ctx.runNested({ system, userText, tools: toolsForSecretary(), ctx: nestedCtx, maxRounds: 4 })
        // Deterministic summary from the tool acks — the nested model's own text can be empty
        // on round exhaustion, so never rely on it. Bubble the nested refresh hints outward.
        const acks = r.steps.filter(s => s.ok).map(s => s.content)
        const summary = acks.length ? acks.join(' ') : (r.text.trim() || 'The Secretary reported no changes.')
        const refresh = Array.from(new Set(r.ui.flatMap(u => u.refresh ?? [])))
        return done(true, summary, refresh.length ? { refresh } : undefined)
      }

      // ── ui (validate server-side for an honest ack, client performs) ─────────
      case 'navigate': {
        const node = resolveNode(S(a.target))
        if (!node) return done(false, `There's no place named "${S(a.target)}".`)
        return done(true, `Opening ${node.name}.`, { navigate: node.id })
      }
      case 'open_document': {
        const nb = getNotebook(S(a.id))
        if (!nb || nb.is_archived) return done(false, `No document with id "${S(a.id)}".`)
        return done(true, `Showing "${nb.title}".`, { open_document: { id: nb.id, mode: a.mode === 'edit' ? 'edit' : 'view' } })
      }
      case 'open_file': {
        const f = getFile(S(a.id))
        if (!f || f.is_archived) return done(false, `No file with id "${S(a.id)}".`)
        return done(true, `Showing "${f.filename}".`, { open_file: f.id })
      }

      default:
        return done(false, `Unknown tool "${call.name}".`)
    }
  } catch (err) {
    return done(false, `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

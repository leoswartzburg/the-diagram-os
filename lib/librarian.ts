// The Librarian — an autonomous archivist for a project's DocuScape documents. It reads ONE
// project Hand's folders + documents and proposes a plan to tidy them: file loose docs into
// folders, create folders where a group needs one, flag junk/empty/duplicate docs for archiving,
// merge near-duplicates, and rename sloppy titles. The plan is REVIEWED and approved in the UI —
// applyLibrarianPlan only touches documents the user explicitly approves.
//
// Model: gpt-oss (local, ~$0) is the PRIMARY planner; Claude Haiku is the down-fallback if the
// local model is unreachable, AND the escalation reviewer for low-confidence destructive actions.
// Both narrators are Scribe's — a direct llama-server fetch + the Anthropic SDK — so the Librarian
// NEVER touches /api/spectre and therefore makes ZERO Mem0 writes. Fully self-catching: every
// public fn returns null / a no-op on failure and never throws into a request.
import Anthropic from '@anthropic-ai/sdk'
import {
  getNode, listAllNotebooks, getNotebook, createNotebook, updateNotebook, archiveNotebook,
  createLibrarianPlan, getLibrarianPlanById, updateLibrarianPlan, addInboxEvent,
  type NotebookRow, type LibrarianPlanRow,
} from './conversations'
import { tiptapToMarkdown, markdownToTiptap } from './notebookMd'
import { syncNotebookToVault, removeFromVault } from './vault'
import { USER_POSS } from './profile'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
const LOCAL_MODEL = 'gpt-oss-20b'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const EXCERPT_CHARS = 280        // per-loose-doc excerpt fed to the planner
const MERGE_SEP = '\n\n---\n\n'  // separator between folded-in documents on a merge

let _client: Anthropic | null = null
function client(): Anthropic { return _client ?? (_client = new Anthropic()) }

// ── Types (stored inside librarian_plans.plan_json) ──────────────────────────────
export type LibrarianOp = 'move' | 'create_folder' | 'archive' | 'merge' | 'rename'
export type LibrarianConfidence = 'high' | 'low'
export type LibrarianActionStatus = 'pending' | 'applied' | 'failed'

export type LibrarianAction = {
  id: string                       // stable id for UI toggling (a1, a2, …)
  op: LibrarianOp
  confidence: LibrarianConfidence
  why: string
  status: LibrarianActionStatus
  note?: string                    // apply-time outcome / Haiku escalation note
  escalated?: boolean              // Haiku reviewed this action
  // move / archive / rename (+ merge primary display)
  doc_id?: string
  doc_title?: string
  // move destination
  target_folder_id?: string        // an existing folder
  target_new_folder?: string       // name of a create_folder in the same plan
  target_label?: string            // human display of the destination
  // create_folder
  folder_name?: string
  // archive
  reason?: string                  // 'empty' | 'duplicate' | 'junk'
  // merge
  doc_ids?: string[]
  doc_titles?: string[]
  merge_into_title?: string
  // rename
  new_title?: string
}

export type LibrarianPlan = {
  id: string; node_id: string; status: string; model: string; summary: string
  created_at: number; updated_at: number; actions: LibrarianAction[]
}

// ── Narrators (Scribe's, generalized with a token cap) ───────────────────────────
async function askLocal(system: string, user: string, effort: 'low' | 'medium', maxTokens: number): Promise<string | null> {
  try {
    const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL, stream: false, temperature: 0.4, top_p: 0.9, max_tokens: maxTokens,
        reasoning_effort: effort, chat_template_kwargs: { reasoning_effort: effort },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) { console.warn('[Librarian] local non-OK:', res.status); return null }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content.trim() : null
  } catch (err) {
    console.warn('[Librarian] local unreachable — Claude fallback:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function askClaude(system: string, user: string, maxTokens: number): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client().messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    const text = (res?.content ?? []).map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : '')).join('').trim()
    return text || null
  } catch (err) {
    console.error('[Librarian] Claude call failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────
function mdOf(nb: Pick<NotebookRow, 'content'>): string {
  if (!nb.content || !nb.content.trim()) return ''
  try { return tiptapToMarkdown(JSON.parse(nb.content)).trim() } catch { return '' }
}

// Tolerant JSON extractor for a model that may wrap output in prose / code fences.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tolerantJson(raw: string): any | null {
  if (!raw) return null
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = s.indexOf('{'); const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  s = s.slice(start, end + 1)
  try { return JSON.parse(s) } catch { /* retry after stripping raw control chars */ }
  try { return JSON.parse(s.replace(/[\u0000-\u001F]+/g, ' ')) } catch { return null }
}

// ── Gather one project's library into a compact, ref-labeled prompt ──────────────
type Gather = {
  folders: NotebookRow[]
  docs: NotebookRow[]
  docRefToId: Map<string, string>
  folderRefToId: Map<string, string>
  folderIdToTitle: Map<string, string>
  idToDocTitle: Map<string, string>
  promptText: string
}

function gatherLibrary(nodeId: string): Gather {
  const all = listAllNotebooks(nodeId)
  const folders = all.filter(n => n.type === 'folder')
  const docs = all.filter(n => n.type === 'notebook')

  const folderRefToId = new Map<string, string>()
  const folderIdToRef = new Map<string, string>()
  const folderIdToTitle = new Map<string, string>()
  folders.forEach((f, i) => { const r = `F${i + 1}`; folderRefToId.set(r, f.id); folderIdToRef.set(f.id, r); folderIdToTitle.set(f.id, f.title) })

  const docRefToId = new Map<string, string>()
  const docIdToRef = new Map<string, string>()
  const idToDocTitle = new Map<string, string>()
  docs.forEach((d, i) => { const r = `D${i + 1}`; docRefToId.set(r, d.id); docIdToRef.set(d.id, r); idToDocTitle.set(d.id, d.title) })

  const lines: string[] = []
  lines.push('FOLDERS (existing containers you can file documents into):')
  if (folders.length) {
    for (const f of folders) {
      const kids = docs.filter(d => d.parent_id === f.id).map(d => `"${d.title}"`)
      lines.push(`  ${folderIdToRef.get(f.id)} "${f.title}"${kids.length ? ` — holds ${kids.length}: ${kids.slice(0, 8).join(', ')}${kids.length > 8 ? ', …' : ''}` : ' — (empty)'}`)
    }
  } else lines.push('  (none yet — create folders as needed)')

  lines.push('')
  lines.push('DOCUMENTS:')
  docs.forEach((d, i) => {
    const loc = d.parent_id ? `already in ${folderIdToRef.get(d.parent_id) ?? 'a folder'}` : 'LOOSE'
    const body = mdOf(d)
    lines.push(`  D${i + 1} "${d.title}" [${loc}] · ${body.length} chars · by ${d.created_by}`)
    if (!d.parent_id) {   // excerpt only for loose docs — the ones that need a home
      const ex = body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)
      lines.push(`       excerpt: ${ex || '(empty)'}`)
    }
  })

  return { folders, docs, docRefToId, folderRefToId, folderIdToTitle, idToDocTitle, promptText: lines.join('\n') }
}

// ── The planning prompt ───────────────────────────────────────────────────────────
const LIBRARIAN_SYSTEM = `You are the Librarian — a meticulous archivist for ${USER_POSS} project workspace. You are shown the folders and documents of ONE project and you propose how to TIDY it. You do not chat; you output a plan as JSON only.

OPERATIONS you may propose:
- move: put a document into a folder — an EXISTING folder (by its F# ref) or a NEW one you also create (by name).
- create_folder: make a new container folder when a clear group of documents has no home yet.
- archive: retire a low-value document (soft-delete, fully recoverable). reason = "empty" (no real content), "duplicate" (a near-copy of another doc here), or "junk" (test scraps, abandoned "[Partial]" fragments, throwaway notes).
- merge: fold near-duplicate documents into one (keep the fullest, combine the rest).
- rename: fix a sloppy, vague, or malformed document title.

RULES:
- Reference documents and folders ONLY by their short refs (D1, F2, …). Never invent a ref that isn't in the list.
- TOP PRIORITY: give every LOOSE document a home. A loose doc with an obvious topic match belongs in the matching folder.
- MATCH EACH DOCUMENT TO THE BEST FOLDER INDIVIDUALLY. Read every folder's name AND its current contents, then send each loose document to the SINGLE folder whose subject fits it best. Do NOT funnel unrelated documents into one folder just because it is first — meeting notes belong with meeting notes, a build log with build logs, a literature/research review with research. If two folders could fit, pick the more specific one.
- Keep it TWO LEVELS: documents sit directly inside a folder. Never nest a folder inside a folder.
- REUSING an existing folder is the DEFAULT and is strongly preferred. Creating a new folder is a rare EXCEPTION, allowed ONLY when 2 OR MORE loose documents clearly share a theme that NO existing folder covers. NEVER create a folder that would hold only one document. If an existing folder is even a reasonable fit, use it instead of inventing a new one, and treat near-synonym folders as the same (e.g. if a "Meeting Notes" folder already exists, do NOT also create "Meetings" — file into the existing one).
- An EMPTY document (0 chars / no real content) must be ARCHIVED with reason "empty" — never moved into a folder.
- Be honest about junk: empty docs and abandoned "[Partial] Research" fragments are usually archive candidates. Multiple docs on the same subject → merge, or archive the weaker copies.
- confidence: "high" ONLY when the choice is obvious (unmistakable topic match, clearly empty/junk). Use "low" for judgment calls and for anything that destroys or rewrites content (archive, merge, rename).
- Ground every action's "why" in the document's real title/content. Invent nothing.
- Do NOT move or rename a document without a genuine reason. If the project is already tidy, propose few or no actions. Never pad the plan.

OUTPUT — a single JSON object and NOTHING else (no prose, no code fences):
{"actions":[
  {"op":"move","doc":"D1","to_folder":"F2","confidence":"high","why":"..."},
  {"op":"move","doc":"D3","to_new_folder":"Research","confidence":"high","why":"..."},
  {"op":"create_folder","name":"Research","confidence":"high","why":"..."},
  {"op":"archive","doc":"D5","reason":"empty","confidence":"high","why":"..."},
  {"op":"merge","docs":["D7","D8"],"into_title":"...","confidence":"low","why":"..."},
  {"op":"rename","doc":"D2","to":"...","confidence":"low","why":"..."}
]}
For every "to_new_folder" you use, also emit a matching "create_folder" with the same name.`

// ── Parse the model's plan → typed, ref-resolved actions ─────────────────────────
function parsePlan(raw: string, g: Gather): LibrarianAction[] {
  const obj = tolerantJson(raw)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr: any[] | null = obj && Array.isArray(obj.actions) ? obj.actions : Array.isArray(obj) ? obj : null
  if (!arr) return []

  let n = 0
  const nextId = () => `a${++n}`
  const out: LibrarianAction[] = []
  const newFolderNames = new Map<string, string>()   // lowercased → canonical

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolveDoc = (ref: any): { id?: string; title?: string } => {
    if (typeof ref !== 'string') return {}
    const id = g.docRefToId.get(ref.trim().toUpperCase())
    return id ? { id, title: g.idToDocTitle.get(id) } : {}
  }

  for (const a of arr) {
    if (!a || typeof a !== 'object') continue
    const op = String(a.op || '').toLowerCase()
    const confidence: LibrarianConfidence = a.confidence === 'high' ? 'high' : 'low'
    const why = String(a.why || '').slice(0, 240)

    if (op === 'move') {
      const { id, title } = resolveDoc(a.doc)
      if (!id) continue
      let target_folder_id: string | undefined
      let target_new_folder: string | undefined
      let target_label = ''
      if (a.to_folder) { target_folder_id = g.folderRefToId.get(String(a.to_folder).trim().toUpperCase()); if (target_folder_id) target_label = g.folderIdToTitle.get(target_folder_id) ?? '' }
      if (!target_folder_id && a.to_new_folder) { target_new_folder = String(a.to_new_folder).trim(); target_label = target_new_folder; if (target_new_folder) newFolderNames.set(target_new_folder.toLowerCase(), target_new_folder) }
      if (!target_folder_id && !target_new_folder) continue
      out.push({ id: nextId(), op: 'move', confidence, why, status: 'pending', doc_id: id, doc_title: title, target_folder_id, target_new_folder, target_label })
    } else if (op === 'create_folder') {
      const name = String(a.name || '').trim()
      if (!name) continue
      newFolderNames.set(name.toLowerCase(), name)
      out.push({ id: nextId(), op: 'create_folder', confidence, why, status: 'pending', folder_name: name })
    } else if (op === 'archive') {
      const { id, title } = resolveDoc(a.doc)
      if (!id) continue
      const reason = ['empty', 'duplicate', 'junk'].includes(String(a.reason)) ? String(a.reason) : 'junk'
      out.push({ id: nextId(), op: 'archive', confidence, why, status: 'pending', doc_id: id, doc_title: title, reason })
    } else if (op === 'merge') {
      const refs = Array.isArray(a.docs) ? a.docs : []
      const ids: string[] = []; const titles: string[] = []
      for (const r of refs) { const { id, title } = resolveDoc(r); if (id && !ids.includes(id)) { ids.push(id); titles.push(title || '') } }
      if (ids.length < 2) continue
      out.push({ id: nextId(), op: 'merge', confidence, why, status: 'pending', doc_ids: ids, doc_titles: titles, merge_into_title: String(a.into_title || titles[0] || '').slice(0, 120) })
    } else if (op === 'rename') {
      const { id, title } = resolveDoc(a.doc)
      const to = String(a.to || a.new_title || '').trim()
      if (!id || !to) continue
      out.push({ id: nextId(), op: 'rename', confidence, why, status: 'pending', doc_id: id, doc_title: title, new_title: to.slice(0, 120) })
    }
  }

  // Synthesize a create_folder for any to_new_folder that lacks one; then dedupe create_folders.
  const haveFolder = new Set(out.filter(x => x.op === 'create_folder').map(x => (x.folder_name || '').toLowerCase()))
  for (const [lc, name] of newFolderNames) {
    const used = out.some(x => x.op === 'move' && (x.target_new_folder || '').toLowerCase() === lc)
    if (used && !haveFolder.has(lc)) { out.unshift({ id: nextId(), op: 'create_folder', confidence: 'high', why: `Container for documents grouped as "${name}".`, status: 'pending', folder_name: name }); haveFolder.add(lc) }
  }
  const seenFolder = new Set<string>()
  return out.filter(x => {
    if (x.op !== 'create_folder') return true
    const k = (x.folder_name || '').toLowerCase()
    if (seenFolder.has(k)) return false
    seenFolder.add(k); return true
  })
}

// ── Escalate low-confidence destructive actions to Haiku (best-effort) ───────────
const ESCALATE_SYSTEM = `You are a careful reviewer of a document-organizer's RISKY suggestions (archiving, merging, or renaming a person's real documents). Be conservative: prefer "skip" whenever an action could lose or damage real content, and "keep" only when it is clearly safe and correct. Output JSON only.`

async function escalateRiskyActions(actions: LibrarianAction[]): Promise<LibrarianAction[]> {
  // Escalate the content-destroying calls to Haiku regardless of the local model's self-rated
  // confidence — gpt-oss over-rates itself (it marked 11k-char research docs as "high"-confidence
  // junk). Every merge, every archive of a NON-empty document, and any low-confidence rename get a
  // second opinion. Archiving a truly empty (0-char) doc is safe → no review needed.
  const hard = actions.filter(a => {
    if (a.op === 'merge') return true
    if (a.op === 'rename') return a.confidence === 'low'
    if (a.op === 'archive') return mdOf(getNotebook(a.doc_id!) ?? ({ content: '' } as NotebookRow)).trim().length > 0
    return false
  })
  if (!hard.length) return actions

  const describe = (a: LibrarianAction): string => {
    if (a.op === 'archive') { const b = mdOf(getNotebook(a.doc_id!) ?? { content: '' } as NotebookRow).slice(0, 200); return `ARCHIVE "${a.doc_title}" (reason ${a.reason}). Doc content: ${b || '(empty)'}` }
    if (a.op === 'rename') return `RENAME "${a.doc_title}" → "${a.new_title}"`
    if (a.op === 'merge') return `MERGE ${(a.doc_titles || []).map(t => `"${t}"`).join(' + ')} → "${a.merge_into_title}"`
    return ''
  }
  const lines = hard.map((a, i) => `${i + 1}. ${describe(a)}\n   proposed because: ${a.why}`)
  const user = `Review each proposed action on ${USER_POSS} documents. For EACH numbered item decide "keep" (a good, safe idea) or "skip" (too risky or likely wrong). Output JSON only:\n{"verdicts":[{"n":1,"decision":"keep","why":"one short sentence"}]}\n\n${lines.join('\n')}`
  const raw = await askClaude(ESCALATE_SYSTEM, user, 1200)
  if (!raw) return actions
  const parsed = tolerantJson(raw)
  const verdicts = parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts : null
  if (!verdicts) return actions
  for (const v of verdicts) {
    const idx = Number(v?.n) - 1
    const a = hard[idx]
    if (!a) continue
    a.escalated = true
    const why = String(v?.why || '').slice(0, 160)
    if (String(v?.decision).toLowerCase() === 'skip') { a.confidence = 'low'; a.note = `Haiku: skip${why ? ` — ${why}` : ''}` }
    else { a.confidence = 'high'; a.note = `Haiku: keep${why ? ` — ${why}` : ''}` }
  }
  return actions
}

function summarize(actions: LibrarianAction[]): string {
  const c = (op: LibrarianOp) => actions.filter(a => a.op === op).length
  const parts: string[] = []
  if (c('move')) parts.push(`${c('move')} filed`)
  if (c('create_folder')) parts.push(`${c('create_folder')} new folder${c('create_folder') === 1 ? '' : 's'}`)
  if (c('archive')) parts.push(`${c('archive')} to archive`)
  if (c('merge')) parts.push(`${c('merge')} merge${c('merge') === 1 ? '' : 's'}`)
  if (c('rename')) parts.push(`${c('rename')} rename${c('rename') === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'Already tidy — no changes suggested.'
}

// ── Generate a plan for one project Hand (dry-run; proposes only) ────────────────
export async function generateLibrarianPlan(
  nodeId: string,
  prefer: 'local' | 'claude' = (process.env.LIBRARIAN_PLANNER === 'claude' ? 'claude' : 'local'),
): Promise<LibrarianPlan | null> {
  try {
    const node = getNode(nodeId)
    if (!node || node.level !== 'hand' || node.parent_id !== 'projects') return null   // project Hands only
    // The North Star node is out of bounds: it holds the Evidence File and the goal map —
    // load-bearing docs the wind-down support resolves by identity. Autonomous
    // reorganization must never move/rename/merge them.
    if (nodeId === 'north-star') return null
    const g = gatherLibrary(nodeId)
    if (g.docs.length === 0) return shapePlan(createLibrarianPlan({ node_id: nodeId, plan_json: '[]', model: '', summary: 'No documents to organize.' }))

    // Planner model is a dial. `prefer` (or LIBRARIAN_PLANNER env) picks the primary; the other is
    // the down-fallback. gpt-oss is ~$0; Haiku is a stronger taxonomy judge for a few cents/run.
    let model: string
    let raw: string | null
    if (prefer === 'claude') {
      model = CLAUDE_MODEL
      raw = await askClaude(LIBRARIAN_SYSTEM, g.promptText, 4000)
      if (!raw) { raw = await askLocal(LIBRARIAN_SYSTEM, g.promptText, 'medium', 5000); model = LOCAL_MODEL }
    } else {
      model = LOCAL_MODEL
      raw = await askLocal(LIBRARIAN_SYSTEM, g.promptText, 'medium', 5000)
      if (!raw) { raw = await askClaude(LIBRARIAN_SYSTEM, g.promptText, 4000); model = CLAUDE_MODEL }
    }
    if (!raw) return null

    let actions = parsePlan(raw, g)
    try { actions = await escalateRiskyActions(actions) } catch { /* escalation is best-effort */ }

    const shaped = shapePlan(createLibrarianPlan({ node_id: nodeId, plan_json: JSON.stringify(actions), model, summary: summarize(actions) }))
    // One bell (weave item 7): a real plan also lands in the Inbox.
    if (actions.length) addInboxEvent({ kind: 'librarian', title: `Librarian plan — ${node.name}`, body: summarize(actions) })
    return shaped
  } catch (err) {
    console.warn('[Librarian] generate failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Apply the approved subset of a plan ──────────────────────────────────────────
export async function applyLibrarianPlan(
  planId: string,
  approvedIds: string[],
  edits?: Record<string, { target_folder_id?: string; target_new_folder?: string }>,
): Promise<{ applied: number; failed: number; plan: LibrarianPlan | null }> {
  const row = getLibrarianPlanById(planId)
  if (!row) return { applied: 0, failed: 0, plan: null }
  let actions: LibrarianAction[]
  try { actions = JSON.parse(row.plan_json) as LibrarianAction[] } catch { return { applied: 0, failed: 0, plan: shapePlan(row) } }

  const approve = new Set(approvedIds)
  const toApply = actions.filter(a => approve.has(a.id) && a.status === 'pending')

  // Redirects from the review UI override a move's stored destination. An empty target_folder_id
  // means "leave it loose" (top level); a target_new_folder is created on the fly below.
  if (edits) {
    for (const a of toApply) {
      const e = edits[a.id]
      if (!e || a.op !== 'move') continue
      if (e.target_folder_id !== undefined) { a.target_folder_id = e.target_folder_id; a.target_new_folder = undefined; a.target_label = e.target_folder_id ? a.target_label : 'Top level' }
      else if (e.target_new_folder) { a.target_new_folder = e.target_new_folder; a.target_folder_id = undefined; a.target_label = e.target_new_folder }
    }
  }

  const newFolderId = new Map<string, string>()   // lowercased new-folder name → created id
  const fail = (a: LibrarianAction, why: string) => { a.status = 'failed'; a.note = why }

  // 1) Create approved folders first, so moves that target them can resolve.
  for (const a of toApply.filter(x => x.op === 'create_folder')) {
    try {
      const nb = createNotebook({ node_id: row.node_id, title: a.folder_name || 'Untitled', type: 'folder', created_by: 'spectre' })
      newFolderId.set((a.folder_name || '').toLowerCase(), nb.id)
      a.status = 'applied'
    } catch (e) { fail(a, `couldn't create folder (${e instanceof Error ? e.message : 'error'})`) }
  }

  // 2) Everything else.
  for (const a of toApply) {
    if (a.op === 'create_folder') continue
    try {
      if (a.op === 'move') {
        // Destination resolution: an explicit target_folder_id ('' = leave loose) wins; else a
        // named new folder — reuse the one this plan created, or make it now (covers a UI redirect
        // to a brand-new folder that has no create_folder action of its own).
        let target: string | undefined
        if (a.target_folder_id !== undefined) target = a.target_folder_id
        if (target === undefined && a.target_new_folder) {
          target = newFolderId.get(a.target_new_folder.toLowerCase())
          if (target === undefined) {
            const nb = createNotebook({ node_id: row.node_id, title: a.target_new_folder, type: 'folder', created_by: 'spectre' })
            target = nb.id; newFolderId.set(a.target_new_folder.toLowerCase(), nb.id)
          }
        }
        if (target === undefined) { fail(a, 'no destination for this document'); continue }
        updateNotebook(a.doc_id!, { parent_id: target })   // move only; content/vault path unchanged
        a.status = 'applied'
      } else if (a.op === 'rename') {
        updateNotebook(a.doc_id!, { title: a.new_title! })
        void syncNotebookToVault(a.doc_id!)                // title/slug changed → re-index (old .md mirror may linger; search stays correct)
        a.status = 'applied'
      } else if (a.op === 'archive') {
        archiveNotebook(a.doc_id!)
        void removeFromVault('notebook', a.doc_id!)        // drop from search + remove the .md mirror
        a.status = 'applied'
      } else if (a.op === 'merge') {
        const rows = (a.doc_ids || []).map(id => getNotebook(id)).filter((r): r is NotebookRow => !!r && !r.is_archived)
        if (rows.length < 2) { fail(a, 'fewer than 2 source documents still exist'); continue }
        rows.sort((x, y) => (y.content?.length || 0) - (x.content?.length || 0))   // fullest becomes the primary
        const primary = rows[0]; const rest = rows.slice(1)
        const merged = [primary, ...rest].map(mdOf).filter(Boolean).join(MERGE_SEP)
        updateNotebook(primary.id, { content: JSON.stringify(markdownToTiptap(merged)), title: a.merge_into_title || primary.title })
        void syncNotebookToVault(primary.id)
        for (const r of rest) { archiveNotebook(r.id); void removeFromVault('notebook', r.id) }
        a.status = 'applied'
      }
    } catch (e) { fail(a, `apply failed (${e instanceof Error ? e.message : 'error'})`) }
  }

  const applied = toApply.filter(a => a.status === 'applied').length
  const failed = toApply.filter(a => a.status === 'failed').length
  const plan = updateLibrarianPlan(planId, { plan_json: JSON.stringify(actions), status: 'applied' })
  return { applied, failed, plan: plan ? shapePlan(plan) : null }
}

// ── Row → client shape ─────────────────────────────────────────────────────────
export function shapePlan(row: LibrarianPlanRow): LibrarianPlan {
  let actions: LibrarianAction[] = []
  try { actions = JSON.parse(row.plan_json) as LibrarianAction[] } catch { actions = [] }
  return { id: row.id, node_id: row.node_id, status: row.status, model: row.model, summary: row.summary, created_at: row.created_at, updated_at: row.updated_at, actions }
}

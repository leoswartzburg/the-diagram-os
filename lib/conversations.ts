// Server-only persistence for cross-device chat sessions + sliding-window context.
//
// Every part of The Diagram (the main page and each folder/project sub-page) gets
// its own set of named, persistent conversations backed by a single SQLite file at
// the project root (conversations.db). Because the file lives on the PC and every
// device (browser, phone via Tailscale) hits the same Next.js routes, history is
// identical everywhere — open a session on one device, continue it on another.
//
// Two tables:
//   sessions  — one row per conversation, scoped by folder_id
//   messages  — one row per turn; old turns are summarised (recursive compression)
//               rather than deleted, so a session can run indefinitely without
//               blowing the model's context window.
//
// The driver (better-sqlite3, synchronous) is isolated behind this module so it can
// be swapped for Node's built-in node:sqlite without touching callers.

import Database from 'better-sqlite3'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { markdownToTiptap } from './notebookMd'
import { USER, USER_CAP, USER_POSS, USER_NAME } from './profile'

// Speaker label for the user's turns in transcripts / recall excerpts.
const USER_LABEL = USER_NAME || 'User'

// ── Types ─────────────────────────────────────────────────────────────────────
export type SessionRow = {
  id: string
  folder_id: string
  title: string
  created_at: number
  updated_at: number
  last_message_preview: string
  is_archived: number
  tag_id: string | null    // optional section/tag (project Hand workspaces only)
  summary_count?: number   // populated by listSessions — > 0 means compressed history
}

// A section/tag for intra-project chat organization (project Hand workspaces). Scoped
// to one Hand node; a session may carry at most one tag (sessions.tag_id).
export type TagRow = {
  id: string
  node_id: string
  name: string
  color: string
  created_at: number
}

// Auto-assigned colors, cycled in order as new tags are created within a node.
export const TAG_PALETTE = ['#EF9F27', '#1D9E75', '#D85A30', '#7F77DD', '#378ADD', '#639922']

export type MessageRow = {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  token_count: number
  is_compressed: number
  compression_level: number
  is_bookmarked: number
  in_context: number
  deleted_at: number | null   // set (with in_context=0) when truncated by an edit/retry
}

// ── Diagram tree (Core / Arms / Hands) ──────────────────────────────────────────
// The Diagram has exactly three structural levels:
//   CORE  — the main dashboard page. Always exists, never a row (implicit, id 'main').
//   ARMS  — top-level tiles on the bento grid (level 'arm', parent_id null).
//   HANDS — items within an Arm (level 'hand', parent_id = the arm's id).
// A node's id IS its session scope (folder_id), so conversations live under the node
// directly. The three seeded project Hands keep their historical scope ids
// ('project-diagram' etc.) so existing session history is preserved.
export type NodeLevel = 'arm' | 'hand'
export type NodeTemplate = 'research' | 'health' | 'training' | 'schedule' | 'project' | 'custom'
export type NodeRow = {
  id: string
  name: string
  level: NodeLevel
  parent_id: string | null
  template: NodeTemplate
  position: number
  primer: string
  icon: string
  created_at: number
  is_archived: number
  progress: number
  phase: string
  description: string
  summary: string
  summary_updated_at: number | null
}

// A reference file attached to a Project Hand (the SOURCES section). The bytes live on
// disk under the-diagram-files/projects/<node_id>/sources/; this row is the metadata.
export type FileRow = {
  id: string
  node_id: string
  filename: string
  stored_path: string
  file_type: string
  size_bytes: number
  created_at: number
  is_archived: number
  source: string   // 'sources' (right-panel Sources) | 'chat' (chat attachment)
}

// Docu-scape: a folder or notebook in a Project Hand's NOTEBOOKS library. Two levels
// only — a folder lives at top level (parent_id ''); a notebook lives at top level or
// inside one folder. Folders never nest. `content` is a TipTap JSON document string.
export type NotebookRow = {
  id: string
  node_id: string
  parent_id: string         // '' = top level, else a folder id
  type: 'folder' | 'notebook'
  title: string
  content: string           // TipTap JSON (notebooks only; '' for folders)
  position: number
  created_at: number
  updated_at: number
  is_archived: number
  created_by: string        // 'user' | 'spectre'
  icon: string              // emoji or icon id
  color: string             // accent color hex
}

// ── Tunables ────────────────────────────────────────────────────────────────
// Compression triggers when the active context approaches this many tokens,
// leaving headroom for the system prompt + primer + the model's response.
const CONTEXT_LIMIT = 70_000
// Oldest verbatim messages folded into a single summary per compression pass.
const COMPRESS_BATCH = 20
// Cheap, fast model for summarisation — the right tool for dense recaps.
const COMPRESS_MODEL = 'claude-haiku-4-5'
const MAX_COMPRESS_PASSES = 10

// ── Database bootstrap ─────────────────────────────────────────────────────────
let _db: Database.Database | null = null
function db(): Database.Database {
  if (_db) return _db
  const d = new Database(join(process.cwd(), 'conversations.db'))
  d.pragma('journal_mode = WAL')
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                   TEXT PRIMARY KEY,
      folder_id            TEXT NOT NULL,
      title                TEXT NOT NULL DEFAULT 'New conversation',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      last_message_preview TEXT NOT NULL DEFAULT '',
      is_archived          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_folder
      ON sessions(folder_id, is_archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      role              TEXT NOT NULL,
      content           TEXT NOT NULL,
      timestamp         INTEGER NOT NULL,
      token_count       INTEGER NOT NULL DEFAULT 0,
      is_compressed     INTEGER NOT NULL DEFAULT 0,
      compression_level INTEGER NOT NULL DEFAULT 0,
      is_bookmarked     INTEGER NOT NULL DEFAULT 0,
      in_context        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS diagram_nodes (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      level       TEXT NOT NULL,            -- 'arm' | 'hand' (core is implicit)
      parent_id   TEXT,                     -- null for arms, arm id for hands
      template    TEXT NOT NULL DEFAULT 'custom',
      position    INTEGER NOT NULL DEFAULT 0,
      primer      TEXT NOT NULL DEFAULT '',
      icon        TEXT NOT NULL DEFAULT 'ti-folder',
      created_at  INTEGER NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_tree
      ON diagram_nodes(level, parent_id, is_archived, position);

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL,
      filename    TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      file_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      source      TEXT NOT NULL DEFAULT 'sources'
    );
    CREATE INDEX IF NOT EXISTS idx_files_node
      ON files(node_id, is_archived, created_at DESC);

    CREATE TABLE IF NOT EXISTS tags (
      id         TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tags_node ON tags(node_id, created_at);

    CREATE TABLE IF NOT EXISTS notebooks (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL,
      parent_id   TEXT NOT NULL DEFAULT '',   -- '' = top level, else a folder id
      type        TEXT NOT NULL,              -- 'folder' | 'notebook'
      title       TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',   -- TipTap JSON (notebooks only)
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT NOT NULL DEFAULT 'user',
      icon        TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_notebooks_tree
      ON notebooks(node_id, parent_id, is_archived, position);

    CREATE TABLE IF NOT EXISTS scribe_entries (
      id           TEXT PRIMARY KEY,
      date         TEXT NOT NULL UNIQUE,         -- YYYY-MM-DD the chapter chronicles
      status       TEXT NOT NULL DEFAULT 'live', -- 'live' (today, rewritable) | 'final' (locked)
      title        TEXT NOT NULL DEFAULT '',
      narrative    TEXT NOT NULL DEFAULT '',
      themes       TEXT NOT NULL DEFAULT '[]',   -- JSON array of recurring threads
      source_hash  TEXT NOT NULL DEFAULT '',     -- hash of source material last narrated (skip regen)
      source_count INTEGER NOT NULL DEFAULT 0,
      model        TEXT NOT NULL DEFAULT '',
      narrated_through INTEGER NOT NULL DEFAULT 0, -- ms timestamp of the last message folded in; each
                                                   -- checkpoint appends only material AFTER this
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scribe_date ON scribe_entries(date DESC);

    CREATE TABLE IF NOT EXISTS scribe_meta (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      arc          TEXT NOT NULL DEFAULT '',       -- rolling overarching-threads summary
      quote        TEXT NOT NULL DEFAULT '',       -- quote of the day (drawn from yesterday's chapter)
      quote_author TEXT NOT NULL DEFAULT '',
      quote_date   TEXT NOT NULL DEFAULT '',       -- YYYY-MM-DD the quote is for (once per day)
      word         TEXT NOT NULL DEFAULT '',       -- word of the day (vocab list; rotates 2x/day)
      word_def     TEXT NOT NULL DEFAULT '',
      word_idx     INTEGER NOT NULL DEFAULT 0,     -- rotation cursor into the vocab list (no repeats)
      updated_at   INTEGER NOT NULL DEFAULT 0
    );
  `)

  // Migration: add sessions.tag_id (section/tag for project Hand chats).
  const sessCols = d.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  if (!sessCols.some(c => c.name === 'tag_id')) {
    d.exec(`ALTER TABLE sessions ADD COLUMN tag_id TEXT`)
  }

  // Migration: add files.source ('sources' = right-panel Sources, 'chat' = chat attachment).
  const fileCols = d.prepare(`PRAGMA table_info(files)`).all() as { name: string }[]
  if (fileCols.length && !fileCols.some(c => c.name === 'source')) {
    d.exec(`ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'sources'`)
  }

  // Migration: add messages.deleted_at if an older DB predates it (no IF NOT EXISTS
  // for ADD COLUMN in SQLite, so probe the schema first).
  const cols = d.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  if (!cols.some(c => c.name === 'deleted_at')) {
    d.exec(`ALTER TABLE messages ADD COLUMN deleted_at INTEGER`)
  }

  // Migration: add scribe_entries.narrated_through (the append marker). Backfill existing rows to
  // their updated_at so the next checkpoint appends only material since the last write — it won't
  // re-chronicle (or overwrite) what's already in the chapter.
  const scribeCols = d.prepare(`PRAGMA table_info(scribe_entries)`).all() as { name: string }[]
  if (scribeCols.length && !scribeCols.some(c => c.name === 'narrated_through')) {
    d.exec(`ALTER TABLE scribe_entries ADD COLUMN narrated_through INTEGER NOT NULL DEFAULT 0`)
    d.exec(`UPDATE scribe_entries SET narrated_through = updated_at WHERE narrated_through = 0`)
  }

  // Migration: scribe_meta quote-of-the-day columns.
  const metaCols = d.prepare(`PRAGMA table_info(scribe_meta)`).all() as { name: string }[]
  if (metaCols.length) {
    if (!metaCols.some(c => c.name === 'quote')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN quote TEXT NOT NULL DEFAULT ''`)
    if (!metaCols.some(c => c.name === 'quote_author')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN quote_author TEXT NOT NULL DEFAULT ''`)
    if (!metaCols.some(c => c.name === 'quote_date')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN quote_date TEXT NOT NULL DEFAULT ''`)
    if (!metaCols.some(c => c.name === 'word')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN word TEXT NOT NULL DEFAULT ''`)
    if (!metaCols.some(c => c.name === 'word_def')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN word_def TEXT NOT NULL DEFAULT ''`)
    if (!metaCols.some(c => c.name === 'word_idx')) d.exec(`ALTER TABLE scribe_meta ADD COLUMN word_idx INTEGER NOT NULL DEFAULT 0`)
  }

  // Migration: add progress/phase/description to diagram_nodes.
  const nodeCols = d.prepare(`PRAGMA table_info(diagram_nodes)`).all() as { name: string }[]
  const freshProgress = !nodeCols.some(c => c.name === 'progress')
  if (freshProgress) {
    d.exec(`ALTER TABLE diagram_nodes ADD COLUMN progress INTEGER NOT NULL DEFAULT 0`)
  }
  if (!nodeCols.some(c => c.name === 'phase')) {
    d.exec(`ALTER TABLE diagram_nodes ADD COLUMN phase TEXT NOT NULL DEFAULT ''`)
  }
  if (!nodeCols.some(c => c.name === 'description')) {
    d.exec(`ALTER TABLE diagram_nodes ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
  }
  // Migration: add AI-activity summary columns (Projects landing cards).
  if (!nodeCols.some(c => c.name === 'summary')) {
    d.exec(`ALTER TABLE diagram_nodes ADD COLUMN summary TEXT NOT NULL DEFAULT ''`)
  }
  if (!nodeCols.some(c => c.name === 'summary_updated_at')) {
    d.exec(`ALTER TABLE diagram_nodes ADD COLUMN summary_updated_at INTEGER`)
  }
  // Seed initial values for the three seeded project Hands (only on first migration).
  if (freshProgress) {
    d.prepare(`UPDATE diagram_nodes SET progress = 0, phase = 'Active', description = 'Research work — experiments, data, results and next steps.' WHERE id = 'project-lab'`).run()
    d.prepare(`UPDATE diagram_nodes SET progress = 0, phase = 'Planning', description = 'A personal build — design, parts, progress and open questions.' WHERE id = 'project-build'`).run()
    d.prepare(`UPDATE diagram_nodes SET progress = 0, phase = 'Active', description = 'This personal AI operating system — features, fixes and ideas for The Diagram itself.' WHERE id = 'project-diagram'`).run()
  }

  _db = d
  seedNodes(d)
  return d
}

// ── Seed the Core/Arms/Hands tree (idempotent via INSERT OR IGNORE) ─────────────
// Arm ids match the existing session folder_ids; the three example project Hands keep
// stable 'project-*' scope ids so conversations stay attached across renames. Every
// primer below is a starting point — edit it in the UI (⚙ in the chat header).
const SEED_NODES: Omit<NodeRow, 'created_at' | 'is_archived' | 'summary' | 'summary_updated_at'>[] = [
  { id: 'schedule', name: 'Schedule',   level: 'arm', parent_id: null, template: 'schedule', position: 0, icon: 'ti-calendar', progress: 0, phase: '', description: '',
    primer: `${USER_CAP} has opened the Schedule arm — their live Google Calendar. Help them plan, manage time, and adjust their calendar. To add, move, rename, or remove an event, emit a calendarSync action — it updates Google Calendar and the UI together. Use the event ids below to target updates and deletes.` },
  { id: 'body', name: 'Body Stats', level: 'arm', parent_id: null, template: 'health', position: 1, icon: 'ti-chart-line', progress: 0, phase: '', description: '',
    primer: `${USER_CAP} has opened the Body Stats arm — their live Oura Ring data. Focus on sleep, recovery, HRV, readiness, and physical optimization. Reference today's scores and the 7-day trends below; know the real numbers and how they're moving. Do not invent values — this is live data.` },
  { id: 'projects', name: 'Projects', level: 'arm', parent_id: null, template: 'project', position: 2, icon: 'ti-folder', progress: 0, phase: '', description: '',
    primer: `${USER_CAP} has opened the Projects arm. Focus on their active projects (listed in the tree). You can update any project's progress (0-100), phase, name, and description by returning an updateNode action. Do this when the user asks to update a project's status. Node ids: project-lab, project-build, project-diagram.` },
  { id: 'training', name: 'Training', level: 'arm', parent_id: null, template: 'training', position: 3, icon: 'ti-barbell', progress: 0, phase: '', description: '',
    primer: 'You are their training partner who has watched every session. Build or change a workout ONLY when asked — never auto-generate. When asked, pull from past workouts and the exercise library to recommend exercises, weights, and progressive overload. Log actual numbers when told what was hit. Use the updateWorkout, logSet, reorderBlocks, and setRest actions, and include the JSON in the same message as your spoken confirmation.' },
  { id: 'project-diagram', name: 'The Diagram', level: 'hand', parent_id: 'projects', template: 'project', position: 2, icon: 'ti-rocket', progress: 0, phase: 'Active', description: 'This personal AI operating system — features, fixes and ideas for The Diagram itself.',
    primer: `${USER_CAP} has opened The Diagram project — this personal AI operating system itself. Focus on build decisions, technical architecture, and what to build next.` },
  { id: 'project-lab', name: 'Research', level: 'hand', parent_id: 'projects', template: 'research', position: 0, icon: 'ti-flask', progress: 0, phase: 'Active', description: 'Research work — experiments, data, results and next steps.',
    primer: `${USER_CAP} has opened the Research project. Focus on experiments, results and next steps.` },
  { id: 'project-build', name: 'Side Project', level: 'hand', parent_id: 'projects', template: 'project', position: 1, icon: 'ti-code', progress: 0, phase: 'Planning', description: 'A personal build — design, parts, progress and open questions.',
    primer: `${USER_CAP} has opened the Side Project. Focus on design decisions, parts, progress and the next concrete step.` },
  // The North Star — the long-term-goal layer above projects. Home of the Evidence File
  // and the milestone map (dated goals land here as tasks). Seeded with NO goals — the
  // user places their own; nothing is ever auto-populated. Seeded early so the wind-down
  // overthinking support has a legitimate DocuScape home from day one.
  { id: 'north-star', name: 'North Star', level: 'hand', parent_id: 'projects', template: 'project', position: 3, icon: 'ti-north-star', progress: 0, phase: '', description: 'Your long-term goal — the thing everything else routes toward. Describe it here.',
    primer: `This is the North Star — ${USER_POSS} long-term goal, the thing the rest of the system routes toward (see this node's description; if it hasn't been filled in, ask). This node holds the Evidence File and the dated milestone map. Frame everything this way: days and features count if they advance the North Star OR protect the capacity to advance it — rest IS fuel. An ordinary hard-working day is on-path, never "nothing moved." When ${USER} has doubts here, use the Evidence File as a prompt deck they pull from themselves — and never answer a "will it even matter" doubt with an accomplishments list; that one is about values, not evidence.` },
]

// The Evidence File — the overthinking-support system's living document, seeded with a
// short how-to template and NO entries. Seeded with a FIXED id so INSERT OR IGNORE keeps
// it idempotent across boots. The Librarian must never touch this doc (excluded by node
// in lib/librarian.ts).
const EVIDENCE_FILE_MD = `# The Evidence File

*Write down concrete proof of progress here — things you finished, feedback you got, problems you solved — so it's there on a hard night.*

## The record

- *(Add an entry whenever something lands: a win, something shipped, a kind word from someone whose opinion you trust. Spectre can append entries as they happen.)*

## How to use this

Rate the thought 0–100. Pull the evidence **yourself** — that's what makes it work — then re-rate.

This file answers "am I capable" and "am I behind." It does **not** answer "will it even matter" — that one isn't beaten with a list; it's met by reconnecting with why this path matters to you.
`

let _seeded = false
function seedNodes(d: Database.Database): void {
  if (_seeded) return
  const now = Date.now()
  const stmt = d.prepare(
    `INSERT OR IGNORE INTO diagram_nodes (id, name, level, parent_id, template, position, primer, icon, created_at, is_archived)
     VALUES (@id, @name, @level, @parent_id, @template, @position, @primer, @icon, @created_at, 0)`,
  )
  const tx = d.transaction((rows: typeof SEED_NODES) => rows.forEach(r => stmt.run({ ...r, created_at: now })))
  tx(SEED_NODES)
  // Evidence File — direct idempotent insert (fixed PK; createNotebook isn't safe to call
  // mid-init). Content is TipTap JSON like every notebook row.
  const seedDoc = (id: string, title: string, md: string, icon: string) => {
    try {
      d.prepare(
        `INSERT OR IGNORE INTO notebooks (id, node_id, parent_id, type, title, content, position, created_at, updated_at, is_archived, created_by, icon, color)
         VALUES (?, 'north-star', '', 'notebook', ?, ?, 0, ?, ?, 0, 'spectre', ?, '')`,
      ).run(id, title, JSON.stringify(markdownToTiptap(md)), now, now, icon)
    } catch (e) {
      console.warn(`[seed] doc ${id} skipped:`, (e as Error).message)
    }
  }
  seedDoc('evidence-file', 'The Evidence File', EVIDENCE_FILE_MD, '🛡️')
  _seeded = true
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// Rough token estimate (~4 chars/token) — good enough to drive the window budget.
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4)
}

// Auto-title from the first user message: first 6–8 words, cleanly truncated.
export function deriveTitle(text: string): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return 'New conversation'
  const words = clean.split(' ').slice(0, 8).join(' ')
  let title = words.length > 48 ? words.slice(0, 48).replace(/\s+\S*$/, '') : words
  title = title.replace(/[.,;:!?\-–—]+$/, '').trim()
  return title || 'New conversation'
}

function preview(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function contextTokens(sessionId: string): number {
  const row = db()
    .prepare(`SELECT COALESCE(SUM(token_count),0) AS t FROM messages WHERE session_id = ? AND in_context = 1`)
    .get(sessionId) as { t: number }
  return row.t
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export function listSessions(folderId: string, includeArchived = false): SessionRow[] {
  return db()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.is_compressed = 1) AS summary_count
       FROM sessions s
       WHERE s.folder_id = ? ${includeArchived ? '' : 'AND s.is_archived = 0'}
       ORDER BY s.updated_at DESC`,
    )
    .all(folderId) as SessionRow[]
}

export function getSession(id: string): SessionRow | undefined {
  return db().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined
}

export function createSession(folderId: string, opts: { title?: string; firstMessage?: string; tag_id?: string | null } = {}): SessionRow {
  const now = Date.now()
  const id = randomUUID()
  const title = (opts.title?.trim() || (opts.firstMessage ? deriveTitle(opts.firstMessage) : 'New conversation'))
  db()
    .prepare(
      `INSERT INTO sessions (id, folder_id, title, created_at, updated_at, last_message_preview, is_archived, tag_id)
       VALUES (?, ?, ?, ?, ?, '', 0, ?)`,
    )
    .run(id, folderId, title, now, now, opts.tag_id ?? null)
  return getSession(id)!
}

// Set or clear a session's section/tag.
export function setSessionTag(id: string, tagId: string | null): SessionRow | undefined {
  const s = getSession(id)
  if (!s) return undefined
  db().prepare(`UPDATE sessions SET tag_id = ? WHERE id = ?`).run(tagId ?? null, id)
  return getSession(id)
}

export function updateSession(id: string, patch: { title?: string; is_archived?: boolean }): SessionRow | undefined {
  const s = getSession(id)
  if (!s) return undefined
  const title = patch.title !== undefined ? patch.title : s.title
  const archived = patch.is_archived !== undefined ? (patch.is_archived ? 1 : 0) : s.is_archived
  db()
    .prepare(`UPDATE sessions SET title = ?, is_archived = ?, updated_at = ? WHERE id = ?`)
    .run(title, archived, Date.now(), id)
  return getSession(id)
}

// ── Messages ─────────────────────────────────────────────────────────────────
export function getMessages(sessionId: string): MessageRow[] {
  // Soft-deleted rows (truncated by an edit/retry) are kept in the DB but never
  // surfaced — they belong to neither the display buffer nor the context window.
  return db()
    .prepare(`SELECT * FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY timestamp ASC, rowid ASC`)
    .all(sessionId) as MessageRow[]
}

// Edit a verbatim message in place (recomputing its token estimate). Used by the
// "edit a past user message" flow before truncating everything after it.
export function editMessage(sessionId: string, messageId: string, content: string): MessageRow | undefined {
  db()
    .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE id = ? AND session_id = ?`)
    .run(content, estimateTokens(content), messageId, sessionId)
  return db().prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined
}

// Truncate the conversation: soft-delete every verbatim message after `messageId`
// (or after-and-including it when `inclusive`), flagging them out of context. Used by
// message-edit (exclusive — keep the edited message) and retry (inclusive — drop the
// last assistant turn). Summaries are left intact. Returns the surviving messages.
export function truncateAfter(sessionId: string, messageId: string, inclusive = false): MessageRow[] {
  const anchor = db().prepare(`SELECT timestamp, rowid FROM messages WHERE id = ? AND session_id = ?`).get(messageId, sessionId) as { timestamp: number; rowid: number } | undefined
  if (anchor) {
    const now = Date.now()
    const cmp = inclusive ? '>=' : '>'
    db()
      .prepare(
        `UPDATE messages
         SET in_context = 0, deleted_at = ?
         WHERE session_id = ? AND is_compressed = 0 AND deleted_at IS NULL
           AND (timestamp > ? OR (timestamp = ? AND rowid ${cmp} ?))`,
      )
      .run(now, sessionId, anchor.timestamp, anchor.timestamp, anchor.rowid)
    // Keep the session preview honest after a truncation.
    const last = db()
      .prepare(`SELECT content FROM messages WHERE session_id = ? AND deleted_at IS NULL AND is_compressed = 0 ORDER BY timestamp DESC, rowid DESC LIMIT 1`)
      .get(sessionId) as { content: string } | undefined
    db().prepare(`UPDATE sessions SET updated_at = ?, last_message_preview = ? WHERE id = ?`)
      .run(now, preview(last?.content ?? ''), sessionId)
  }
  return getMessages(sessionId)
}

// ── Scribe (the chronicle) ───────────────────────────────────────────────────
export interface ScribeEntryRow {
  id: string
  date: string
  status: 'live' | 'final'
  title: string
  narrative: string
  themes: string        // JSON array
  source_hash: string
  source_count: number
  model: string
  narrated_through: number
  created_at: number
  updated_at: number
}

// A day's chat across ALL sessions, time-ordered, with scope + session title — the daily bank.
// Verbatim user/assistant turns only (compressed summaries + soft-deleted turns excluded).
export function getDayMessages(startMs: number, endMs: number): { role: string; content: string; timestamp: number; folder_id: string; session_title: string }[] {
  return db().prepare(
    `SELECT m.role AS role, m.content AS content, m.timestamp AS timestamp,
            s.folder_id AS folder_id, s.title AS session_title
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.timestamp >= ? AND m.timestamp < ?
       AND m.is_compressed = 0 AND m.deleted_at IS NULL AND s.is_archived = 0
       AND s.folder_id NOT LIKE 'secretary-%' AND s.folder_id NOT LIKE 'spiral-%'
     ORDER BY m.timestamp ASC, m.rowid ASC`,
  ).all(startMs, endMs) as { role: string; content: string; timestamp: number; folder_id: string; session_title: string }[]
}

export function getScribeEntry(date: string): ScribeEntryRow | undefined {
  return db().prepare(`SELECT * FROM scribe_entries WHERE date = ?`).get(date) as ScribeEntryRow | undefined
}

export function listScribeEntries(limit = 180): ScribeEntryRow[] {
  return db().prepare(`SELECT * FROM scribe_entries ORDER BY date DESC LIMIT ?`).all(limit) as ScribeEntryRow[]
}

export function upsertScribeEntry(e: { date: string; status: 'live' | 'final'; title: string; narrative: string; themes: string[]; source_hash: string; source_count: number; model: string; narrated_through: number }): ScribeEntryRow {
  const now = Date.now()
  const themesJson = JSON.stringify(e.themes ?? [])
  if (getScribeEntry(e.date)) {
    db().prepare(
      `UPDATE scribe_entries SET status = ?, title = ?, narrative = ?, themes = ?, source_hash = ?, source_count = ?, model = ?, narrated_through = ?, updated_at = ? WHERE date = ?`,
    ).run(e.status, e.title, e.narrative, themesJson, e.source_hash, e.source_count, e.model, e.narrated_through, now, e.date)
  } else {
    db().prepare(
      `INSERT INTO scribe_entries (id, date, status, title, narrative, themes, source_hash, source_count, model, narrated_through, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), e.date, e.status, e.title, e.narrative, themesJson, e.source_hash, e.source_count, e.model, e.narrated_through, now, now)
  }
  return getScribeEntry(e.date)!
}

// Lock a day (live → final) without re-narrating — used when no fresh generation is warranted.
export function finalizeScribeEntry(date: string): void {
  db().prepare(`UPDATE scribe_entries SET status = 'final', updated_at = ? WHERE date = ? AND status != 'final'`).run(Date.now(), date)
}

export function getScribeArc(): string {
  const row = db().prepare(`SELECT arc FROM scribe_meta WHERE id = 1`).get() as { arc: string } | undefined
  return row?.arc ?? ''
}

export function setScribeArc(arc: string): void {
  db().prepare(`INSERT INTO scribe_meta (id, arc, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET arc = excluded.arc, updated_at = excluded.updated_at`).run(arc, Date.now())
}

export function getQuoteOfDay(): { date: string; quote: string; author: string } {
  const row = db().prepare(`SELECT quote_date AS date, quote, quote_author AS author FROM scribe_meta WHERE id = 1`).get() as { date: string; quote: string; author: string } | undefined
  return { date: row?.date ?? '', quote: row?.quote ?? '', author: row?.author ?? '' }
}

export function setQuoteOfDay(date: string, quote: string, author: string): void {
  db().prepare(
    `INSERT INTO scribe_meta (id, quote_date, quote, quote_author, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET quote_date = excluded.quote_date, quote = excluded.quote, quote_author = excluded.quote_author, updated_at = excluded.updated_at`,
  ).run(date, quote, author, Date.now())
}

export function getWordOfDay(): { word: string; def: string; idx: number } {
  const r = db().prepare(`SELECT word, word_def AS def, word_idx AS idx FROM scribe_meta WHERE id = 1`).get() as { word: string; def: string; idx: number } | undefined
  return { word: r?.word ?? '', def: r?.def ?? '', idx: r?.idx ?? 0 }
}

export function setWordOfDay(word: string, def: string, idx: number): void {
  db().prepare(
    `INSERT INTO scribe_meta (id, word, word_def, word_idx, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET word = excluded.word, word_def = excluded.word_def, word_idx = excluded.word_idx, updated_at = excluded.updated_at`,
  ).run(word, def, idx, Date.now())
}

// ── Librarian (autonomous document organizer) ────────────────────────────────────
// The Librarian proposes a plan to tidy ONE project's DocuScape documents — file loose docs
// into folders, flag junk, merge dupes, rename. A plan is stored here and reviewed/approved in
// the UI before ANYTHING is applied (nothing moves without the user's click). The table is created
// LAZILY (ensureLibrarianSchema) so it also appears on an already-running dev server, where the
// main schema block ran at boot without it. This table is fully isolated — it has NO connection
// to Mem0 or Spectre's chat memory. The plan_json holds the typed action list (shape lives in
// lib/librarian.ts); each action carries its own per-item status.
export type LibrarianPlanRow = {
  id: string
  node_id: string
  status: string          // 'proposed' | 'applied' | 'dismissed'
  plan_json: string       // JSON array of proposed actions
  model: string
  summary: string
  created_at: number
  updated_at: number
}

let _librarianSchemaReady = false
function ensureLibrarianSchema(): void {
  if (_librarianSchemaReady) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS librarian_plans (
      id         TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'proposed',  -- 'proposed' | 'applied' | 'dismissed'
      plan_json  TEXT NOT NULL DEFAULT '[]',
      model      TEXT NOT NULL DEFAULT '',
      summary    TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_librarian_node ON librarian_plans(node_id, status, updated_at DESC);
  `)
  _librarianSchemaReady = true
}

// The current open (proposed) plan for a node, if any — newest wins.
export function getLibrarianPlan(nodeId: string): LibrarianPlanRow | undefined {
  ensureLibrarianSchema()
  return db().prepare(`SELECT * FROM librarian_plans WHERE node_id = ? AND status = 'proposed' ORDER BY updated_at DESC LIMIT 1`).get(nodeId) as LibrarianPlanRow | undefined
}

export function getLibrarianPlanById(id: string): LibrarianPlanRow | undefined {
  ensureLibrarianSchema()
  return db().prepare(`SELECT * FROM librarian_plans WHERE id = ?`).get(id) as LibrarianPlanRow | undefined
}

// All plans in a given status (default 'proposed') — the notification bell counts these.
export function listLibrarianPlans(status = 'proposed'): LibrarianPlanRow[] {
  ensureLibrarianSchema()
  return db().prepare(`SELECT * FROM librarian_plans WHERE status = ? ORDER BY updated_at DESC`).all(status) as LibrarianPlanRow[]
}

// Create a fresh proposed plan, superseding any prior open plan for the same node.
export function createLibrarianPlan(opts: { node_id: string; plan_json: string; model: string; summary: string }): LibrarianPlanRow {
  ensureLibrarianSchema()
  const now = Date.now()
  db().prepare(`UPDATE librarian_plans SET status = 'dismissed', updated_at = ? WHERE node_id = ? AND status = 'proposed'`).run(now, opts.node_id)
  const id = randomUUID()
  db().prepare(
    `INSERT INTO librarian_plans (id, node_id, status, plan_json, model, summary, created_at, updated_at)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`,
  ).run(id, opts.node_id, opts.plan_json, opts.model, opts.summary, now, now)
  return getLibrarianPlanById(id)!
}

export function updateLibrarianPlan(id: string, patch: { plan_json?: string; status?: string; summary?: string }): LibrarianPlanRow | undefined {
  ensureLibrarianSchema()
  const p = getLibrarianPlanById(id)
  if (!p) return undefined
  db().prepare(`UPDATE librarian_plans SET plan_json = ?, status = ?, summary = ?, updated_at = ? WHERE id = ?`)
    .run(patch.plan_json ?? p.plan_json, patch.status ?? p.status, patch.summary ?? p.summary, Date.now(), id)
  return getLibrarianPlanById(id)
}

// ── Tasks · Phases · Blocks · Secretary proposals (the unified task system) ────────
// One `tasks` table, three projections (project map /
// to-do list / block checklists). Steps are SPARSE FRACTIONAL (REAL): inserting between
// steps 2 and 3 writes 2.5 — a move/insert never rewrites other rows, so a single-row
// task_events before/after is a complete undo. Tables are created LAZILY (Librarian
// precedent) so they appear on an already-running dev server.
export type TaskRow = {
  id: string
  node_id: string          // owning project Hand id; '' = personal/global
  notepad_id?: string      // linked notepad category ('' = none) — note-lists complete as a whole
  title: string
  notes: string
  status: string           // 'todo' | 'done' | 'dropped' (lifecycle only)
  is_archived: number      // visibility only
  step: number | null      // sparse fractional map column; NULL = not on a map (Inbox/personal)
  lane: number
  phase_id: string         // phases.id ('' = none)
  due_at: string | null    // NULL = none · 'YYYY-MM-DD' = untimed/all-day · full ISO UTC-Z = timed
  block_event_id: string   // assigned calendar event id ('' = unassigned)
  position: number         // personal-list order
  source: string           // 'user' | 'secretary'
  created_at: number
  updated_at: number
  completed_at: number | null
}
export type PhaseRow = { id: string; node_id: string; name: string; color: string; position: number; created_at: number }
export type BlockRow = {
  event_id: string         // Google event id (instance id for recurring events)
  node_id: string
  matched: string          // 'auto' | 'manual' | 'unlinked' (tombstone — matcher skips)
  recurring_event_id: string
  title: string
  start_at: number
  end_at: number
  created_at: number
}
export type TaskEventRow = {
  id: string; task_id: string; group_id: string
  op: string               // 'create'|'update'|'complete'|'reopen'|'move'|'assign'|'unassign'|'drop'|'archive'
  before_json: string; after_json: string
  actor: string            // 'user' | 'secretary'
  created_at: number
}
export type SecretaryProposalRow = {
  id: string; node_id: string
  actions_json: string     // typed action list (shape lives in lib/tools/secretary.ts)
  summary: string
  status: string           // 'proposed' | 'applied' | 'dismissed'
  created_at: number; resolved_at: number | null
}

let _tasksSchemaReady = false
function ensureTasksSchema(): void {
  if (_tasksSchemaReady) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id             TEXT PRIMARY KEY,
      node_id        TEXT NOT NULL DEFAULT '',
      title          TEXT NOT NULL,
      notes          TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'todo',
      is_archived    INTEGER NOT NULL DEFAULT 0,
      step           REAL,
      lane           INTEGER NOT NULL DEFAULT 0,
      phase_id       TEXT NOT NULL DEFAULT '',
      due_at         TEXT,
      block_event_id TEXT NOT NULL DEFAULT '',
      position       INTEGER NOT NULL DEFAULT 0,
      source         TEXT NOT NULL DEFAULT 'user',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      completed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id, status, is_archived, step);
    CREATE INDEX IF NOT EXISTS idx_tasks_block ON tasks(block_event_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

    CREATE TABLE IF NOT EXISTS phases (
      id         TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phases_node ON phases(node_id, position);

    CREATE TABLE IF NOT EXISTS blocks (
      event_id           TEXT PRIMARY KEY,
      node_id            TEXT NOT NULL,
      matched            TEXT NOT NULL DEFAULT 'auto',
      recurring_event_id TEXT NOT NULL DEFAULT '',
      title              TEXT NOT NULL DEFAULT '',
      start_at           INTEGER NOT NULL DEFAULT 0,
      end_at             INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks(start_at, end_at);

    CREATE TABLE IF NOT EXISTS task_events (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      group_id    TEXT NOT NULL DEFAULT '',
      op          TEXT NOT NULL,
      before_json TEXT NOT NULL DEFAULT '',
      after_json  TEXT NOT NULL DEFAULT '',
      actor       TEXT NOT NULL DEFAULT 'user',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_events_time ON task_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS secretary_proposals (
      id           TEXT PRIMARY KEY,
      node_id      TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      summary      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'proposed',
      created_at   INTEGER NOT NULL,
      resolved_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_node ON secretary_proposals(node_id, status);
  `)
  _tasksSchemaReady = true
}

// Run a set of task mutations atomically — any throw rolls the whole thing back.
export function tasksTransaction(fn: () => void): void {
  ensureTasksSchema()
  db().transaction(fn)()
}

// ── Web Push subscriptions (Phase 2 notifications) ─────────────────────────────────
// One row per device endpoint. iOS subscriptions die spontaneously, so the client re-subscribes
// on every app open (upsert by endpoint). Lazy schema (Librarian precedent).
export type PushSubscriptionRow = {
  endpoint: string; p256dh: string; auth: string
  label: string; created_at: number; last_seen: number
}
let _pushSchemaReady = false
function ensurePushSchema(): void {
  if (_pushSchemaReady) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      label      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
  `)
  _pushSchemaReady = true
}
export function upsertPushSubscription(opts: { endpoint: string; p256dh: string; auth: string; label?: string }): void {
  ensurePushSchema()
  const now = Date.now()
  db().prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
       label = CASE WHEN excluded.label != '' THEN excluded.label ELSE push_subscriptions.label END,
       last_seen = excluded.last_seen`,
  ).run(opts.endpoint, opts.p256dh, opts.auth, opts.label ?? '', now, now)
}
export function listPushSubscriptions(): PushSubscriptionRow[] {
  ensurePushSchema()
  return db().prepare(`SELECT * FROM push_subscriptions ORDER BY last_seen DESC`).all() as PushSubscriptionRow[]
}
export function removePushSubscription(endpoint: string): void {
  ensurePushSchema()
  db().prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint)
}

// ── Spectre's own reminders (proactive follow-ups) ────────────────────────────────
// Spectre schedules a self-reminder to check on something / ping the user at a future time (e.g.
// "check in on your sleep stats tomorrow morning"). The notification scheduler fires it as a
// push. This is what turns "I'll remind you" from a fabrication into a real capability.
export type ReminderRow = {
  id: string; due_at: number; message: string; scope: string
  status: string   // 'pending' | 'fired' | 'cancelled'
  created_at: number; fired_at: number | null
}
function ensureRemindersSchema(): void {
  ensurePushSchema()   // reminders live alongside push (same subsystem); reuse its lazy init guard
  db().exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id         TEXT PRIMARY KEY,
      due_at     INTEGER NOT NULL,
      message    TEXT NOT NULL,
      scope      TEXT NOT NULL DEFAULT 'main',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
  `)
}
export function createReminder(opts: { due_at: number; message: string; scope?: string }): ReminderRow {
  ensureRemindersSchema()
  const id = randomUUID()
  db().prepare(`INSERT INTO reminders (id, due_at, message, scope, status, created_at, fired_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)`)
    .run(id, opts.due_at, opts.message.trim(), opts.scope ?? 'main', Date.now())
  return db().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as ReminderRow
}
export function listReminders(status = 'pending'): ReminderRow[] {
  ensureRemindersSchema()
  return db().prepare(`SELECT * FROM reminders WHERE status = ? ORDER BY due_at ASC`).all(status) as ReminderRow[]
}
// Pending reminders whose time has arrived within the last window (the scheduler fires these).
export function dueReminders(nowMs: number, windowMs: number): ReminderRow[] {
  ensureRemindersSchema()
  return db().prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? AND due_at > ?`).all(nowMs, nowMs - windowMs) as ReminderRow[]
}
export function markReminderFired(id: string): void {
  ensureRemindersSchema()
  db().prepare(`UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?`).run(Date.now(), id)
}
export function cancelReminder(id: string): void {
  ensureRemindersSchema()
  db().prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).run(id)
}

// ── The morning read (Curated For You, real) — one compiled news day per date ──────
// Items are curated each morning on the local model from live web search (lib/news.ts);
// morning_note is Spectre's short grounded note (yesterday's chapter + today's shape).
export type NewsDayRow = {
  date: string; items_json: string; morning_note: string; model: string; created_at: number
}
let _newsSchema = false
function ensureNewsSchema(): void {
  if (_newsSchema) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS news_days (
      date         TEXT PRIMARY KEY,
      items_json   TEXT NOT NULL DEFAULT '[]',
      morning_note TEXT NOT NULL DEFAULT '',
      model        TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL
    );
  `)
  _newsSchema = true
}
export function getNewsDay(date: string): NewsDayRow | undefined {
  ensureNewsSchema()
  return db().prepare(`SELECT * FROM news_days WHERE date = ?`).get(date) as NewsDayRow | undefined
}
export function upsertNewsDay(opts: { date: string; items_json: string; morning_note: string; model: string }): void {
  ensureNewsSchema()
  db().prepare(
    `INSERT INTO news_days (date, items_json, morning_note, model, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET items_json = excluded.items_json, morning_note = excluded.morning_note, model = excluded.model`,
  ).run(opts.date, opts.items_json, opts.morning_note, opts.model, Date.now())
}

// ── Habits — the tracker, the Diagram way ─────────────────────────────────────────
// Deterministic, no LLM. A habit is a named daily checkable; a check is one (habit, date)
// row. Streaks/graphs derive at read time — nothing stored that can drift.
export type HabitRow = { id: string; name: string; target_per_week: number; position: number; created_at: number; is_archived: number }
let _habitsSchema = false
function ensureHabitsSchema(): void {
  if (_habitsSchema) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      target_per_week INTEGER NOT NULL DEFAULT 7,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS habit_checks (
      habit_id TEXT NOT NULL, date TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (habit_id, date)
    );
  `)
  // Seed a small set of generic example habits — rename, archive or add your own in the UI.
  // INSERT OR IGNORE via fixed ids → idempotent; archiving one keeps it gone. The ids are
  // load-bearing: habit-gym + habit-sleep are auto-checked (lib/habitAuto.ts), and the
  // wind-down surface shows the night habits (habit-walk / habit-read / habit-sleep).
  const seed = db().prepare(`INSERT OR IGNORE INTO habits (id, name, target_per_week, position, created_at) VALUES (?, ?, ?, ?, ?)`)
  const now = Date.now()
  seed.run('habit-sleep', 'Asleep by bedtime', 7, 0, now)
  seed.run('habit-gym', 'Move', 5, 1, now)
  seed.run('habit-walk', 'Evening walk', 7, 2, now)
  seed.run('habit-read', 'Read 20 min', 7, 3, now)
  _habitsSchema = true
}
export function listHabits(): HabitRow[] {
  ensureHabitsSchema()
  return db().prepare(`SELECT * FROM habits WHERE is_archived = 0 ORDER BY position, created_at`).all() as HabitRow[]
}
export function createHabit(name: string, targetPerWeek = 7): HabitRow {
  ensureHabitsSchema()
  const id = randomUUID()
  const sib = db().prepare(`SELECT COUNT(*) n FROM habits WHERE is_archived = 0`).get() as { n: number }
  db().prepare(`INSERT INTO habits (id, name, target_per_week, position, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name.trim() || 'Habit', targetPerWeek, sib.n, Date.now())
  return db().prepare(`SELECT * FROM habits WHERE id = ?`).get(id) as HabitRow
}
export function archiveHabit(id: string): void {
  ensureHabitsSchema()
  db().prepare(`UPDATE habits SET is_archived = 1 WHERE id = ?`).run(id)
}
export function setHabitCheck(habitId: string, date: string, checked: boolean): void {
  ensureHabitsSchema()
  if (checked) db().prepare(`INSERT OR IGNORE INTO habit_checks (habit_id, date, created_at) VALUES (?, ?, ?)`).run(habitId, date, Date.now())
  else db().prepare(`DELETE FROM habit_checks WHERE habit_id = ? AND date = ?`).run(habitId, date)
}
export function listHabitChecks(sinceDate: string): { habit_id: string; date: string }[] {
  ensureHabitsSchema()
  return db().prepare(`SELECT habit_id, date FROM habit_checks WHERE date >= ? ORDER BY date`).all(sinceDate) as { habit_id: string; date: string }[]
}

// ── Focus sessions — the deep-work timer (records how long you're in deep focus) ──
export type FocusSessionRow = { id: string; label: string; started_at: number; ended_at: number | null; task_id: string }
let _focusSchema = false
function ensureFocusSchema(): void {
  if (_focusSchema) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS focus_sessions (
      id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT 'Deep work',
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at DESC);
  `)
  // Lazy migration — a session can carry the task it worked on (weave item 1).
  try { db().exec(`ALTER TABLE focus_sessions ADD COLUMN task_id TEXT NOT NULL DEFAULT ''`) } catch { /* column exists */ }
  _focusSchema = true
}
export function getOpenFocus(): FocusSessionRow | undefined {
  ensureFocusSchema()
  return db().prepare(`SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get() as FocusSessionRow | undefined
}
export function startFocus(label: string, taskId = ''): FocusSessionRow {
  ensureFocusSchema()
  // One open session at a time — starting a new one lands the old (never two clocks).
  db().prepare(`UPDATE focus_sessions SET ended_at = ? WHERE ended_at IS NULL`).run(Date.now())
  const id = randomUUID()
  db().prepare(`INSERT INTO focus_sessions (id, label, started_at, ended_at, task_id) VALUES (?, ?, ?, NULL, ?)`)
    .run(id, label.trim() || 'Deep work', Date.now(), taskId)
  return db().prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as FocusSessionRow
}
export function stopFocus(): FocusSessionRow | undefined {
  ensureFocusSchema()
  const open = getOpenFocus()
  if (!open) return undefined
  const ended = Date.now()
  db().prepare(`UPDATE focus_sessions SET ended_at = ? WHERE id = ?`).run(ended, open.id)
  // Time flows back to the task: the linked task accumulates its REAL cost across every
  // session spent on it — "how long did that actually take."
  if (open.task_id) {
    try {
      try { db().exec(`ALTER TABLE tasks ADD COLUMN spent_ms INTEGER NOT NULL DEFAULT 0`) } catch { /* column exists */ }
      db().prepare(`UPDATE tasks SET spent_ms = spent_ms + ? WHERE id = ?`).run(Math.max(0, ended - open.started_at), open.task_id)
    } catch (e) {
      console.warn('[focus] task time accumulate failed:', (e as Error).message)
    }
  }
  return db().prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(open.id) as FocusSessionRow
}
export function renameOpenFocus(label: string): void {
  ensureFocusSchema()
  db().prepare(`UPDATE focus_sessions SET label = ? WHERE ended_at IS NULL`).run(label.trim() || 'Deep work')
}
export function listFocusSince(sinceMs: number): FocusSessionRow[] {
  ensureFocusSchema()
  return db().prepare(`SELECT * FROM focus_sessions WHERE started_at >= ? OR ended_at ISNULL ORDER BY started_at`).all(sinceMs) as FocusSessionRow[]
}
// Total real time tracked per project node (sum of tasks.spent_ms) — the project-level
// rollup of the focus↔task weave (time populates back to the project folder).
export function projectSpentMsByNode(): Record<string, number> {
  ensureTasksSchema()
  try {
    const rows = db().prepare(`SELECT node_id, COALESCE(SUM(spent_ms),0) AS ms FROM tasks WHERE node_id != '' GROUP BY node_id`).all() as { node_id: string; ms: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) if (r.ms > 0) out[r.node_id] = r.ms
    return out
  } catch { return {} }   // spent_ms column not created yet (no focus session landed) → empty
}

// ── Notepads — the whiteboard next to the desk; plain text, main page ────
export type NotepadRow = { id: string; title: string; content: string; position: number; created_at: number; updated_at: number; is_archived: number }
let _notepadsSchema = false
function ensureNotepadsSchema(): void {
  if (_notepadsSchema) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS notepads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
  `)
  const seed = db().prepare(`INSERT OR IGNORE INTO notepads (id, title, content, position, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?)`)
  const now = Date.now()
  seed.run('notepad-grocery', 'Grocery list', 0, now, now)
  _notepadsSchema = true
}
export function listNotepads(): NotepadRow[] {
  ensureNotepadsSchema()
  return db().prepare(`SELECT * FROM notepads WHERE is_archived = 0 ORDER BY position, created_at`).all() as NotepadRow[]
}
export function createNotepad(title: string): NotepadRow {
  ensureNotepadsSchema()
  const id = randomUUID()
  const now = Date.now()
  const sib = db().prepare(`SELECT COUNT(*) n FROM notepads WHERE is_archived = 0`).get() as { n: number }
  db().prepare(`INSERT INTO notepads (id, title, content, position, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?)`)
    .run(id, title.trim() || 'Notepad', sib.n, now, now)
  return db().prepare(`SELECT * FROM notepads WHERE id = ?`).get(id) as NotepadRow
}
export function updateNotepad(id: string, patch: { title?: string; content?: string; is_archived?: boolean }): NotepadRow | undefined {
  ensureNotepadsSchema()
  const n = db().prepare(`SELECT * FROM notepads WHERE id = ?`).get(id) as NotepadRow | undefined
  if (!n) return undefined
  db().prepare(`UPDATE notepads SET title = ?, content = ?, is_archived = ?, updated_at = ? WHERE id = ?`)
    .run(patch.title !== undefined ? patch.title : n.title,
      patch.content !== undefined ? patch.content : n.content,
      patch.is_archived !== undefined ? (patch.is_archived ? 1 : 0) : n.is_archived,
      Date.now(), id)
  return db().prepare(`SELECT * FROM notepads WHERE id = ?`).get(id) as NotepadRow
}

// ── Inbox — the one place Spectre reaches the user ──
// A read model of everything that already fires: reminders, rhythm pushes, news compiles.
// Producers call addInboxEvent; the box renders the stream; reading marks it seen.
export type InboxEventRow = { id: string; kind: string; title: string; body: string; created_at: number; read_at: number | null }
let _inboxSchema = false
function ensureInboxSchema(): void {
  if (_inboxSchema) return
  db().exec(`
    CREATE TABLE IF NOT EXISTS inbox_events (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'system',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_events(created_at DESC);
  `)
  // One honest first event so the box explains itself (fixed id → idempotent).
  db().prepare(`INSERT OR IGNORE INTO inbox_events (id, kind, title, body, created_at, read_at) VALUES ('inbox-online', 'system', 'Inbox online', 'Spectre''s check-ins, wind-down and morning pings, and news compiles land here from now on.', ?, NULL)`).run(Date.now())
  _inboxSchema = true
}
export function addInboxEvent(opts: { kind: string; title: string; body?: string }): void {
  try {
    ensureInboxSchema()
    db().prepare(`INSERT INTO inbox_events (id, kind, title, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(randomUUID(), opts.kind, opts.title.trim(), (opts.body ?? '').trim(), Date.now())
  } catch (e) {
    console.warn('[inbox] add failed:', (e as Error).message)   // never breaks a producer
  }
}
export function listInboxEvents(limit = 20): InboxEventRow[] {
  ensureInboxSchema()
  return db().prepare(`SELECT * FROM inbox_events ORDER BY created_at DESC LIMIT ?`).all(limit) as InboxEventRow[]
}
export function inboxUnreadCount(): number {
  ensureInboxSchema()
  return (db().prepare(`SELECT COUNT(*) n FROM inbox_events WHERE read_at IS NULL`).get() as { n: number }).n
}
export function markInboxRead(): void {
  ensureInboxSchema()
  db().prepare(`UPDATE inbox_events SET read_at = ? WHERE read_at IS NULL`).run(Date.now())
}

// Notification dedupe ledger — the scheduler evaluates the same window every minute, so each
// reminder is keyed (due:<task>:<due>, blockend:<event>, digest:<date>) and fired ONCE. Returns
// true only the first time a key is seen; false thereafter. Old rows self-prune.
export function markNotified(key: string): boolean {
  ensurePushSchema()
  db().exec(`CREATE TABLE IF NOT EXISTS sent_notifications (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`)
  const now = Date.now()
  try {
    db().prepare(`INSERT INTO sent_notifications (key, created_at) VALUES (?, ?)`).run(key, now)
    db().prepare(`DELETE FROM sent_notifications WHERE created_at < ?`).run(now - 14 * 24 * 3600 * 1000)
    return true
  } catch {
    return false   // PRIMARY KEY conflict = already fired
  }
}

function logTaskEvent(taskId: string, op: string, before: TaskRow | null, after: TaskRow | null, actor: string, groupId = ''): void {
  db().prepare(
    `INSERT INTO task_events (id, task_id, group_id, op, before_json, after_json, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), taskId, groupId, op, before ? JSON.stringify(before) : '', after ? JSON.stringify(after) : '', actor, Date.now())
}

// Tasks — nodeId '' = personal only, undefined = everything (the NOW list derives client-side
// from the full small set). Lifecycle (done) and visibility (dropped/archived) are independent
// filters — 'dropped' and 'archived' are EXCLUDED by default (so soft-deleted tasks can never
// leak into a listing, a ref pool, or the map); 'done' is excluded unless includeDone. Tasks of
// archived projects never surface.
export function listTasks(nodeId?: string, opts: { includeDone?: boolean; includeArchived?: boolean; includeDropped?: boolean } = {}): TaskRow[] {
  ensureTasksSchema()
  const where: string[] = []
  const args: unknown[] = []
  if (nodeId !== undefined) { where.push('t.node_id = ?'); args.push(nodeId) }
  if (!opts.includeArchived) where.push('t.is_archived = 0')
  if (!opts.includeDropped) where.push(`t.status != 'dropped'`)
  if (!opts.includeDone) where.push(`t.status != 'done'`)
  where.push(`(t.node_id = '' OR EXISTS (SELECT 1 FROM diagram_nodes n WHERE n.id = t.node_id AND n.is_archived = 0))`)
  return db().prepare(
    `SELECT t.* FROM tasks t WHERE ${where.join(' AND ')}
     ORDER BY t.step IS NULL, t.step ASC, t.lane ASC, t.position ASC, t.created_at ASC`,
  ).all(...args) as TaskRow[]
}

// A task that still exists and is actionable (not dropped/archived) — the liveness gate the
// Secretary apply path uses so a soft-deleted task can't be silently mutated.
export function getLiveTask(id: string): TaskRow | undefined {
  const t = getTask(id)
  return t && t.status !== 'dropped' && !t.is_archived ? t : undefined
}

export function getTask(id: string): TaskRow | undefined {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
}

export function createTask(opts: {
  node_id?: string; title: string; notes?: string; step?: number | null; lane?: number
  phase_id?: string; due_at?: string | null; block_event_id?: string; source?: string; actor?: string; group_id?: string
  notepad_id?: string   // note-linked category (a notepad pushed to Tasks as a list)
}): TaskRow {
  ensureTasksSchema()
  // Lazy migration for the note-category column (same pattern as tasks.spent_ms).
  try { db().exec(`ALTER TABLE tasks ADD COLUMN notepad_id TEXT NOT NULL DEFAULT ''`) } catch { /* column exists */ }
  const now = Date.now()
  const id = randomUUID()
  const nodeId = opts.node_id ?? ''
  // Append-to-end position among live siblings (createNode precedent).
  const pos = (db().prepare(`SELECT COUNT(*) AS c FROM tasks WHERE node_id = ? AND is_archived = 0`).get(nodeId) as { c: number }).c
  db().prepare(
    `INSERT INTO tasks (id, node_id, notepad_id, title, notes, status, is_archived, step, lane, phase_id, due_at, block_event_id, position, source, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'todo', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, nodeId, opts.notepad_id ?? '', opts.title.trim() || 'Untitled task', opts.notes ?? '', opts.step ?? null, opts.lane ?? 0,
    opts.phase_id ?? '', opts.due_at ?? null, opts.block_event_id ?? '', pos, opts.source ?? 'user', now, now)
  const row = getTask(id)!
  logTaskEvent(id, 'create', null, row, opts.actor ?? 'user', opts.group_id ?? '')
  return row
}

// One update path for every task mutation — the op is inferred from what changed so the
// task_events log (and undo) stay honest without N separate helpers.
export function updateTask(
  id: string,
  patch: Partial<Pick<TaskRow, 'title' | 'notes' | 'status' | 'is_archived' | 'step' | 'lane' | 'phase_id' | 'due_at' | 'block_event_id' | 'position'>>,
  opts: { actor?: string; group_id?: string } = {},
): TaskRow | undefined {
  ensureTasksSchema()
  const before = getTask(id)
  if (!before) return undefined
  const now = Date.now()
  const next: Record<string, unknown> = { ...patch }
  if (patch.status === 'done' && before.status !== 'done') next.completed_at = now
  if (patch.status === 'todo' && before.status === 'done') next.completed_at = null
  const keys = Object.keys(next)
  if (!keys.length) return before
  db().prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => next[k] as never), now, id)
  const after = getTask(id)!
  const op =
    patch.status === 'done' && before.status !== 'done' ? 'complete'
    : patch.status === 'todo' && before.status === 'done' ? 'reopen'
    : patch.status === 'dropped' ? 'drop'
    : patch.is_archived === 1 ? 'archive'
    : (patch.step !== undefined || patch.lane !== undefined || patch.position !== undefined) ? 'move'
    : patch.block_event_id !== undefined ? (patch.block_event_id === '' ? 'unassign' : 'assign')
    : 'update'
  logTaskEvent(id, op, before, after, opts.actor ?? 'user', opts.group_id ?? '')
  return after
}

// Recent task activity (the "Recent changes" strip + undo surface). nodeId filters via the
// task's owning node; personal ('') included when nodeId is undefined.
export function listTaskEvents(nodeId: string | undefined, limit = 20): (TaskEventRow & { title: string })[] {
  ensureTasksSchema()
  const rows = nodeId === undefined
    ? db().prepare(`SELECT e.*, COALESCE(t.title, '') AS title FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id ORDER BY e.created_at DESC LIMIT ?`).all(limit)
    : db().prepare(`SELECT e.*, COALESCE(t.title, '') AS title FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id WHERE t.node_id = ? ORDER BY e.created_at DESC LIMIT ?`).all(nodeId, limit)
  return rows as (TaskEventRow & { title: string })[]
}

// Undo — restore the before-state of one event, or of every event in a group, in ONE
// transaction. Sparse steps make single-row before/after complete for adds/moves; group_id
// covers the genuinely multi-row ops (merge, proposal apply, assignment sweeps).
export function undoTaskEvents(opts: { event_id?: string; group_id?: string }): { undone: number } {
  ensureTasksSchema()
  const events = opts.group_id
    ? db().prepare(`SELECT * FROM task_events WHERE group_id = ? ORDER BY created_at DESC`).all(opts.group_id) as TaskEventRow[]
    : opts.event_id
      ? db().prepare(`SELECT * FROM task_events WHERE id = ?`).all(opts.event_id) as TaskEventRow[]
      : []
  if (!events.length) return { undone: 0 }
  const undoGroup = randomUUID()
  const tx = db().transaction(() => {
    for (const ev of events) {
      const current = getTask(ev.task_id)
      if (!current) continue
      if (ev.op === 'create') {
        // Undo a create = the task vanishes (soft: archived + dropped, never hard-deleted).
        updateTask(ev.task_id, { is_archived: 1, status: 'dropped' }, { actor: ev.actor, group_id: undoGroup })
        continue
      }
      if (!ev.before_json) continue
      const before = JSON.parse(ev.before_json) as TaskRow
      db().prepare(
        `UPDATE tasks SET title = ?, notes = ?, status = ?, is_archived = ?, step = ?, lane = ?, phase_id = ?, due_at = ?, block_event_id = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(before.title, before.notes, before.status, before.is_archived, before.step, before.lane, before.phase_id,
        before.due_at, before.block_event_id, before.position, Date.now(), before.completed_at, ev.task_id)
      logTaskEvent(ev.task_id, 'update', current, getTask(ev.task_id)!, ev.actor, undoGroup)
    }
  })
  tx()
  return { undone: events.length }
}

// ── Step placement (sparse fractional) — the ONLY place map coordinates are computed ──
// relation: after/before/parallel need an anchor task; start/end don't. Returns {step, lane}.
// An insert NEVER renumbers other rows: between-steps placements take the midpoint.
export function resolveStepPlacement(
  nodeId: string,
  relation: 'after' | 'before' | 'parallel' | 'start' | 'end',
  anchorTaskId?: string,
): { step: number; lane: number } {
  ensureTasksSchema()
  const mapTasks = (db().prepare(
    `SELECT * FROM tasks WHERE node_id = ? AND is_archived = 0 AND status != 'dropped' AND step IS NOT NULL ORDER BY step ASC`,
  ).all(nodeId) as TaskRow[])
  const steps = [...new Set(mapTasks.map(t => t.step as number))].sort((a, b) => a - b)
  if (!steps.length) return { step: 1, lane: 0 }
  const anchor = anchorTaskId ? mapTasks.find(t => t.id === anchorTaskId) : undefined
  const laneAfter = (step: number) => mapTasks.filter(t => t.step === step).reduce((m, t) => Math.max(m, t.lane), -1) + 1
  switch (relation) {
    case 'start': return { step: steps[0] - 1, lane: 0 }
    case 'end': return { step: steps[steps.length - 1] + 1, lane: 0 }
    case 'parallel': {
      if (!anchor) return { step: steps[steps.length - 1] + 1, lane: 0 }
      return { step: anchor.step as number, lane: laneAfter(anchor.step as number) }
    }
    case 'after': {
      if (!anchor) return { step: steps[steps.length - 1] + 1, lane: 0 }
      const a = anchor.step as number
      const next = steps.find(s => s > a)
      return { step: next === undefined ? a + 1 : (a + next) / 2, lane: 0 }
    }
    case 'before': {
      if (!anchor) return { step: steps[0] - 1, lane: 0 }
      const a = anchor.step as number
      const prev = [...steps].reverse().find(s => s < a)
      return { step: prev === undefined ? a - 1 : (prev + a) / 2, lane: 0 }
    }
  }
}

// ── Phases ─────────────────────────────────────────────────────────────────────────
export function listPhases(nodeId: string): PhaseRow[] {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM phases WHERE node_id = ? ORDER BY position ASC, created_at ASC`).all(nodeId) as PhaseRow[]
}

export function createPhase(opts: { node_id: string; name: string; color?: string }): PhaseRow {
  ensureTasksSchema()
  const id = randomUUID()
  const pos = (db().prepare(`SELECT COUNT(*) AS c FROM phases WHERE node_id = ?`).get(opts.node_id) as { c: number }).c
  db().prepare(`INSERT INTO phases (id, node_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, opts.node_id, opts.name.trim() || 'Phase', opts.color ?? '', pos, Date.now())
  return db().prepare(`SELECT * FROM phases WHERE id = ?`).get(id) as PhaseRow
}

export function updatePhase(id: string, patch: { name?: string; color?: string; position?: number }): PhaseRow | undefined {
  ensureTasksSchema()
  const p = db().prepare(`SELECT * FROM phases WHERE id = ?`).get(id) as PhaseRow | undefined
  if (!p) return undefined
  db().prepare(`UPDATE phases SET name = ?, color = ?, position = ? WHERE id = ?`)
    .run(patch.name ?? p.name, patch.color ?? p.color, patch.position ?? p.position, id)
  return db().prepare(`SELECT * FROM phases WHERE id = ?`).get(id) as PhaseRow
}

// Deleting a phase unlabels its tasks — it NEVER deletes tasks.
export function deletePhase(id: string): void {
  ensureTasksSchema()
  db().prepare(`UPDATE tasks SET phase_id = '' WHERE phase_id = ?`).run(id)
  db().prepare(`DELETE FROM phases WHERE id = ?`).run(id)
}

// ── Blocks (calendar event ↔ project links) ───────────────────────────────────────
export function upsertBlock(opts: {
  event_id: string; node_id: string; matched?: string
  recurring_event_id?: string; title?: string; start_at?: number; end_at?: number
}): BlockRow {
  ensureTasksSchema()
  db().prepare(
    `INSERT INTO blocks (event_id, node_id, matched, recurring_event_id, title, start_at, end_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       node_id = excluded.node_id, matched = excluded.matched,
       recurring_event_id = CASE WHEN excluded.recurring_event_id != '' THEN excluded.recurring_event_id ELSE blocks.recurring_event_id END,
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE blocks.title END,
       start_at = CASE WHEN excluded.start_at != 0 THEN excluded.start_at ELSE blocks.start_at END,
       end_at = CASE WHEN excluded.end_at != 0 THEN excluded.end_at ELSE blocks.end_at END`,
  ).run(opts.event_id, opts.node_id, opts.matched ?? 'manual', opts.recurring_event_id ?? '', opts.title ?? '', opts.start_at ?? 0, opts.end_at ?? 0, Date.now())
  return db().prepare(`SELECT * FROM blocks WHERE event_id = ?`).get(opts.event_id) as BlockRow
}

export function getBlock(eventId: string): BlockRow | undefined {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM blocks WHERE event_id = ?`).get(eventId) as BlockRow | undefined
}

// Links overlapping a time window (the day view / NOW list feed). Tombstones excluded.
export function listBlocks(startMs: number, endMs: number): BlockRow[] {
  ensureTasksSchema()
  return db().prepare(
    `SELECT * FROM blocks WHERE matched != 'unlinked' AND start_at < ? AND end_at > ? ORDER BY start_at ASC`,
  ).all(endMs, startMs) as BlockRow[]
}

// Manual links on recurring events match ANY instance of the series.
export function findSeriesLink(recurringEventId: string): BlockRow | undefined {
  ensureTasksSchema()
  if (!recurringEventId) return undefined
  return db().prepare(
    `SELECT * FROM blocks WHERE recurring_event_id = ? AND matched = 'manual' ORDER BY created_at DESC LIMIT 1`,
  ).get(recurringEventId) as BlockRow | undefined
}

export function isTombstoned(eventId: string, recurringEventId?: string): boolean {
  ensureTasksSchema()
  const byId = db().prepare(`SELECT 1 FROM blocks WHERE event_id = ? AND matched = 'unlinked'`).get(eventId)
  if (byId) return true
  if (recurringEventId) {
    const bySeries = db().prepare(`SELECT 1 FROM blocks WHERE recurring_event_id = ? AND matched = 'unlinked' LIMIT 1`).get(recurringEventId)
    if (bySeries) return true
  }
  return false
}

// Unlink = TOMBSTONE, never DELETE — the auto-matcher re-runs every fetch and would
// otherwise resurrect a removed link within 15 minutes. Assigned tasks are released (logged).
export function tombstoneBlock(eventId: string): void {
  ensureTasksSchema()
  db().prepare(`UPDATE blocks SET matched = 'unlinked' WHERE event_id = ?`).run(eventId)
  releaseBlockAssignments(eventId)
}

function releaseBlockAssignments(eventId: string): void {
  const assigned = db().prepare(`SELECT id FROM tasks WHERE block_event_id = ?`).all(eventId) as { id: string }[]
  if (!assigned.length) return
  const group = randomUUID()
  for (const t of assigned) updateTask(t.id, { block_event_id: '' }, { actor: 'user', group_id: group })
}

// Range-scoped, past-safe reconcile: only rows whose stored time falls INSIDE the fetched
// window, is in the FUTURE (ended ≠ deleted — carried-over/recovery need past blocks), and
// whose id is missing from the fetch are treated as deleted-from-gcal. Old auto instance
// rows prune on the same pass (recurring-series growth guard).
export function sweepBlocks(windowStartMs: number, windowEndMs: number, presentEventIds: Set<string>): { swept: number } {
  ensureTasksSchema()
  const now = Date.now()
  // CRITICAL GUARD: an EMPTY present set means the fetch returned no events — which is
  // indistinguishable from "deleted from gcal" and would delete every future link + strip its
  // task assignments (a genuinely empty upcoming week, or a transient/partial Google response,
  // reaches here without throwing). Never infer deletion from nothing. The caller also gates on
  // events.length > 0; this is defence-in-depth. Old-instance pruning below is still safe.
  if (presentEventIds.size > 0) {
    const candidates = db().prepare(
      `SELECT * FROM blocks WHERE matched != 'unlinked' AND start_at >= ? AND start_at >= ? AND end_at <= ?`,
    ).all(now, windowStartMs, windowEndMs) as BlockRow[]
    let swept = 0
    for (const b of candidates) {
      if (presentEventIds.has(b.event_id)) continue
      releaseBlockAssignments(b.event_id)
      db().prepare(`DELETE FROM blocks WHERE event_id = ?`).run(b.event_id)
      swept++
    }
    const cutoff = now - 30 * 24 * 3600 * 1000
    db().prepare(`DELETE FROM blocks WHERE matched = 'auto' AND end_at > 0 AND end_at < ?`).run(cutoff)
    return { swept }
  }
  return { swept: 0 }
}

// ── Secretary proposals (structural review queue — Librarian contract) ─────────────
export function getSecretaryProposal(nodeId: string): SecretaryProposalRow | undefined {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM secretary_proposals WHERE node_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`).get(nodeId) as SecretaryProposalRow | undefined
}

export function getSecretaryProposalById(id: string): SecretaryProposalRow | undefined {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM secretary_proposals WHERE id = ?`).get(id) as SecretaryProposalRow | undefined
}

export function listSecretaryProposals(status = 'proposed'): SecretaryProposalRow[] {
  ensureTasksSchema()
  return db().prepare(`SELECT * FROM secretary_proposals WHERE status = ? ORDER BY created_at DESC`).all(status) as SecretaryProposalRow[]
}

export function createSecretaryProposal(opts: { node_id: string; actions_json: string; summary: string }): SecretaryProposalRow {
  ensureTasksSchema()
  const now = Date.now()
  db().prepare(`UPDATE secretary_proposals SET status = 'dismissed', resolved_at = ? WHERE node_id = ? AND status = 'proposed'`).run(now, opts.node_id)
  const id = randomUUID()
  db().prepare(`INSERT INTO secretary_proposals (id, node_id, actions_json, summary, status, created_at, resolved_at) VALUES (?, ?, ?, ?, 'proposed', ?, NULL)`)
    .run(id, opts.node_id, opts.actions_json, opts.summary, now)
  // One bell (weave item 7): proposals surface in the Inbox too.
  addInboxEvent({ kind: 'secretary', title: 'Secretary proposal', body: opts.summary || 'Structural changes awaiting review.' })
  return getSecretaryProposalById(id)!
}

export function updateSecretaryProposal(id: string, patch: { actions_json?: string; status?: string; summary?: string }): SecretaryProposalRow | undefined {
  ensureTasksSchema()
  const p = getSecretaryProposalById(id)
  if (!p) return undefined
  const resolved = patch.status && patch.status !== 'proposed' ? Date.now() : p.resolved_at
  db().prepare(`UPDATE secretary_proposals SET actions_json = ?, status = ?, summary = ?, resolved_at = ? WHERE id = ?`)
    .run(patch.actions_json ?? p.actions_json, patch.status ?? p.status, patch.summary ?? p.summary, resolved, id)
  return getSecretaryProposalById(id)
}

// ── Diagram nodes (Arms / Hands) ─────────────────────────────────────────────
export function listNodes(includeArchived = false): NodeRow[] {
  return db()
    .prepare(`SELECT * FROM diagram_nodes ${includeArchived ? '' : 'WHERE is_archived = 0'} ORDER BY level DESC, position ASC, created_at ASC`)
    .all() as NodeRow[]
}

export function getNode(id: string): NodeRow | undefined {
  return db().prepare(`SELECT * FROM diagram_nodes WHERE id = ?`).get(id) as NodeRow | undefined
}

export function createNode(opts: {
  name: string; level: NodeLevel; parent_id?: string | null
  template?: NodeTemplate; icon?: string; primer?: string; position?: number
  progress?: number; phase?: string; description?: string
}): NodeRow {
  const id = randomUUID()
  const parent_id = opts.parent_id ?? null
  // Default position to the count of existing siblings (append to the end).
  const sib = db()
    .prepare(`SELECT COUNT(*) AS n FROM diagram_nodes WHERE level = ? AND IFNULL(parent_id,'') = IFNULL(?, '') AND is_archived = 0`)
    .get(opts.level, parent_id) as { n: number }
  const position = opts.position ?? sib.n
  db()
    .prepare(
      `INSERT INTO diagram_nodes (id, name, level, parent_id, template, position, primer, icon, created_at, is_archived, progress, phase, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, opts.name.trim() || 'Untitled', opts.level, parent_id, opts.template ?? 'custom', position, opts.primer ?? '', opts.icon ?? 'ti-folder', Date.now(), opts.progress ?? 0, opts.phase ?? '', opts.description ?? '')
  bustTreeCache()
  return getNode(id)!
}

export function updateNode(id: string, patch: {
  name?: string; position?: number; primer?: string; icon?: string; is_archived?: boolean
  progress?: number; phase?: string; description?: string
}): NodeRow | undefined {
  const n = getNode(id)
  if (!n) return undefined
  db()
    .prepare(`UPDATE diagram_nodes SET name = ?, position = ?, primer = ?, icon = ?, is_archived = ?, progress = ?, phase = ?, description = ? WHERE id = ?`)
    .run(
      patch.name !== undefined ? patch.name : n.name,
      patch.position !== undefined ? patch.position : n.position,
      patch.primer !== undefined ? patch.primer : n.primer,
      patch.icon !== undefined ? patch.icon : n.icon,
      patch.is_archived !== undefined ? (patch.is_archived ? 1 : 0) : n.is_archived,
      patch.progress !== undefined ? Math.min(100, Math.max(0, Math.round(patch.progress))) : n.progress,
      patch.phase !== undefined ? patch.phase : n.phase,
      patch.description !== undefined ? patch.description : n.description,
      id,
    )
  bustTreeCache()
  return getNode(id)
}

// Soft-delete a node and cascade-archive everything that hangs off it: its chat
// sessions (folder_id = the node's id, which IS its session scope) and its notebooks
// (node_id). Originals are never hard-deleted.
export function archiveNode(id: string): NodeRow | undefined {
  const node = updateNode(id, { is_archived: true })
  if (node) {
    db().prepare(`UPDATE sessions SET is_archived = 1 WHERE folder_id = ?`).run(id)
    db().prepare(`UPDATE notebooks SET is_archived = 1 WHERE node_id = ?`).run(id)
  }
  bustTreeCache()
  return node
}

// ── Source files (Project Hand SOURCES section) ──────────────────────────────────
// Right-panel Sources list — chat attachments (source='chat') are excluded so they
// never appear in the SOURCES panel or the [PROJECT SOURCES] primer index.
export function listFiles(nodeId: string): FileRow[] {
  return db()
    .prepare(`SELECT * FROM files WHERE node_id = ? AND is_archived = 0 AND source = 'sources' ORDER BY created_at DESC`)
    .all(nodeId) as FileRow[]
}

export function getFile(id: string): FileRow | undefined {
  return db().prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined
}

export function addFile(opts: {
  node_id: string; filename: string; stored_path: string; file_type: string; size_bytes?: number; source?: string
}): FileRow {
  const id = randomUUID()
  db()
    .prepare(
      `INSERT INTO files (id, node_id, filename, stored_path, file_type, size_bytes, created_at, is_archived, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, opts.node_id, opts.filename, opts.stored_path, opts.file_type, opts.size_bytes ?? 0, Date.now(), opts.source ?? 'sources')
  bustTreeCache()
  return getFile(id)!
}

export function archiveFile(id: string): FileRow | undefined {
  const f = getFile(id)
  if (!f) return undefined
  db().prepare(`UPDATE files SET is_archived = 1 WHERE id = ?`).run(id)
  bustTreeCache()
  return getFile(id)
}

// ── Notebooks (Docu-scape — Project Hand document library) ───────────────────────
// Two-level model: folders live at top level (parent_id ''); notebooks live at top
// level or inside one folder. Folders never nest. Listing returns folders first, then
// notebooks, each ordered by position then created_at.
export function listNotebooks(nodeId: string, parentId = ''): NotebookRow[] {
  return db()
    .prepare(
      `SELECT * FROM notebooks
       WHERE node_id = ? AND parent_id = ? AND is_archived = 0
       ORDER BY (type = 'folder') DESC, position ASC, created_at ASC`,
    )
    .all(nodeId, parentId) as NotebookRow[]
}

// The whole non-archived tree for a node (folders + notebooks, all levels) — the client
// fetches this once per Hand and derives the grid/folder views + the primer index from it.
export function listAllNotebooks(nodeId: string): NotebookRow[] {
  return db()
    .prepare(
      `SELECT * FROM notebooks WHERE node_id = ? AND is_archived = 0
       ORDER BY (type = 'folder') DESC, position ASC, created_at ASC`,
    )
    .all(nodeId) as NotebookRow[]
}

export function getNotebook(id: string): NotebookRow | undefined {
  return db().prepare(`SELECT * FROM notebooks WHERE id = ?`).get(id) as NotebookRow | undefined
}

// Count non-archived notebooks directly inside a folder (for the library card subtitle).
export function notebookChildCount(folderId: string): number {
  return (db()
    .prepare(`SELECT COUNT(*) AS n FROM notebooks WHERE parent_id = ? AND is_archived = 0`)
    .get(folderId) as { n: number }).n
}

// ── Spatial model (full live Diagram tree) ───────────────────────────────────────
// A lean, DB-driven name-only skeleton of the WHOLE tree — every Arm and every Hand by
// id + name (NO per-document / per-file lines). Injected into Spectre's primer on every
// turn so it always knows where everything is and can drive navigation. The current
// project's file/document ids reach Spectre separately via the [PROJECT SOURCES] /
// [NOTEBOOKS IN THIS PROJECT] blocks when it's inside that project — so the tree stays tiny
// (listing every project's every document here was both bloat and redundant with those).
// Returns the rendered string plus an item index (notebook id / file id → owning node id)
// the client uses for implicit-navigate before opening an item.
//
// Caching: the result is cached here (not in the route) with a TTL safety net, and the
// cache is invalidated by `bustTreeCache()` on EVERY write to diagram_nodes / notebooks /
// files — so a freshly created/renamed/deleted item shows up in the next `getDiagramTree()`
// immediately, not after the TTL. `/api/tree` calls `getDiagramTree()`.
type DiagramTree = { tree: string; index: { notebooks: Record<string, string>; files: Record<string, string> } }
let _treeCache: { ts: number; data: DiagramTree } | null = null
const TREE_TTL_MS = 30_000

export function bustTreeCache(): void {
  _treeCache = null
}

export function getDiagramTree(): DiagramTree {
  if (!_treeCache || Date.now() - _treeCache.ts > TREE_TTL_MS) {
    _treeCache = { ts: Date.now(), data: buildDiagramTree() }
  }
  return _treeCache.data
}

export function buildDiagramTree(): DiagramTree {
  const nodes = listNodes()
  const arms = nodes.filter(n => n.level === 'arm').sort((a, b) => a.position - b.position)
  const hands = nodes.filter(n => n.level === 'hand')
  const index = { notebooks: {} as Record<string, string>, files: {} as Record<string, string> }

  // Populate the item index (id → owning node) for EVERY project Hand's Sources +
  // Notebooks so the client's implicit-navigate can still resolve any item to its owner.
  // This index is what the client consumes; the injected STRING below stays a name-only
  // skeleton (no per-document lines), so it costs a fraction of the tokens.
  for (const hand of hands) {
    if (hand.parent_id !== 'projects') continue
    listFiles(hand.id).forEach(f => { index.files[f.id] = hand.id })
    listAllNotebooks(hand.id).forEach(n => { index.notebooks[n.id] = hand.id })
  }

  const lines: string[] = []
  lines.push(`[DIAGRAM TREE] — the map of ${USER_POSS} workspace. To go to or act on any location, emit navigateTo with its node_id.`)
  lines.push('ARMS:')
  for (const arm of arms) lines.push(`  ${arm.id} — ${arm.name}`)

  // Hands grouped under their parent Arm (Projects is the common case).
  const armsWithHands = arms.filter(a => hands.some(h => h.parent_id === a.id))
  for (const arm of armsWithHands) {
    const kids = hands.filter(h => h.parent_id === arm.id).sort((a, b) => a.position - b.position)
    if (!kids.length) continue
    lines.push(`HANDS in ${arm.name}:`)
    for (const hand of kids) lines.push(`  ${hand.id} — ${hand.name}`)
  }

  return { tree: lines.join('\n'), index }
}

export function createNotebook(opts: {
  node_id: string; title: string; type: 'folder' | 'notebook'
  parent_id?: string; content?: string; icon?: string; color?: string; created_by?: string
}): NotebookRow {
  const id = randomUUID()
  const now = Date.now()
  // Drive model: folders and documents can both be created at top level or inside any folder
  // (infinite nesting). The caller supplies the parent folder id (or '' for top level).
  const parent_id = opts.parent_id ?? ''
  // Append after existing siblings at this level.
  const sib = db()
    .prepare(`SELECT COUNT(*) AS n FROM notebooks WHERE node_id = ? AND parent_id = ? AND is_archived = 0`)
    .get(opts.node_id, parent_id) as { n: number }
  db()
    .prepare(
      `INSERT INTO notebooks (id, node_id, parent_id, type, title, content, position, created_at, updated_at, is_archived, created_by, icon, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, opts.node_id, parent_id, opts.type, opts.title.trim() || 'Untitled',
      opts.type === 'folder' ? '' : (opts.content ?? ''), sib.n, now, now,
      opts.created_by ?? 'user', opts.icon ?? '', opts.color ?? '')
  bustTreeCache()
  return getNotebook(id)!
}

// Thrown by updateNotebook when an optimistic-concurrency guard (expectedUpdatedAt) is
// supplied and the row changed under us — lets the caller re-read + merge instead of
// silently clobbering a concurrent write (e.g. a Spectre write racing the editor autosave).
export class NotebookConflictError extends Error {
  readonly notebook: NotebookRow
  constructor(notebook: NotebookRow) {
    super('notebook was updated concurrently')
    this.name = 'NotebookConflictError'
    this.notebook = notebook
  }
}

export function updateNotebook(id: string, patch: {
  title?: string; content?: string; icon?: string; color?: string; parent_id?: string; position?: number
  // Optional optimistic-concurrency guard. When set, the write only lands if the row's
  // updated_at still equals this value; a mismatch throws NotebookConflictError. Omit it
  // for the legacy blind last-write-wins behavior (title/move/icon/position callers).
  expectedUpdatedAt?: number
}): NotebookRow | undefined {
  const n = getNotebook(id)
  if (!n) return undefined
  // Folders and documents can both be moved into any folder. Guard a folder against being
  // moved into itself or one of its own descendants (which would orphan the subtree).
  let parent_id = patch.parent_id !== undefined ? patch.parent_id : n.parent_id
  if (patch.parent_id !== undefined && patch.parent_id !== '' && n.type === 'folder') {
    let cur: string = patch.parent_id
    while (cur) {
      if (cur === id) { parent_id = n.parent_id; break }   // cycle — keep the current parent
      cur = getNotebook(cur)?.parent_id || ''
    }
  }
  const guard = patch.expectedUpdatedAt !== undefined
  const res = db()
    .prepare(`UPDATE notebooks SET title = ?, content = ?, icon = ?, color = ?, parent_id = ?, position = ?, updated_at = ? WHERE id = ?${guard ? ' AND updated_at = ?' : ''}`)
    .run(
      patch.title !== undefined ? (patch.title.trim() || 'Untitled') : n.title,
      patch.content !== undefined ? patch.content : n.content,
      patch.icon !== undefined ? patch.icon : n.icon,
      patch.color !== undefined ? patch.color : n.color,
      parent_id,
      patch.position !== undefined ? patch.position : n.position,
      Date.now(),
      id,
      ...(guard ? [patch.expectedUpdatedAt as number] : []),
    )
  // A guarded write that matched no row = the row's updated_at moved under us (it still
  // exists — checked above) → a concurrent write. Surface it so the caller can reconcile.
  if (guard && res.changes === 0) throw new NotebookConflictError(getNotebook(id) ?? n)
  // Only structural changes alter the tree Spectre reads (title/move/order). Content
  // autosaves write here constantly but don't change the tree — skip the bust for those.
  if (patch.title !== undefined || patch.parent_id !== undefined || patch.position !== undefined) bustTreeCache()
  return getNotebook(id)
}

// Soft-delete. Archiving a folder recursively archives every folder + document nested inside it.
export function archiveNotebook(id: string): NotebookRow | undefined {
  const n = getNotebook(id)
  if (!n) return undefined
  const tx = db().transaction((rootId: string) => {
    const archiveRec = (pid: string) => {
      db().prepare(`UPDATE notebooks SET is_archived = 1 WHERE id = ?`).run(pid)
      const kids = db().prepare(`SELECT id FROM notebooks WHERE parent_id = ? AND is_archived = 0`).all(pid) as { id: string }[]
      for (const k of kids) archiveRec(k.id)
    }
    archiveRec(rootId)
  })
  tx(n.id)
  bustTreeCache()
  return getNotebook(id)
}

// Every descendant Document id of a folder (recursively through nested folders) — used to also
// drop THEIR vault vectors when a folder is deleted (archiveNotebook cascade-archives them).
export function notebookChildIds(folderId: string): string[] {
  const out: string[] = []
  const walk = (pid: string) => {
    const kids = db().prepare(`SELECT id, type FROM notebooks WHERE parent_id = ?`).all(pid) as { id: string; type: string }[]
    for (const k of kids) { if (k.type === 'notebook') out.push(k.id); else walk(k.id) }
  }
  walk(folderId)
  return out
}

// Structured tree (folders with their notebooks + loose top-level notebooks) for the
// lightweight [NOTEBOOKS IN THIS PROJECT] primer index. Titles + ids only, no content.
export type NotebookTreeFolder = { id: string; title: string; icon: string; children: { id: string; title: string }[] }
export type NotebookTree = { folders: NotebookTreeFolder[]; loose: { id: string; title: string; icon: string }[] }
export function notebookTree(nodeId: string): NotebookTree {
  const all = db()
    .prepare(`SELECT id, parent_id, type, title, icon, position, created_at FROM notebooks WHERE node_id = ? AND is_archived = 0 ORDER BY position ASC, created_at ASC`)
    .all(nodeId) as Pick<NotebookRow, 'id' | 'parent_id' | 'type' | 'title' | 'icon'>[]
  const folders: NotebookTreeFolder[] = all.filter(n => n.type === 'folder')
    .map(f => ({ id: f.id, title: f.title, icon: f.icon, children: all.filter(c => c.type === 'notebook' && c.parent_id === f.id).map(c => ({ id: c.id, title: c.title })) }))
  const loose = all.filter(n => n.type === 'notebook' && !n.parent_id).map(n => ({ id: n.id, title: n.title, icon: n.icon }))
  return { folders, loose }
}

// ── Tags / sections (intra-project chat organization) ────────────────────────────
export function listTags(nodeId: string): TagRow[] {
  return db()
    .prepare(`SELECT * FROM tags WHERE node_id = ? ORDER BY created_at ASC`)
    .all(nodeId) as TagRow[]
}

export function getTag(id: string): TagRow | undefined {
  return db().prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as TagRow | undefined
}

// Create a tag, auto-assigning the next palette color (cycled by the node's tag count).
export function createTag(nodeId: string, name: string): TagRow {
  const id = randomUUID()
  const count = (db().prepare(`SELECT COUNT(*) AS n FROM tags WHERE node_id = ?`).get(nodeId) as { n: number }).n
  const color = TAG_PALETTE[count % TAG_PALETTE.length]
  db()
    .prepare(`INSERT INTO tags (id, node_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, nodeId, name.trim() || 'Untitled', color, Date.now())
  return getTag(id)!
}

// Delete a tag; sessions carrying it become untagged (tag_id = NULL).
export function deleteTag(id: string): void {
  const tx = db().transaction((tagId: string) => {
    db().prepare(`UPDATE sessions SET tag_id = NULL WHERE tag_id = ?`).run(tagId)
    db().prepare(`DELETE FROM tags WHERE id = ?`).run(tagId)
  })
  tx(id)
}

// ── Project activity summaries (Projects landing cards) ──────────────────────────
// The N most recent assistant turns across ALL sessions of a node — the raw material
// for a freshly generated, 1-2 sentence activity summary. Returned oldest-first.
export function recentAssistantMessages(nodeId: string, limit = 5): string[] {
  const rows = db()
    .prepare(
      `SELECT m.content FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.folder_id = ? AND s.is_archived = 0
         AND m.role = 'assistant' AND m.in_context = 1 AND m.is_compressed = 0
         AND m.deleted_at IS NULL
       ORDER BY m.timestamp DESC, m.rowid DESC
       LIMIT ?`,
    )
    .all(nodeId, limit) as { content: string }[]
  return rows.map(r => r.content).reverse()
}

export function setNodeSummary(nodeId: string, summary: string): void {
  db().prepare(`UPDATE diagram_nodes SET summary = ?, summary_updated_at = ? WHERE id = ?`)
    .run(summary, Date.now(), nodeId)
}

function latestSessionActivity(nodeId: string): number | null {
  const row = db()
    .prepare(`SELECT MAX(updated_at) AS latest FROM sessions WHERE folder_id = ? AND is_archived = 0`)
    .get(nodeId) as { latest: number | null }
  return row?.latest ?? null
}

const NO_ACTIVITY_SUMMARY = 'No activity yet. Start a conversation to begin.'

// Regenerate the activity summary for every Project Hand, in parallel, and persist each.
// Skips the Haiku call when summary_updated_at >= MAX(sessions.updated_at) — no new activity.
export async function refreshProjectSummaries(): Promise<Record<string, string>> {
  const hands = db()
    .prepare(`SELECT id, summary, summary_updated_at FROM diagram_nodes WHERE parent_id = 'projects' AND level = 'hand' AND is_archived = 0`)
    .all() as { id: string; summary: string; summary_updated_at: number | null }[]

  const entries = await Promise.all(hands.map(async (hand) => {
    const latestActivity = latestSessionActivity(hand.id)

    // No sessions at all — static placeholder, no Haiku call.
    if (latestActivity === null) {
      if (hand.summary !== NO_ACTIVITY_SUMMARY) setNodeSummary(hand.id, NO_ACTIVITY_SUMMARY)
      return [hand.id, NO_ACTIVITY_SUMMARY] as const
    }

    // Summary is fresh — no new activity since last generation.
    if (hand.summary_updated_at !== null && hand.summary_updated_at >= latestActivity && hand.summary) {
      return [hand.id, hand.summary] as const
    }

    const msgs = recentAssistantMessages(hand.id, 5)
    if (msgs.length === 0) {
      setNodeSummary(hand.id, NO_ACTIVITY_SUMMARY)
      return [hand.id, NO_ACTIVITY_SUMMARY] as const
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await anthropic.messages.create({
        model: COMPRESS_MODEL,
        max_tokens: 160,
        system: 'You summarize project activity in 1-2 sentences. Be specific and factual. Reply in plain text only. No markdown, no asterisks, no bold, no bullet points. Just clean prose sentences.',
        messages: [{ role: 'user', content: `Summarize what is happening in this project based on these recent messages:\n\n${msgs.join('\n')}` }],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim()
      const summary = text || hand.summary || NO_ACTIVITY_SUMMARY
      setNodeSummary(hand.id, summary)
      return [hand.id, summary] as const
    } catch {
      // Keep the last-known summary on failure.
      return [hand.id, hand.summary || NO_ACTIVITY_SUMMARY] as const
    }
  }))

  return Object.fromEntries(entries)
}

// ── Conversation search (scoped to one node, LIKE-based) ─────────────────────────
export type SearchResult = SessionRow & { match_excerpt: string; match_field: 'title' | 'message' }
// When tagId is provided, search is restricted to that section's sessions (the active
// tag filter in a project Hand). undefined/null = search all of the node's sessions.
export function searchSessions(folderId: string, query: string, tagId?: string | null): SearchResult[] {
  const q = (query ?? '').trim()
  if (!q) return []
  const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`
  const tagFilter = tagId ? 'AND s.tag_id = ?' : ''
  const sessions = db()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.is_compressed = 1) AS summary_count
       FROM sessions s
       WHERE s.folder_id = ? AND s.is_archived = 0 ${tagFilter}
       ORDER BY s.updated_at DESC`,
    )
    .all(...(tagId ? [folderId, tagId] : [folderId])) as SessionRow[]
  const results: SearchResult[] = []
  const msgStmt = db().prepare(
    `SELECT content FROM messages
     WHERE session_id = ? AND deleted_at IS NULL AND is_compressed = 0 AND content LIKE ? ESCAPE '\\'
     ORDER BY timestamp ASC LIMIT 1`,
  )
  for (const s of sessions) {
    if (s.title.toLowerCase().includes(q.toLowerCase())) {
      results.push({ ...s, match_excerpt: s.last_message_preview, match_field: 'title' })
      continue
    }
    const hit = msgStmt.get(s.id, like) as { content: string } | undefined
    if (hit) {
      const idx = hit.content.toLowerCase().indexOf(q.toLowerCase())
      const start = Math.max(0, idx - 40)
      const excerpt = (start > 0 ? '…' : '') + hit.content.slice(start, idx + q.length + 60).replace(/\s+/g, ' ').trim()
      results.push({ ...s, match_excerpt: excerpt, match_field: 'message' })
    }
  }
  return results
}

// ── Global chat recall (Spectre's search over ALL past conversations) ────────────
// Powers the search_chats tool: cross-Diagram search over every session's title +
// verbatim messages, so Spectre can pull details from prior conversations into a new
// one. Privacy follows the Scribe precedent — secretary-* and spiral-* scopes never
// surface. Personal-scale DB, so per-term LIKE passes scored in JS beat an FTS index.
export type ChatRecallHit = {
  session_id: string
  title: string
  folder_id: string
  place: string            // human name of the Arm/Hand the conversation lives under
  created_at: number
  updated_at: number
  message_count: number
  match_field: 'title' | 'message' | 'recent'
  excerpts: string[]       // up to 3 matched snippets, role-prefixed
}

const RECALL_EXCLUDE = `s.folder_id NOT LIKE 'secretary-%' AND s.folder_id NOT LIKE 'spiral-%'`

export function recallPlaceName(folderId: string): string {
  if (folderId === 'main') return 'the main dashboard'
  return getNode(folderId)?.name ?? folderId
}

const likePat = (t: string) => `%${t.replace(/[%_]/g, m => '\\' + m)}%`

// A ~180-char window centered on the first occurrence of `term` (whitespace-flattened).
function recallSnippet(content: string, term: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const idx = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1
  if (idx < 0) return flat.slice(0, 180) + (flat.length > 180 ? '…' : '')
  const start = Math.max(0, idx - 80)
  const end = Math.min(flat.length, idx + term.length + 100)
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

export function searchChatsGlobal(
  query: string,
  opts: { folderId?: string | null; limit?: number; excludeSessionId?: string | null } = {},
): ChatRecallHit[] {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 6))
  const scopeFilter = opts.folderId ? 'AND s.folder_id = ?' : ''
  const scopeArgs: string[] = opts.folderId ? [opts.folderId] : []
  const countSub = `(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.is_compressed = 0 AND m.deleted_at IS NULL)`
  const toHit = (s: SessionRow & { message_count: number }, match_field: ChatRecallHit['match_field'], excerpts: string[]): ChatRecallHit => ({
    session_id: s.id, title: s.title, folder_id: s.folder_id, place: recallPlaceName(s.folder_id),
    created_at: s.created_at, updated_at: s.updated_at, message_count: s.message_count, match_field, excerpts,
  })

  const q = (query ?? '').trim()

  // No query → the most recent conversations (recency listing: "the last chat we had").
  if (!q) {
    const rows = db().prepare(
      `SELECT s.*, ${countSub} AS message_count
       FROM sessions s
       WHERE s.is_archived = 0 AND ${RECALL_EXCLUDE} ${scopeFilter}
       ORDER BY s.updated_at DESC LIMIT ?`,
    ).all(...scopeArgs, limit + 1) as (SessionRow & { message_count: number })[]
    return rows
      .filter(s => s.id !== opts.excludeSessionId)
      .slice(0, limit)
      .map(s => toHit(s, 'recent', s.last_message_preview ? [s.last_message_preview] : []))
  }

  // Multi-term scoring: a session matching MORE distinct query terms outranks one matching
  // fewer; an exact-phrase hit and a title hit boost; recency breaks ties. A model-authored
  // query ("gym push notification phone") rarely appears verbatim in one message — per-term
  // matching is what makes it land.
  const terms = Array.from(new Set(
    q.toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(t => t.length >= 2),
  )).slice(0, 6)
  if (!terms.length) return []

  const msgTermStmt = db().prepare(
    `SELECT m.session_id AS sid, COUNT(*) AS c
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.deleted_at IS NULL AND m.is_compressed = 0 AND m.content LIKE ? ESCAPE '\\'
       AND s.is_archived = 0 AND ${RECALL_EXCLUDE} ${scopeFilter}
     GROUP BY m.session_id`,
  )
  const cand = new Map<string, { termsMatched: number; hits: number; title: boolean; phrase: boolean }>()
  const bump = (sid: string, patch: Partial<{ termsMatched: number; hits: number; title: boolean; phrase: boolean }>) => {
    const cur = cand.get(sid) ?? { termsMatched: 0, hits: 0, title: false, phrase: false }
    cand.set(sid, {
      termsMatched: cur.termsMatched + (patch.termsMatched ?? 0),
      hits: cur.hits + (patch.hits ?? 0),
      title: cur.title || !!patch.title,
      phrase: cur.phrase || !!patch.phrase,
    })
  }
  for (const t of terms) {
    for (const row of msgTermStmt.all(likePat(t), ...scopeArgs) as { sid: string; c: number }[]) {
      bump(row.sid, { termsMatched: 1, hits: row.c })
    }
  }
  if (terms.length > 1) {
    for (const row of msgTermStmt.all(likePat(q), ...scopeArgs) as { sid: string }[]) bump(row.sid, { phrase: true })
  }
  const titleWhere = terms.map(() => `s.title LIKE ? ESCAPE '\\'`).join(' OR ')
  const titleRows = db().prepare(
    `SELECT s.id FROM sessions s
     WHERE s.is_archived = 0 AND ${RECALL_EXCLUDE} ${scopeFilter} AND (${titleWhere})`,
  ).all(...scopeArgs, ...terms.map(likePat)) as { id: string }[]
  for (const r of titleRows) bump(r.id, { title: true })

  const ids = Array.from(cand.keys()).filter(id => id !== opts.excludeSessionId)
  if (!ids.length) return []
  const sessions = db().prepare(
    `SELECT s.*, ${countSub} AS message_count
     FROM sessions s WHERE s.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as (SessionRow & { message_count: number })[]
  const ranked = sessions.sort((a, b) => {
    const ca = cand.get(a.id)!, cb = cand.get(b.id)!
    if (cb.termsMatched !== ca.termsMatched) return cb.termsMatched - ca.termsMatched
    if (cb.phrase !== ca.phrase) return Number(cb.phrase) - Number(ca.phrase)
    if (cb.title !== ca.title) return Number(cb.title) - Number(ca.title)
    return b.updated_at - a.updated_at
  }).slice(0, limit)

  // Excerpts: the most recent matching messages, re-scored in JS by distinct terms hit.
  const excerptStmt = db().prepare(
    `SELECT role, content FROM messages
     WHERE session_id = ? AND deleted_at IS NULL AND is_compressed = 0
       AND (${terms.map(() => `content LIKE ? ESCAPE '\\'`).join(' OR ')})
     ORDER BY timestamp DESC LIMIT 30`,
  )
  return ranked.map(s => {
    const rows = excerptStmt.all(s.id, ...terms.map(likePat)) as { role: string; content: string }[]
    const scored = rows.map(r => {
      const lc = r.content.toLowerCase()
      const matched = terms.filter(t => lc.includes(t))
      return { ...r, score: (lc.includes(q.toLowerCase()) ? 100 : 0) + matched.length, focus: lc.includes(q.toLowerCase()) ? q : (matched[0] ?? '') }
    }).sort((a, b) => b.score - a.score).slice(0, 3)
    const excerpts = scored.map(r => `${r.role === 'user' ? USER_LABEL : 'Spectre'}: ${recallSnippet(r.content, r.focus)}`)
    const c = cand.get(s.id)!
    return toHit(s, c.title && !c.hits ? 'title' : 'message', excerpts.length ? excerpts : (s.last_message_preview ? [s.last_message_preview] : []))
  })
}

// Append a verbatim turn. Bumps the session's updated_at + preview, and reports the
// running context size so the caller can decide whether to compress.
export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  opts: { is_bookmarked?: boolean } = {},
): { message: MessageRow; contextTokens: number; needsCompression: boolean } {
  const now = Date.now()
  const id = randomUUID()
  // A research-card row stores a large JSON blob, but the window builder only ever sends a tiny
  // collapsed line for it (researchContextLine). Account it by what's actually sent so a couple
  // of cards don't inflate contextTokens and trigger premature compression of real conversation.
  const tokens = content.startsWith('[RESEARCH_RESULT]') ? 30 : estimateTokens(content)
  db()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, token_count, is_compressed, compression_level, is_bookmarked, in_context)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 1)`,
    )
    .run(id, sessionId, role, content, now, tokens, opts.is_bookmarked ? 1 : 0)
  db()
    .prepare(`UPDATE sessions SET updated_at = ?, last_message_preview = ? WHERE id = ?`)
    .run(now, preview(content), sessionId)
  const message = db().prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow
  const ct = contextTokens(sessionId)
  return { message, contextTokens: ct, needsCompression: ct >= CONTEXT_LIMIT }
}

// ── Recursive compression ──────────────────────────────────────────────────────
const anthropic = new Anthropic()

async function summarize(transcript: string, level: 1 | 2): Promise<string> {
  const instruction =
    level === 1
      ? 'Summarize this conversation segment in 2-3 sentences. Preserve key decisions, conclusions, facts established, and open questions. Be dense — this summary replaces the original messages in context.'
      : 'These are summaries of earlier parts of a conversation. Merge them into a single dense sentence that preserves the key decisions, conclusions, facts, and open questions across all of them.'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await anthropic.messages.create({
    model: COMPRESS_MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: `${instruction}\n\n---\n\n${transcript}` }],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim()
  return text || '(summary unavailable)'
}

function transcriptOf(rows: MessageRow[]): string {
  return rows.map(r => `${r.role === 'user' ? USER_LABEL : 'Spectre'}: ${r.content}`).join('\n\n')
}

// Compress a session back under the token budget. Each pass folds the oldest 20
// verbatim, non-bookmarked messages into a level-1 summary; when no verbatim remain
// but we're still over budget, all level-1 summaries are merged into a pinned
// level-2 summary. Originals are flagged out of context (in_context = 0), never
// deleted. Returns whether anything was compressed and the deepest level reached.
export async function compressSession(sessionId: string): Promise<{ compressed: boolean; level: number }> {
  let compressed = false
  let maxLevel = 0

  for (let pass = 0; pass < MAX_COMPRESS_PASSES; pass++) {
    if (contextTokens(sessionId) < CONTEXT_LIMIT) break

    const verbatim = db()
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND in_context = 1 AND is_compressed = 0 AND is_bookmarked = 0
         ORDER BY timestamp ASC, rowid ASC
         LIMIT ?`,
      )
      .all(sessionId, COMPRESS_BATCH) as MessageRow[]

    if (verbatim.length > 0) {
      const summary = await summarize(transcriptOf(verbatim), 1)
      insertSummary(sessionId, summary, 1, verbatim[0].timestamp)
      excludeFromContext(verbatim.map(m => m.id))
      compressed = true
      maxLevel = Math.max(maxLevel, 1)
      continue
    }

    // No verbatim left to compress — merge the level-1 summaries into one level-2.
    const level1 = db()
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND in_context = 1 AND is_compressed = 1 AND compression_level = 1
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(sessionId) as MessageRow[]
    if (level1.length <= 1) break // nothing further can be reduced

    const merged = await summarize(transcriptOf(level1), 2)
    insertSummary(sessionId, merged, 2, level1[0].timestamp)
    excludeFromContext(level1.map(m => m.id))
    compressed = true
    maxLevel = 2
  }

  return { compressed, level: maxLevel }
}

function insertSummary(sessionId: string, content: string, level: number, timestamp: number): void {
  db()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, token_count, is_compressed, compression_level, is_bookmarked, in_context)
       VALUES (?, ?, 'assistant', ?, ?, ?, 1, ?, 0, 1)`,
    )
    .run(randomUUID(), sessionId, content, timestamp, estimateTokens(content), level)
}

function excludeFromContext(ids: string[]): void {
  const stmt = db().prepare(`UPDATE messages SET in_context = 0 WHERE id = ?`)
  const tx = db().transaction((list: string[]) => list.forEach(id => stmt.run(id)))
  tx(ids)
}

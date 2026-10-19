// ── Metalmind Vault ───────────────────────────────────────────────────────────────
// The knowledge layer between ephemeral chat (Mem0) and deep search. Every notebook and
// Source file is mirrored to disk as a human-readable Markdown file (so the-diagram-files/
// is a valid Obsidian vault) AND vectorized into Qdrant (collection `spectre_wiki`) for
// semantic recall. This module is the SINGLE source of truth for all vault operations.
//
// SERVER-ONLY: imports fs + the SQLite layer. Never import from client components.
//
// ERROR POLICY (critical): the vault must NEVER break existing functionality. Qdrant down,
// Ollama down, or a disk write failing all degrade silently — every public function
// catches its own errors, logs to console, and returns null / no-ops. Nothing throws.

import { mkdir, writeFile, rm, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  getNode, getNotebook, getFile, listNodes, listFiles, listAllNotebooks,
  type NodeRow, type FileRow,
} from './conversations'
import { tiptapToMarkdown } from './notebookMd'
import { extractText } from './fileText'

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const COLLECTION = 'spectre_wiki'
const EMBED_MODEL = 'nomic-embed-text'
const VECTOR_SIZE = 768

// ── Types ───────────────────────────────────────────────────────────────────────
export interface VaultChunk {
  id: string
  vector: number[]
  payload: {
    text: string
    title: string
    source_type: 'notebook' | 'file'
    source_id: string
    node_id: string
    chunk_index: number
    path: string
    updated_at: string
  }
}

export interface VaultResult {
  text: string
  title: string
  source_type: string
  node_id: string
  score: number
  path: string
}

// ── Path helpers ──────────────────────────────────────────────────────────────────
// Vault folders mirror the diagram_nodes tree with HUMAN-READABLE slugs (chosen layout):
//   Arm   → <root>/<arm-slug>/{sources,notebooks}
//   Hand  → <root>/<arm-slug>/<hand-slug>/{sources,notebooks}
// The "Projects" arm slugifies to `projects`, so its Hands land at projects/<hand-slug>/…
// (matching the requested tree). Raw uploaded bytes stay at their existing node_id paths;
// only the readable .md mirror lives here.
export function getVaultRoot(): string {
  return join(process.cwd(), 'the-diagram-files')
}

export function slug(name: string): string {
  return (name || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'untitled'
}

// Resolve a node id to its vault folder (sans the sources/notebooks leaf).
function nodeVaultDir(nodeId: string): string | null {
  const node = getNode(nodeId)
  if (!node) return null
  if (node.level === 'arm') return join(getVaultRoot(), slug(node.name))
  // Hand: nest under its arm's slug. Fall back to the hand alone if the arm is missing.
  const arm = node.parent_id ? getNode(node.parent_id) : null
  return arm
    ? join(getVaultRoot(), slug(arm.name), slug(node.name))
    : join(getVaultRoot(), slug(node.name))
}

export function getSourcesPath(nodeId: string): string | null {
  const dir = nodeVaultDir(nodeId)
  return dir ? join(dir, 'sources') : null
}

export function getNotebooksPath(nodeId: string): string | null {
  const dir = nodeVaultDir(nodeId)
  return dir ? join(dir, 'notebooks') : null
}

// ── Embedding (Ollama / nomic-embed-text) ───────────────────────────────────────────
// Cache by content hash so the same text isn't re-embedded within a process lifetime.
const embedCache = new Map<string, number[]>()

function hash(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

// Deterministic UUID from an arbitrary string (Qdrant point ids must be uint or UUID).
// Re-indexing the same chunk yields the same id, so upserts overwrite rather than dup.
function pointId(key: string): string {
  const h = createHash('md5').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export async function embedText(text: string): Promise<number[] | null> {
  const trimmed = (text || '').trim()
  if (!trimmed) return null
  const key = hash(trimmed)
  const cached = embedCache.get(key)
  if (cached) return cached
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: trimmed }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) { console.warn('[vault] embed failed:', res.status); return null }
    const data = await res.json()
    const vec = data?.embedding
    if (!Array.isArray(vec) || vec.length === 0) return null
    // Bound the cache (FIFO) so a multi-day server doesn't accumulate every query vector forever.
    if (embedCache.size >= 2000) { const oldest = embedCache.keys().next().value; if (oldest !== undefined) embedCache.delete(oldest) }
    embedCache.set(key, vec)
    return vec
  } catch (e) {
    console.warn('[vault] embed error (Ollama down?):', (e as Error).message)
    return null
  }
}

// ── Qdrant operations ───────────────────────────────────────────────────────────────
export async function ensureCollection(): Promise<void> {
  try {
    const head = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { signal: AbortSignal.timeout(5000) })
    if (head.ok) return   // already exists
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) console.log(`[vault] created Qdrant collection "${COLLECTION}"`)
    else console.warn('[vault] ensureCollection failed:', res.status)
  } catch (e) {
    console.warn('[vault] ensureCollection error (Qdrant down?):', (e as Error).message)
  }
}

export async function upsertChunks(chunks: VaultChunk[]): Promise<void> {
  if (!chunks.length) return
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: chunks.map(c => ({ id: pointId(c.id), vector: c.vector, payload: c.payload })),
      }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) console.warn('[vault] upsert failed:', res.status, await res.text().catch(() => ''))
  } catch (e) {
    console.warn('[vault] upsert error (Qdrant down?):', (e as Error).message)
  }
}

export async function deleteChunks(sourceType: string, id: string): Promise<void> {
  try {
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { must: [
          { key: 'source_type', match: { value: sourceType } },
          { key: 'source_id', match: { value: id } },
        ] },
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    console.warn('[vault] deleteChunks error:', (e as Error).message)
  }
}

// Count chunks for a given item (used by initialIndexPass to skip already-indexed items).
async function chunkCount(sourceType: string, id: string): Promise<number> {
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exact: true,
        filter: { must: [
          { key: 'source_type', match: { value: sourceType } },
          { key: 'source_id', match: { value: id } },
        ] },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return 0
    const data = await res.json()
    return data?.result?.count ?? 0
  } catch { return 0 }
}

export async function searchVault(
  query: string,
  nodeId?: string,
  limit = 5,
  scoreThreshold = 0.65,
): Promise<VaultResult[] | null> {
  const vector = await embedText(query)
  if (!vector) return null
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
        filter: nodeId ? { must: [{ key: 'node_id', match: { value: nodeId } }] } : undefined,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) { console.warn('[vault] search failed:', res.status); return null }
    const data = await res.json()
    const hits = Array.isArray(data?.result) ? data.result : []
    return hits.map((h: { score: number; payload: VaultChunk['payload'] }) => ({
      text: h.payload?.text ?? '',
      title: h.payload?.title ?? '',
      source_type: h.payload?.source_type ?? '',
      node_id: h.payload?.node_id ?? '',
      score: h.score ?? 0,
      path: h.payload?.path ?? '',
    }))
  } catch (e) {
    console.warn('[vault] search error (Qdrant down?):', (e as Error).message)
    return null
  }
}

// ── Scoped single-document search (the "second screen") ──────────────────────────────
// Semantic search restricted to ONE source item (a Source file or a notebook), via a
// payload filter on source_type + source_id. This is the vault pattern scoped to a single
// open document: the chunks are already in `spectre_wiki` (indexed on upload/save), so an
// open reference doc is always queryable without re-reading the whole thing. Threshold is
// low by default — within a single doc we want the most relevant sections by rank, not an
// absolute-similarity gate.
export async function searchDocument(
  query: string,
  sourceType: 'notebook' | 'file',
  sourceId: string,
  limit = 6,
  scoreThreshold = 0.25,
): Promise<VaultResult[] | null> {
  const vector = await embedText(query)
  if (!vector) return null
  try {
    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
        filter: { must: [
          { key: 'source_type', match: { value: sourceType } },
          { key: 'source_id', match: { value: sourceId } },
        ] },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) { console.warn('[vault] doc search failed:', res.status); return null }
    const data = await res.json()
    const hits = Array.isArray(data?.result) ? data.result : []
    return hits.map((h: { score: number; payload: VaultChunk['payload'] }) => ({
      text: h.payload?.text ?? '',
      title: h.payload?.title ?? '',
      source_type: h.payload?.source_type ?? '',
      node_id: h.payload?.node_id ?? '',
      score: h.score ?? 0,
      path: h.payload?.path ?? '',
    }))
  } catch (e) {
    console.warn('[vault] doc search error (Qdrant down?):', (e as Error).message)
    return null
  }
}

// Ensure a single document is indexed before scoped search needs it (fired when a Source
// file / notebook is opened). No-op when chunks already exist, so it's cheap to call on
// every open. Self-catching like everything else here.
export async function ensureDocIndexed(sourceType: 'notebook' | 'file', sourceId: string): Promise<void> {
  try {
    if (await chunkCount(sourceType, sourceId) > 0) return
    if (sourceType === 'file') await syncFileToVault(sourceId)
    else await syncNotebookToVault(sourceId)
  } catch (e) {
    console.warn('[vault] ensureDocIndexed error:', (e as Error).message)
  }
}

// ── Chunking ────────────────────────────────────────────────────────────────────────
// ~chunkSize words per chunk with `overlap` words of carry-over between adjacent chunks.
export function chunkText(text: string, chunkSize = 400, overlap = 50): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  if (words.length <= chunkSize) return [words.join(' ')]
  const step = Math.max(1, chunkSize - overlap)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += step) {
    chunks.push(words.slice(i, i + chunkSize).join(' '))
    if (i + chunkSize >= words.length) break
  }
  return chunks
}

// Shared writer: chunk + embed `text`, upsert into Qdrant under one source item. Replaces
// any prior chunks for the item first (so edits don't leave stale vectors behind).
async function indexText(opts: {
  text: string; title: string; sourceType: 'notebook' | 'file'; sourceId: string
  nodeId: string; path: string; updatedAt: string
}): Promise<void> {
  // Legitimately-empty content → drop any stale vectors and stop.
  if (!opts.text.trim()) { await deleteChunks(opts.sourceType, opts.sourceId); return }
  // Embed FIRST. If Ollama is down every embed returns null → we must NOT have already deleted
  // the existing vectors (that would silently DE-INDEX the doc, unsearchable until a restart).
  const pieces = chunkText(opts.text)
  const chunks: VaultChunk[] = []
  for (let i = 0; i < pieces.length; i++) {
    const vec = await embedText(pieces[i])
    if (!vec) continue   // Ollama down — skip silently
    chunks.push({
      id: `${opts.sourceType}-${opts.sourceId}-${i}`,
      vector: vec,
      payload: {
        text: pieces[i], title: opts.title, source_type: opts.sourceType,
        source_id: opts.sourceId, node_id: opts.nodeId, chunk_index: i,
        path: opts.path, updated_at: opts.updatedAt,
      },
    })
  }
  if (!chunks.length) return   // embedding unavailable → true no-op, keep the existing vectors
  // Replace the prior chunks only now that we have fresh ones to put in their place.
  await deleteChunks(opts.sourceType, opts.sourceId)
  await upsertChunks(chunks)
}

function frontmatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`)
  return `---\n${lines.join('\n')}\n---\n`
}

async function writeVaultFile(dir: string, filename: string, content: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true })
    const abs = join(dir, filename)
    await writeFile(abs, content, 'utf-8')
    return abs
  } catch (e) {
    console.warn('[vault] file write failed:', (e as Error).message)
    return null
  }
}

// ── Notebook sync ─────────────────────────────────────────────────────────────────
// Debounced to once per 30s per notebook + a content-hash guard so rapid autosaves don't
// hammer Qdrant. A trailing timer guarantees the final edit still syncs after the window.
const NB_DEBOUNCE_MS = 30_000
const nbState = new Map<string, { hash: string; ts: number; timer?: ReturnType<typeof setTimeout> }>()

export async function syncNotebookToVault(notebookId: string): Promise<void> {
  try {
    const nb = getNotebook(notebookId)
    if (!nb || nb.is_archived || nb.type !== 'notebook') return
    const md = nb.content ? tiptapToMarkdown(JSON.parse(nb.content)) : ''
    const contentHash = hash(`${nb.title}\u0000${md}`)
    const prev = nbState.get(notebookId)
    if (prev?.hash === contentHash) return   // nothing changed
    const now = Date.now()
    if (prev && now - prev.ts < NB_DEBOUNCE_MS) {
      // Within the debounce window — schedule a single trailing sync at the window's end.
      if (prev.timer) clearTimeout(prev.timer)
      const wait = NB_DEBOUNCE_MS - (now - prev.ts)
      const timer = setTimeout(() => { void syncNotebookToVault(notebookId) }, wait)
      nbState.set(notebookId, { hash: prev.hash, ts: prev.ts, timer })
      return
    }
    nbState.set(notebookId, { hash: contentHash, ts: now })

    const dir = getNotebooksPath(nb.node_id)
    if (!dir) return
    const node = getNode(nb.node_id)
    const created = new Date(nb.created_at).toISOString()
    const updated = new Date(nb.updated_at).toISOString()
    const body = frontmatter({
      title: nb.title, type: 'notebook', node_id: nb.node_id,
      notebook_id: nb.id, created_at: created, updated_at: updated,
    }) + `\n# ${nb.title}\n\n${md}\n`
    const filename = `${slug(nb.title)}.md`
    const path = await writeVaultFile(dir, filename, body)
    await indexText({
      text: `${nb.title}\n\n${md}`, title: nb.title, sourceType: 'notebook',
      sourceId: nb.id, nodeId: nb.node_id, path: path ?? join(dir, filename),
      updatedAt: updated,
    })
    console.log(`[vault] synced notebook "${nb.title}" (${node?.name ?? nb.node_id})`)
  } catch (e) {
    console.warn('[vault] syncNotebook error:', (e as Error).message)
  }
}

// ── File sync ─────────────────────────────────────────────────────────────────────
// Text files (.md/.txt/…) are copied verbatim into the vault and indexed. Binary/PDF/
// image files get a companion .md (frontmatter + extracted text where available); the
// `files` table has no summary column, so we index the extracted text instead.
export async function syncFileToVault(fileId: string): Promise<void> {
  try {
    const file = getFile(fileId)
    if (!file || file.is_archived || file.source !== 'sources') return
    const dir = getSourcesPath(file.node_id)
    if (!dir) return
    const node = getNode(file.node_id)
    const uploaded = new Date(file.created_at).toISOString()
    const { text, kind } = await extractText(file)

    let path: string | null
    let indexBody: string
    if (kind === 'text') {
      // Copy the text file straight into the vault under its readable name.
      const base = slug(file.filename.replace(/\.[^.]+$/, '')) || 'source'
      const ext = /\.(md|markdown)$/i.test(file.filename) ? '.md' : '.txt'
      path = await writeVaultFile(dir, `${base}${ext}`, text)
      indexBody = `${file.filename}\n\n${text}`
    } else {
      // Companion .md for a binary/PDF/image source.
      const hasText = kind === 'pdf' && !!text && !text.startsWith('(No extractable')
      const body = frontmatter({
        title: file.filename, type: 'source_file', node_id: file.node_id,
        file_id: file.id, original_file: file.filename, uploaded_at: uploaded,
      }) + `\n# ${file.filename}\n\n` +
        `**Project:** ${node?.name ?? file.node_id}  \n` +
        `**Type:** ${file.file_type.toUpperCase()}\n\n` +
        (hasText ? `## Extracted text\n\n${text}\n` : `## Notes\n\n${text}\n`)
      path = await writeVaultFile(dir, `${slug(file.filename.replace(/\.[^.]+$/, ''))}.md`, body)
      indexBody = `${file.filename} (${node?.name ?? ''})\n\n${text}`
    }
    await indexText({
      text: indexBody, title: file.filename, sourceType: 'file',
      sourceId: file.id, nodeId: file.node_id, path: path ?? join(dir, file.filename),
      updatedAt: uploaded,
    })
    console.log(`[vault] synced file "${file.filename}" (${node?.name ?? file.node_id})`)
  } catch (e) {
    console.warn('[vault] syncFile error:', (e as Error).message)
  }
}

// ── Removal ─────────────────────────────────────────────────────────────────────────
export async function removeFromVault(
  sourceType: 'notebook' | 'file',
  id: string,
  path?: string,
): Promise<void> {
  try {
    await deleteChunks(sourceType, id)
    // Resolve the .md path from the DB if the caller didn't supply one.
    let abs = path
    if (!abs) {
      if (sourceType === 'notebook') {
        const nb = getNotebook(id)
        const dir = nb ? getNotebooksPath(nb.node_id) : null
        if (nb && dir) abs = join(dir, `${slug(nb.title)}.md`)
      }
      // For files we leave the copied/companion .md in place by default (Sources are
      // permanent on disk); pass an explicit path to delete it.
    }
    if (abs && existsSync(abs)) await rm(abs, { force: true })
  } catch (e) {
    console.warn('[vault] removeFromVault error:', (e as Error).message)
  }
}

// ── Vault structure (.obsidian + README + folder mirror) ───────────────────────────
const README = `# Spectre Knowledge Vault

This vault is automatically maintained by The Diagram. Do not manually delete
folders — add files freely.
`

export async function ensureVaultStructure(): Promise<void> {
  try {
    const root = getVaultRoot()
    await mkdir(join(root, '.obsidian'), { recursive: true })
    if (!existsSync(join(root, 'README.md'))) await writeFile(join(root, 'README.md'), README, 'utf-8')
    // Mirror every current node's sources/notebooks folders.
    for (const node of listNodes()) {
      const s = getSourcesPath(node.id)
      const n = getNotebooksPath(node.id)
      if (s) await mkdir(s, { recursive: true })
      if (n) await mkdir(n, { recursive: true })
    }
  } catch (e) {
    console.warn('[vault] ensureVaultStructure error:', (e as Error).message)
  }
}

// Create the vault folders for a single newly-created node (wired into node creation).
export async function ensureNodeFolders(nodeId: string): Promise<void> {
  try {
    const s = getSourcesPath(nodeId)
    const n = getNotebooksPath(nodeId)
    if (s) await mkdir(s, { recursive: true })
    if (n) await mkdir(n, { recursive: true })
  } catch (e) {
    console.warn('[vault] ensureNodeFolders error:', (e as Error).message)
  }
}

// ── Initial index pass (server startup) ────────────────────────────────────────────
// Walks every node's notebooks + Source files; indexes anything Qdrant doesn't already
// have chunks for. Runs in the background; deterministic ids make it safe to re-run.
let indexing = false
export async function initialIndexPass(): Promise<void> {
  if (indexing) return
  indexing = true
  try {
    const nodes = listNodes()
    let indexed = 0
    for (const node of nodes) {
      let files: FileRow[] = []
      let notebooks: ReturnType<typeof listAllNotebooks> = []
      try { files = listFiles(node.id) } catch { /* none */ }
      try { notebooks = listAllNotebooks(node.id) } catch { /* none */ }
      for (const f of files) {
        if (await chunkCount('file', f.id) === 0) { await syncFileToVault(f.id); indexed++ }
      }
      for (const nb of notebooks) {
        if (nb.type !== 'notebook') continue
        if (await chunkCount('notebook', nb.id) === 0) { await syncNotebookToVault(nb.id); indexed++ }
      }
    }
    if (indexed) console.log(`[vault] initial index pass complete — ${indexed} item(s) indexed`)
    else console.log('[vault] initial index pass — everything already indexed')
  } catch (e) {
    console.warn('[vault] initialIndexPass error:', (e as Error).message)
  } finally {
    indexing = false
  }
}

// One-shot startup: ensure structure + collection, then background-index existing content.
let bootstrapped = false
export async function initVault(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true
  await ensureVaultStructure()
  await ensureCollection()
  void initialIndexPass()
}

// Silence "NodeRow unused" if tree-shaking complains in some build configs.
export type { NodeRow }

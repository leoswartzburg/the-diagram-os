'use client'

import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { stripMarkdown } from '@/lib/utils'
import { nowList, localDateStr, type NowTask } from '@/lib/nowList'
import { rhythmTimes, rhythmContextLine, windDownLine } from '@/lib/rhythm'
import { parseQuickAdd } from '@/lib/nlDue'
import { USER, USER_CAP, USER_POSS, USER_NAME } from '@/lib/profile'
import { registerSW, refreshSubscription, enableNotifications, sendTestPush, notifPermission, isStandalone, pushSupported } from '@/lib/pushClient'
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  IconFlask, IconBrain, IconBarbell, IconCalendar, IconFolder, IconRocket,
  IconMicroscope, IconChartLine, IconBook, IconCode, IconStar, IconSettings,
  IconPencil, IconRefresh, IconDownload, IconSearch, IconMicrophone,
  IconGripVertical, IconPlus, IconChevronRight, IconChevronDown, IconX, type IconProps,
  IconPaperclip, IconNotebook, IconUpload, IconTrash, IconFile,
  IconFileText, IconFileTypePdf, IconPhoto, IconTable, IconArrowRight,
  IconBold, IconItalic, IconUnderline, IconStrikethrough, IconHighlight,
  IconH1, IconH2, IconH3, IconList, IconListNumbers, IconListCheck,
  IconAlignLeft, IconAlignCenter, IconAlignRight, IconLineDashed,
  IconBlockquote, IconMaximize, IconMinimize, IconArrowLeft,
  IconArrowBackUp, IconArrowForwardUp, IconPrinter, IconCheck,
  IconPalette, IconMoodSmile, IconFolderPlus, IconFilePlus, IconDots, IconSparkles,
  IconBell, IconHeartbeat, IconBolt, IconFlame, IconTarget, IconChartBar, IconTrendingUp, IconMessage,
  IconMoon, IconVolume, IconVolumeOff,
} from '@tabler/icons-react'
import { SpectreOrb } from './components/SpectreOrb'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import Image from '@tiptap/extension-image'
import { Extension, Node as TiptapNodeExt, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { markdownToTiptap, tiptapToMarkdown, tiptapPreview, normalizeMath, migrateDocMath, type TiptapDoc } from '@/lib/notebookMd'

// ── Tabler icon system (outline only) ───────────────────────────────────────────
// DB-stored icon identifiers ('ti-flask' …) resolve to outline components here.
type TablerIcon = React.ComponentType<IconProps>
const TI_MAP: Record<string, TablerIcon> = {
  'ti-flask': IconFlask, 'ti-brain': IconBrain, 'ti-barbell': IconBarbell,
  'ti-calendar': IconCalendar, 'ti-folder': IconFolder, 'ti-rocket': IconRocket,
  'ti-microscope': IconMicroscope, 'ti-chart-line': IconChartLine, 'ti-book': IconBook,
  'ti-code': IconCode, 'ti-star': IconStar, 'ti-settings': IconSettings,
}
// The 12 user-pickable Arm/Hand icons (creation modal).
const ICON_CHOICES = Object.keys(TI_MAP)
function Ti({ name, size = 16, color = 'currentColor', stroke = 1.6, style }: {
  name: string; size?: number; color?: string; stroke?: number; style?: React.CSSProperties
}) {
  const Cmp = TI_MAP[name] ?? IconFolder
  return <Cmp size={size} color={color} stroke={stroke} style={style} />
}

type Mode = 'Orderly' | 'Creative' | 'Abstract'
type TtsMode = 'cloud' | 'local'
type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'reconfiguring'
// A file/image attached to a chat message. Display-only metadata (the bytes live on the
// server + an in-memory object URL for thumbnails). `kind` drives the preview rendering.
type AttachmentKind = 'image' | 'pdf' | 'text' | 'other'
type ChatAttachment = {
  filename: string
  file_type: string
  size_bytes: number
  kind: AttachmentKind
  previewUrl?: string   // object URL for image thumbnails (in-memory, live session only)
}
// `kind:'transition'` marks an ephemeral navigation/UI-action pill (e.g. "→ Navigating
// to Research"). These live in the display buffer only — never persisted to the
// messages table and never sent to the API (filtered from the offline fallback).
// `kind:'error'` marks a transient-failure placeholder that renders a "tap to retry" button.
// `kind:'research'` marks a live deep-research progress card (its state lives in `research`).
// `saveOffer` marks a substantial assistant reply with an ephemeral "save to notebooks"
// chip (display-only — never persisted, never sent to the API). `targetId`/`targetName`
// carry the pre-inferred destination; `targets` appears when the chip expands to a picker.
type SaveOffer = { title: string; markdown: string; targetId?: string; targetName?: string; targets?: { id: string; name: string }[] }
type Message = { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[]; kind?: 'transition' | 'error' | 'research'; research?: ResearchCardState; saveOffer?: SaveOffer }

// Selectable model — drives /api/spectre (modelId + backend) and /api/research (model).
// 'local-gpt-oss' selects the LOCAL backend (gpt-oss:20b on llama-server :8013,
// MoE-offloaded — zero cloud calls); the Claude ids select the cloud backend.
type ModelId = 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-6' | 'local-gpt-oss'
// Backend axis derived from the selected model ('local' = llama-server, 'claude' = Anthropic).
const backendFor = (m: ModelId): 'local' | 'claude' => (m === 'local-gpt-oss' ? 'local' : 'claude')

// Live state for a deep-research progress card rendered inline in the chat thread. Updated as SSE
// events arrive; it stays in the display buffer as a permanent record once complete.
type ResearchSource = { url: string; title: string; domain: string }
// A research plan proposed by Spectre (the conversational agent acting as orchestrator). Mirrors the
// backend OrchPlan / deepResearch action schema. When present on a deepResearch action, the user reviews
// it in the pre-flight plan modal and Launch sends it in the request body (skipping the cold orchestrator).
type SpectrePlanAgent = { id: number; name: string; directive: string; queries: string[]; dependencies: number[]; receives_from: number[] }
type SpectrePlan = { reasoning: string; agents: SpectrePlanAgent[]; synthesis_focus: string }
// One turn of the triggering chat session's history, sent with every /api/research request so the
// cold orchestrator plans from what was actually discussed (session context isolation fix).
type ResearchHistoryMsg = { role: 'user' | 'assistant'; content: string }
// Research effort tier selected before a run. Quick = Tavily snippets (fast); Deep = Playwright full
// page content + more agents (20-40 min); Exhaustive = full content + crawl + saturation-driven
// continuation loop, fire-and-forget (hours). Mirrors the server `mode`.
type ResearchModeUI = 'quick' | 'deep' | 'exhaustive'
const RESEARCH_MODES: { key: ResearchModeUI; label: string; blurb: string; time: string }[] = [
  { key: 'quick', label: 'Quick', blurb: 'Snippets · a few agents · fast answers', time: '~3–5 min' },
  { key: 'deep', label: 'Deep', blurb: 'Full page content · more agents · richer synthesis', time: '~20–40 min' },
  { key: 'exhaustive', label: 'Exhaustive', blurb: 'Full content + crawl · runs until saturated · fire-and-forget', time: 'hours' },
]
// Live saturation reading for a research run (Exhaustive especially): how much NEW ground the latest
// round covered. `saturation` (0→1) climbs as rounds get redundant; converges when the topic is done.
type SaturationReading = { round: number; novelty: number; saturation: number; consecutiveLow: number; threshold: number; needed: number }
// ── Intelligent DAG (orchestrator + circuit-board visual) ──
// One node in the circuit board. State drives its glow/colors; sources + searches feed its detail panel.
type DagNodeState = 'waiting' | 'running' | 'complete'
type DagAgentNode = {
  id: number
  name: string
  directive: string
  queries: string[]
  dependencies: number[]
  receives_from: number[]
  state: DagNodeState
  sources: { title: string; url: string; favicon: string }[]
  searches: string[]              // status history — every query this agent issued
  summaryPreview?: string
}
type DagState = {
  reasoning: string               // orchestrator's plan rationale (orchestrator node detail)
  synthesisFocus: string          // synthesis_focus instruction (orchestrator node detail)
  agents: DagAgentNode[]
  levels: number[][]              // topological grouping — drives the row layout
  synthesis: DagNodeState
  traveling: string[]             // dependency edge keys `${from}-${to}` currently pulsing
  resolved: string[]              // dependency edge keys that have completed (solid lit)
}
// Pipeline steps drive the progress bar: Plan → Search → Synthesize → Save.
type ResearchStep = 'plan' | 'search' | 'analyze' | 'synthesize' | 'save'
type ResearchCardState = {
  model: ModelId
  status: string                 // latest human-readable status line
  done: boolean
  error?: string
  notebookId?: string
  notebookTitle?: string
  nodeId: string                 // owning node — for the "open notebook" navigation on complete
  step?: ResearchStep            // current pipeline step (progress bar)
  tokens?: number                // running token usage (live counter, updated every API call)
  cap?: number                   // token budget cap for the mode
  cost?: number                  // live cost estimate in USD (input×$3/M + output×$15/M)
  sources: ResearchSource[]      // live source feed
  startedAt: number              // epoch ms — drives the elapsed timer
  finishedAt?: number            // epoch ms when done — freezes the timer
  partial?: boolean              // stopped early (abort / budget / timeout)
  aborting?: boolean             // STOP pressed, awaiting partial synthesis
  windingDown?: boolean          // WIND DOWN pressed (or saturation auto-trigger) — graceful exit
  estCost?: string               // cost-range estimate shown in header
  dag?: DagState                 // the orchestrated DAG (circuit-board visual)
  mode?: ResearchModeUI          // effort tier (quick/deep/exhaustive)
  playwright?: boolean           // full page content active (Playwright reachable) this run
  saturation?: SaturationReading // live knowledge-saturation reading (Exhaustive indicator)
  persisted?: boolean            // restored from a saved session row (static, muted render)
}
// Immutably patch one agent in a research card's DAG state.
function updateDagAgent(r: ResearchCardState, agentId: number, fn: (a: DagAgentNode) => DagAgentNode): ResearchCardState {
  if (!r.dag) return r
  return { ...r, dag: { ...r.dag, agents: r.dag.agents.map(a => a.id === Number(agentId) ? fn(a) : a) } }
}

// ── Research card persistence ────────────────────────────────────────────────────────────────
// A completed research run is saved to the session as a regular assistant message whose content is
// this marker + a JSON snapshot of the card (DAG plan + final agent states, source counts, tokens,
// cost, notebook id/title, timestamps, partial flag). Saved with is_bookmarked so the sliding-window
// compression NEVER folds it. On session load the row is parsed back into a kind:'research' message
// so the circuit board re-renders in its completed state as a permanent record.
const RESEARCH_MSG_PREFIX = '[RESEARCH_RESULT]'
function serializeResearchCard(r: ResearchCardState): string {
  const dag = r.dag ? {
    reasoning: r.dag.reasoning, synthesisFocus: r.dag.synthesisFocus, levels: r.dag.levels, synthesis: r.dag.synthesis,
    agents: r.dag.agents.map(a => ({
      id: a.id, name: a.name, directive: a.directive, queries: a.queries.slice(0, 6),
      dependencies: a.dependencies, receives_from: a.receives_from, state: a.state,
      sources: a.sources.slice(0, 12), searches: a.searches.slice(0, 6), summaryPreview: a.summaryPreview,
    })),
  } : undefined
  return RESEARCH_MSG_PREFIX + JSON.stringify({
    model: r.model, status: r.status, nodeId: r.nodeId, tokens: r.tokens, cap: r.cap, cost: r.cost,
    sources: r.sources.slice(0, 25), startedAt: r.startedAt, finishedAt: r.finishedAt ?? Date.now(),
    partial: !!r.partial, notebookId: r.notebookId, notebookTitle: r.notebookTitle, estCost: r.estCost, dag,
    mode: r.mode, playwright: r.playwright, saturation: r.saturation,
  })
}
// Parse a persisted research row back into a completed card. null = not a research row / malformed
// (the row then renders as a plain message, so a bad payload can never break the thread).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResearchMessage(content: string): ResearchCardState | null {
  if (!content.startsWith(RESEARCH_MSG_PREFIX)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = JSON.parse(content.slice(RESEARCH_MSG_PREFIX.length))
    if (!p || typeof p !== 'object') return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agents: DagAgentNode[] = Array.isArray(p.dag?.agents) ? p.dag.agents.map((a: any) => ({
      id: Number(a.id), name: String(a.name ?? `Agent ${a.id}`), directive: String(a.directive ?? ''),
      queries: Array.isArray(a.queries) ? a.queries.map(String) : [],
      dependencies: Array.isArray(a.dependencies) ? a.dependencies.map(Number) : [],
      receives_from: Array.isArray(a.receives_from) ? a.receives_from.map(Number) : [],
      state: (a.state === 'running' ? 'complete' : a.state === 'waiting' ? 'waiting' : 'complete') as DagNodeState,
      sources: Array.isArray(a.sources) ? a.sources : [], searches: Array.isArray(a.searches) ? a.searches.map(String) : [],
      summaryPreview: a.summaryPreview ? String(a.summaryPreview) : undefined,
    })) : []
    const dag: DagState | undefined = p.dag ? {
      reasoning: String(p.dag.reasoning ?? ''), synthesisFocus: String(p.dag.synthesisFocus ?? ''),
      agents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      levels: Array.isArray(p.dag.levels) ? p.dag.levels.map((l: any) => Array.isArray(l) ? l.map(Number) : []) : [],
      synthesis: (p.dag.synthesis === 'waiting' ? 'waiting' : 'complete') as DagNodeState,
      traveling: [],
      // All dependency edges render settled/lit in the restored static board.
      resolved: agents.flatMap(a => Array.from(new Set([...a.dependencies, ...a.receives_from])).map(d => `${d}-${a.id}`)),
    } : undefined
    return {
      model: (p.model === 'claude-opus-4-6' || p.model === 'local-gpt-oss') ? p.model : 'claude-sonnet-4-6',
      status: String(p.status ?? 'Research complete'), done: true,
      notebookId: p.notebookId ? String(p.notebookId) : undefined,
      notebookTitle: p.notebookTitle ? String(p.notebookTitle) : undefined,
      nodeId: String(p.nodeId ?? 'main'), step: 'save',
      tokens: typeof p.tokens === 'number' ? p.tokens : undefined,
      cap: typeof p.cap === 'number' ? p.cap : undefined,
      cost: typeof p.cost === 'number' ? p.cost : undefined,
      sources: Array.isArray(p.sources) ? p.sources : [],
      startedAt: typeof p.startedAt === 'number' ? p.startedAt : Date.now(),
      finishedAt: typeof p.finishedAt === 'number' ? p.finishedAt : Date.now(),
      partial: !!p.partial, estCost: p.estCost ? String(p.estCost) : undefined,
      mode: (p.mode === 'deep' || p.mode === 'exhaustive') ? p.mode : undefined,
      playwright: !!p.playwright,
      saturation: p.saturation && typeof p.saturation === 'object' ? p.saturation : undefined,
      dag, persisted: true,
    }
  } catch { return null }
}
// Compact line representing a research run inside the MODEL's context window — the raw JSON
// snapshot must never reach the API (it would waste tokens and confuse the model).
function researchContextLine(content: string): string {
  const card = parseResearchMessage(content)
  if (!card) return '[A deep research run completed here.]'
  return `[Deep research completed${card.partial ? ' (stopped early)' : ''}; report saved to notebook "${card.notebookTitle ?? 'Research report'}".]`
}
// Honest cost range for the single self-scaling DAG pipeline. There are no fixed modes anymore — the
// orchestrator plans 2 agents for a narrow query and up to 6 for a broad one, so the spend scales with
// complexity. The range brackets a cheap 2-agent run up to a heavy 6-agent run on the selected model.
function estimateResearchCost(model: ModelId): string {
  if (model === 'local-gpt-oss') return 'Free · local (GPT-OSS + Tavily)'
  return model === 'claude-opus-4-6' ? '~$0.40 – $1.50' : '~$0.20 – $0.80'
}
// Short research-model label used on the card / confirm modal (GPT-OSS for local runs).
function researchModelLabel(model: ModelId, caps = false): string {
  if (model === 'local-gpt-oss') return caps ? 'GPT-OSS' : 'GPT-OSS'
  if (model === 'claude-opus-4-6') return caps ? 'OPUS' : 'Opus'
  return caps ? 'SONNET' : 'Sonnet'
}
// Validate + coerce a plan object off a deepResearch action into a SpectrePlan. Returns undefined when
// the plan is missing or has no usable agents (→ the simple confirm modal + cold orchestrator). The
// backend re-runs sanitizePlan regardless, so this is a light client-side shape check for the modal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSpectrePlan(raw: any): SpectrePlan | undefined {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents) || raw.agents.length === 0) return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents: SpectrePlanAgent[] = raw.agents.slice(0, 6).map((a: any, i: number) => ({
    id: typeof a?.id === 'number' ? a.id : i + 1,
    name: String(a?.name ?? `Agent ${i + 1}`),
    directive: String(a?.directive ?? ''),
    queries: Array.isArray(a?.queries) ? a.queries.map(String).filter(Boolean).slice(0, 3) : [],
    dependencies: Array.isArray(a?.dependencies) ? a.dependencies.map(Number).filter((n: number) => Number.isFinite(n)) : [],
    receives_from: Array.isArray(a?.receives_from) ? a.receives_from.map(Number).filter((n: number) => Number.isFinite(n)) : [],
  }))
  if (!agents.some(a => a.directive.trim())) return undefined
  return {
    reasoning: String(raw.reasoning ?? ''),
    synthesis_focus: String(raw.synthesis_focus ?? ''),
    agents,
  }
}
// A pending attachment in the composer (before send): the File + upload/extraction state.
type PendingAttachment = ChatAttachment & {
  localId: string
  file: File
  fileId?: string                 // server file id once uploaded
  base64?: string                 // data (no prefix) for image content blocks
  mediaType?: string              // image/png etc. for the Claude image block
  uploading: boolean
  error?: string
  uploadPromise?: Promise<string | undefined>  // resolves with the server file id
  base64Promise?: Promise<string | undefined>  // resolves with image base64 (images only)
}
type FolderId = 'main' | 'schedule' | 'body' | 'projects' | 'training'
type Project = { id: string; name: string; sub: string; progress: number; phase: string; description: string }
// A Google Calendar event (mirrors CalendarEvent in lib/gcal.ts).
type CalendarEvent = {
  id: string
  title: string
  start: string   // ISO datetime (timed) or 'YYYY-MM-DD' (all-day)
  end: string
  allDay: boolean
  color?: string
  location?: string
  description?: string
  recurringEventId?: string   // series id for recurring instances (block links match the series)
}
type BodyStat = { label: string; value: number; unit: string; bar: boolean; context: string }
// Live Oura Ring data (mirrors OuraDay / OuraSnapshot in lib/oura.ts). One real
// metric record per calendar day; durations are seconds (converted for display).
type OuraDay = {
  date: string
  sleep_score: number | null
  readiness_score: number | null
  average_hrv: number | null            // ms
  average_heart_rate: number | null     // bpm
  total_sleep_duration: number | null   // seconds
  rem_sleep_duration: number | null     // seconds
  deep_sleep_duration: number | null    // seconds
  temperature_deviation: number | null  // °C
  contributors: Record<string, number | null> | null
}
type OuraSnapshot = {
  date: string
  fromYesterday: boolean
  lastSynced: string | null
  days: OuraDay[]   // 7, oldest→newest, calendar-aligned (today = last entry)
}
// ── Gym arm (mirrors lib/workouts.ts; mirrored here to keep fs out of the client bundle) ──
type WorkoutSet = { plannedWeight: string; plannedReps: string; actualWeight: string; actualReps: string; done: boolean }
type WorkoutBlock = { id: string; exercise: string; note: string; restSeconds: number; sets: WorkoutSet[] }
type Workout = { date: string; title: string; focus: string; notes: string; completed: boolean; blocks: WorkoutBlock[] }
type WorkoutsMap = Record<string, Workout>
type ExerciseSession = { date: string; topWeight: number; topReps: number; bestE1rm: number }
type ExerciseRecord = { name: string; maxWeight: number; maxReps: number; bestE1rm: number; sessions: ExerciseSession[] }
type ExercisesMap = Record<string, ExerciseRecord>

// Persistent chat sessions (mirrors the SQLite rows in lib/conversations.ts). A
// "scope" is the folder_id: 'main' | 'schedule' | 'body' | 'projects' | 'training'
// or a project sub-page ('project-diagram' etc.).
type SessionMeta = {
  id: string
  folder_id: string
  title: string
  created_at: number
  updated_at: number
  last_message_preview: string
  is_archived: number
  tag_id?: string | null   // section/tag (project Hand workspaces only)
  summary_count?: number   // > 0 → this session has compressed history
}
// A section/tag for intra-project chat organization — mirrors TagRow.
type Tag = { id: string; node_id: string; name: string; color: string; created_at: number }
type SessionMsg = {
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
  deleted_at?: number | null
}

// ── Diagram tree (Core / Arms / Hands) — mirrors lib/conversations.ts NodeRow ──
// CORE = the main page (implicit, scope 'main'). ARMS = bento tiles. HANDS = items
// inside an Arm. A node's id IS its session scope (folder_id).
type NodeLevel = 'arm' | 'hand'
type NodeTemplate = 'research' | 'health' | 'training' | 'schedule' | 'project' | 'custom'
type NodeMeta = {
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
  summary?: string
  summary_updated_at?: number | null
}
// A reference file attached to a Project Hand (SOURCES section) — mirrors FileRow.
type SourceFile = {
  id: string
  node_id: string
  filename: string
  stored_path: string
  file_type: string
  size_bytes: number
  created_at: number
}
type SessionSearchResult = SessionMeta & { match_excerpt: string; match_field: 'title' | 'message' }

// SOURCES = amber, NOTEBOOKS = teal — distinct accents from the blue chat interface.
const SRC_AMBER = '#EF9F27'
const SRC_AMBER_TINT = 'rgba(239,159,39,0.15)'
const NB_TEAL = '#1D9E75'
const NB_TEAL_TINT = 'rgba(29,158,117,0.10)'
const EDITOR_BLUE = '#0EA5E9'   // ghost text + editor active states

// Docu-scape: a folder or notebook in a Project Hand's NOTEBOOKS library (client mirror
// of NotebookRow; folders carry a derived child_count for the card subtitle).
type NotebookMeta = {
  id: string
  node_id: string
  parent_id: string
  type: 'folder' | 'notebook'
  title: string
  content: string
  position: number
  created_at: number
  updated_at: number
  is_archived: number
  created_by: string
  icon: string
  color: string
  child_count?: number
}
// Six accent colors offered in the notebook creation/color-change pickers.
const NOTEBOOK_COLORS = ['#1D9E75', '#0EA5E9', '#EF9F27', '#D85A30', '#7F77DD', '#E0518A']

// Map a file extension/type to a Tabler outline icon for the SOURCES list.
function fileTypeIcon(type: string): React.ComponentType<IconProps> {
  const t = (type || '').toLowerCase()
  if (t === 'pdf') return IconFileTypePdf
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(t) || t.startsWith('image')) return IconPhoto
  if (['txt', 'md', 'markdown', 'rtf', 'docx', 'doc'].includes(t) || t.startsWith('text')) return IconFileText
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(t)) return IconTable
  return IconFile
}
function fmtBytes(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ── Chat attachments ─────────────────────────────────────────────────────────────
const CHAT_ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv', 'docx']
const MAX_ATTACH_BYTES = 25 * 1024 * 1024
// Image types Claude accepts as base64 content blocks (others → "other" file note).
const CLAUDE_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif']
function attachKind(ext: string): AttachmentKind {
  const e = ext.toLowerCase()
  if (e === 'pdf') return 'pdf'
  if (CLAUDE_IMAGE_EXT.includes(e)) return 'image'
  if (['txt', 'md', 'markdown', 'csv', 'tsv'].includes(e)) return 'text'
  return 'other'
}
function randomLocalId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// Default Spectre primer per template — used when a node's primer is empty and as the
// "reset to default" target in the primer editor.
const TEMPLATE_PRIMERS: Record<NodeTemplate, string> = {
  research: 'You are assisting with active scientific research. Context includes experiments, literature, data analysis, and lab protocols. Be precise, cite uncertainty, think like a scientist.',
  health: 'You are monitoring health and biometric data. Be analytical about trends, flag anomalies, connect physiological patterns to performance and recovery.',
  training: 'You are a training and performance assistant. Track progress, suggest adjustments, and reason about load, recovery, and adaptation.',
  schedule: 'You are a scheduling and time management assistant. Help prioritize, plan, and navigate commitments efficiently.',
  project: 'You are a project management assistant. Track progress, surface blockers, and maintain clarity on goals and next steps.',
  custom: '',
}
const TEMPLATE_CHOICES: { value: NodeTemplate; label: string; desc: string; icon: string }[] = [
  { value: 'research', label: 'Research', desc: 'Lab work, experiments, literature', icon: 'ti-flask' },
  { value: 'health',   label: 'Health',   desc: 'Metrics, protocols, body tracking', icon: 'ti-chart-line' },
  { value: 'training', label: 'Training', desc: 'Workouts, programs, progress', icon: 'ti-barbell' },
  { value: 'schedule', label: 'Schedule', desc: 'Time management, events, planning', icon: 'ti-calendar' },
  { value: 'project',  label: 'Project',  desc: 'General project management', icon: 'ti-folder' },
  { value: 'custom',   label: 'Custom',   desc: 'Blank slate, no default primer', icon: 'ti-star' },
]

// Compact relative timestamp for the session list ("Just now", "2h ago",
// "Yesterday", "Jun 3", "Jun 3 2025").
function relativeTime(ms: number): string {
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - ms) / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= startOfToday - 864e5 && ms < startOfToday) return 'Yesterday'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatNow(): string {
  const now = new Date()
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${date} · ${time}`
}

// ── Oura helpers ─────────────────────────────────────────────────────────────
// Oura's cloud only refreshes after the ring syncs in the morning, so the client
// force-syncs every 10 min between 7–11am local; outside that window it just reads
// the cache. (See the polling effect.)
const OURA_SYNC_START_HOUR = 7
const OURA_SYNC_END_HOUR = 11
function withinOuraSyncWindow(d = new Date()): boolean {
  const h = d.getHours()
  return h >= OURA_SYNC_START_HOUR && h < OURA_SYNC_END_HOUR
}

// Today = the most recent day in the snapshot.
function ouraToday(o: OuraSnapshot): OuraDay | null {
  return o.days.length ? o.days[o.days.length - 1] : null
}
// A nullable per-day series for one metric, oldest→newest (alignment preserved).
function ouraSeries(o: OuraSnapshot, key: keyof OuraDay): (number | null)[] {
  return o.days.map(d => (typeof d[key] === 'number' ? (d[key] as number) : null))
}
// 7-day trend phrase: compares today's value to the average of the prior days.
function ouraTrend(today: number | null, series: (number | null)[]): string {
  const nums = series.filter((v): v is number => v != null)
  if (today == null || nums.length < 2) return ''
  const prior = nums.slice(0, -1)
  const avg = Math.round(prior.reduce((a, b) => a + b, 0) / prior.length)
  const dir = today > avg + 2 ? 'trending up' : today < avg - 2 ? 'trending down' : 'steady'
  return `${dir} from ${avg} avg last week`
}
type OuraCard = { label: string; value: number | null; unit: string; bar: boolean }
// The four headline body cards for today (null → UI shows "--", never a fake 0).
function ouraCards(o: OuraSnapshot | null): OuraCard[] {
  const t = o ? ouraToday(o) : null
  return [
    { label: 'Sleep',      value: t?.sleep_score ?? null,        unit: '%',   bar: true },
    { label: 'Readiness',  value: t?.readiness_score ?? null,    unit: '%',   bar: true },
    { label: 'HRV',        value: t?.average_hrv ?? null,        unit: 'ms',  bar: false },
    { label: 'Resting HR', value: t?.average_heart_rate ?? null, unit: 'bpm', bar: false },
  ]
}
// Compact health block for Spectre's context — today's scores + 7-day trends.
function ouraPrimerLines(o: OuraSnapshot, compact = false): string {
  const t = ouraToday(o)
  if (!t) return '  no data'
  const line = (label: string, val: number | null, unit: string, key: keyof OuraDay) => {
    if (val == null) return `  ${label}: no data`
    const tr = ouraTrend(val, ouraSeries(o, key))
    return `  ${label}: ${val}${unit}${tr ? ` (${tr})` : ''}`
  }
  const lines = [
    line('Sleep score', t.sleep_score, '%', 'sleep_score'),
    line('Readiness score', t.readiness_score, '%', 'readiness_score'),
    line('HRV', t.average_hrv, 'ms', 'average_hrv'),
  ]
  // Full detail (Body arm) adds resting HR + the sleep-stage breakdown; the compact form
  // (main dashboard standing inject) stops at the three headline scores.
  if (!compact) {
    lines.push(line('Resting HR', t.average_heart_rate, ' bpm', 'average_heart_rate'))
    if (t.total_sleep_duration != null) {
      lines.push(`  Total sleep: ${(t.total_sleep_duration / 3600).toFixed(1)}h (REM ${Math.round((t.rem_sleep_duration ?? 0) / 60)}m, deep ${Math.round((t.deep_sleep_duration ?? 0) / 60)}m)`)
    }
  }
  const freshness = o.fromYesterday
    ? `(showing yesterday's data — ring not synced today)`
    : `(synced ${o.lastSynced ? new Date(o.lastSynced).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'recently'})`
  return `${freshness}\n${lines.join('\n')}`
}
// "Last synced" / freshness label for the UI.
function ouraSyncedLabel(o: OuraSnapshot): string {
  if (o.fromYesterday) return 'From yesterday · ring not synced today'
  if (!o.lastSynced) return ''
  return `Synced ${new Date(o.lastSynced).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

// ── Calendar date helpers ────────────────────────────────────────────────
// All-day events carry a date-only string ('YYYY-MM-DD') → parse as local
// midnight; timed events carry a full ISO datetime → parse as-is.
function evDate(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(iso)
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
function fmt12fromDate(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}
// All-day first, then by start time.
function sortEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  return evDate(a.start).getTime() - evDate(b.start).getTime()
}
// Filter calendar events to a near-term window of N days from local midnight today
// (exclusive end). Used to give the main dashboard today+tomorrow instead of the full week.
function eventsWithinDays(events: CalendarEvent[], days: number): CalendarEvent[] {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + days)
  return events.filter(e => { const d = evDate(e.start); return d >= start && d < end })
}

// Compact lines for the Spectre context primer.
function formatEventsForPrimer(events: CalendarEvent[], withIds: boolean): string {
  if (!events.length) return '  (nothing scheduled)'
  return events.map(e => {
    const d = evDate(e.start)
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    const time = e.allDay ? 'all day' : fmt12fromDate(d)
    const loc = e.location ? ` @ ${e.location}` : ''
    const idTag = withIds ? `  [id:${e.id}]` : ''
    return `  ${day} · ${time} · ${e.title}${loc}${idTag}`
  }).join('\n')
}

const CAL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ── Gym arm helpers ──────────────────────────────────────────────────────────
// Workout keys are real ISO dates ('YYYY-MM-DD', padded) — distinct from dayKey()
// which the calendar uses for grouping (0-indexed month, unpadded).
function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
function genBlockId(): string {
  return `blk_${Math.random().toString(36).slice(2, 8)}`
}
// "120s" → 120, "2m" → 120, "1m30s" → 90, "90" → 90. Falls back to 90s.
function parseRestSeconds(raw: string): number {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return 90
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0
  const m = s.match(/(\d+)\s*m/)
  const sec = s.match(/(\d+)\s*s/)
  if (m) total += parseInt(m[1], 10) * 60
  if (sec) total += parseInt(sec[1], 10)
  return total || 90
}
function fmtRest(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`
  if (seconds > 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}
function num(s: string | undefined): number {
  if (!s) return NaN
  const n = parseFloat(String(s).trim())
  return Number.isFinite(n) ? n : NaN
}
// Epley estimated 1-rep max (matches lib/workouts.ts), one decimal.
function epley(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}
// Builds a WorkoutBlock from a Spectre action block (updateWorkout) or a legacy
// updateTraining exercise. "sets" (a count) expands into that many planned rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blockFromAction(b: Record<string, any>): WorkoutBlock {
  const setsCount = Math.max(1, Math.min(20, Math.round(Number(b.sets ?? 3)) || 3))
  const plannedReps = String(b.reps ?? '')
  const plannedWeight = String(b.weight ?? '')
  const sets: WorkoutSet[] = Array.from({ length: setsCount }, () => ({
    plannedWeight, plannedReps, actualWeight: '', actualReps: '', done: false,
  }))
  return {
    id: genBlockId(),
    exercise: String(b.exercise ?? b.name ?? '').trim(),
    note: String(b.note ?? b.notes ?? ''),
    restSeconds: parseRestSeconds(String(b.rest ?? '90s')),
    sets,
  }
}
// Normalizes a Spectre action payload (updateWorkout.workout OR legacy
// updateTraining.training) into a full Workout for the given date.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeWorkout(date: string, raw: Record<string, any>): Workout {
  const blocksRaw: Record<string, unknown>[] = Array.isArray(raw.blocks)
    ? raw.blocks
    : Array.isArray(raw.exercises) ? raw.exercises : []
  return {
    date,
    title: String(raw.title ?? raw.type ?? 'Workout'),
    focus: String(raw.focus ?? ''),
    notes: String(raw.notes ?? ''),
    completed: false,
    blocks: blocksRaw.map(blockFromAction),
  }
}

// CORE (main page) primer — the aggregate [LIVE DASHBOARD STATE] across every Arm.
// (Arms/Hands get their instructional primer from diagram_nodes + buildLiveBlock.)
function buildMainPrimer(
  weekEvents: CalendarEvent[],
  body: BodyStat[],
  oura: OuraSnapshot | null,
  projects: Project[],
  workouts: WorkoutsMap,
): string {
  // Main gets only today + tomorrow (near-term awareness); the Schedule arm keeps the full
  // 7-day view. Oura is the compact 3-score form here; the Body arm injects the full detail.
  const schedLines = formatEventsForPrimer(eventsWithinDays(weekEvents, 2), false)
  // Without Oura, `body` only holds placeholder values — never present those as real data.
  void body
  const bodyLines = oura ? ouraPrimerLines(oura, true) : '  (Oura Ring not connected — no live health data. Never quote sleep/readiness/HRV numbers.)'
  const projLines = projects.map(p => `  ${p.name}: ${p.progress}% · ${p.phase}`).join('\n')
  const wToday = workouts[isoDate(new Date())]
  const trainingLine = wToday && wToday.blocks.length
    ? `  ${wToday.title} · ${wToday.focus || 'general'} · ${wToday.blocks.length} exercises${wToday.completed ? ' · completed' : ''}`
    : '  No workout logged for today'
  return `[LIVE DASHBOARD STATE]\nBODY (Oura Ring):\n${bodyLines}\n\nSCHEDULE (Google Calendar, today + tomorrow):\n${schedLines}\n\nPROJECTS:\n${projLines}\n\nTRAINING (today):\n${trainingLine}`
}

// Live-data block appended below an Arm/Hand's (editable) instructional primer. Keyed
// by the canonical seeded scope id — the instructional prose now lives in the node's
// `primer` field, so this returns ONLY the live numbers. Empty for custom nodes.
function buildLiveBlock(
  scope: string,
  weekEvents: CalendarEvent[],
  oura: OuraSnapshot | null,
  projects: Project[],
  workouts: WorkoutsMap,
  exercises: ExercisesMap,
  viewDate: Date,
  openBlock: string | null,
): string {
  switch (scope) {
    case 'schedule':
      return `\n\nCalendar — next 7 days:\n${formatEventsForPrimer(weekEvents, true)}`

    case 'body':
      return oura
        ? `\n\nOura — today:\n${ouraPrimerLines(oura)}`
        : `\n\n(The Oura Ring isn't connected yet — no live health data. Suggest ${USER} tap "Connect Oura Ring".)`

    case 'projects':
      return `\n\nProjects:\n${projects.map(p => `  ${p.name}: ${p.progress}% · ${p.phase}`).join('\n')}`

    // Seeded project Hands (project-lab etc.) — inject THIS project's live status so
    // Spectre knows its real numbers inside its own workspace, mirroring the cards/panel.
    case 'project-diagram':
    case 'project-lab':
    case 'project-build': {
      const legacy = NODE_TO_LEGACY_ID[scope]
      const p = projects.find(x => x.id === legacy)
      if (!p) return ''
      return `\n\nCurrent status of this project:\n  ${p.name}: ${p.progress}% complete · ${p.phase}\n  ${p.description}\n\nTo change its progress, phase, description, or name, emit an updateNode action with id "${scope}".`
    }

    case 'training': {
      const dk = isoDate(viewDate)
      const today = isoDate(new Date())
      const rel = dk === today ? 'today' : dk < today ? 'a past day' : 'an upcoming day'
      const dLabel = viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      const w = workouts[dk]
      let body = 'There is no workout recorded for this day yet.'
      let histBlock = ''
      if (w && w.blocks.length) {
        const exLines = w.blocks.map(b => {
          const setInfo = b.sets.map((s, i) => {
            const planned = `${s.plannedWeight || '—'}×${s.plannedReps || '—'}`
            const logged = (s.actualWeight || s.actualReps) ? ` [logged ${s.actualWeight || '?'}×${s.actualReps || '?'}]` : ''
            return `set ${i + 1}: ${planned}${logged}`
          }).join('; ')
          return `  - ${b.exercise} (rest ${fmtRest(b.restSeconds)})${b.note ? ' · ' + b.note : ''}\n      ${setInfo}`
        }).join('\n')
        body = `Title: ${w.title}\nFocus: ${w.focus || '—'}\nNotes: ${w.notes || '—'}\nExercises:\n${exLines}`
        const histLines = w.blocks.map(b => {
          const rec = exercises[b.exercise.toLowerCase()]
          if (!rec || rec.sessions.length === 0) return `  - ${b.exercise}: no logged history yet`
          const last = rec.sessions[rec.sessions.length - 1]
          return `  - ${b.exercise}: best e1RM ${rec.bestE1rm}, heaviest ${rec.maxWeight}, last trained ${last.date} (top ${last.topWeight}×${last.topReps})`
        }).join('\n')
        histBlock = `\n\nHistory & PRs for these exercises (from ${USER_POSS} logged sets):\n${histLines}`
      }
      const openLine = openBlock ? `\n\n${USER_CAP} is currently viewing the "${openBlock}" exercise detail subpage.` : ''
      const dayOne = Object.keys(workouts).length === 0
        ? `\n\n(Day one — the master workout file is empty, so build from scratch based on ${USER_POSS} goals.)`
        : ''
      return `\n\nViewing the workout for ${dLabel} (${rel}).\n\n${body}${histBlock}${openLine}${dayOne}`
    }

    default:
      return ''
  }
}

// ── Arm-scoped context injection profile ────────────────────────────────────
// Classifies the active scope into an injection tier + the cross-cutting context
// categories it should receive. DERIVED FROM node.level + node.template (never
// hardcoded arm names) so user-created arms classify automatically.
//
// The node's OWN domain live-data is handled separately by buildLiveBlock, which
// is keyed per-node and therefore NEVER leaks Oura/gym into an unrelated arm —
// that per-node keying IS the "NO biometric / NO gym" enforcement for arms whose
// template isn't health/training (the body arm getting Oura / training arm getting
// gym is correct: that is their domain). Injection matrix:
//   CORE     → full dashboard (buildMainPrimer) + all-arm primer summaries + broad vault
//   ARM      → node primer + global calendar + node-biased vault
//   HAND     → node primer + parent-arm primer gist + global calendar + node-biased vault
//   UNKNOWN  → node primer + global calendar + UNFILTERED vault (catch-all for
//              user-created arms with no recognized domain template)
// Calendar is global (every tier). Memory is global/query-relevant for all tiers
// (handled server-side in /api/spectre — see SCRATCH diagnosis; route untouched).
type InjectionTier = 'core' | 'arm' | 'hand' | 'unknown'
interface InjectionProfile {
  tier: InjectionTier
  calendar: boolean        // global next-7-days calendar block
  armSummaries: boolean    // lightweight summaries of every Arm (CORE only)
  vaultScope: 'broad' | 'node' | 'unfiltered'
}
// Templates that carry a recognized live-data domain (so the arm is a "known" arm
// rather than the user-created catch-all classified as 'unknown').
const DOMAIN_TEMPLATES: NodeTemplate[] = ['health', 'training', 'schedule', 'project']
function getInjectionProfile(scope: string, node: NodeMeta | null): InjectionProfile {
  if (scope === 'main') return { tier: 'core', calendar: true, armSummaries: true, vaultScope: 'broad' }
  if (!node) return { tier: 'unknown', calendar: true, armSummaries: false, vaultScope: 'unfiltered' }
  if (node.level === 'hand') return { tier: 'hand', calendar: true, armSummaries: false, vaultScope: 'node' }
  const recognized = DOMAIN_TEMPLATES.includes(node.template)
  return { tier: recognized ? 'arm' : 'unknown', calendar: true, armSummaries: false, vaultScope: recognized ? 'node' : 'unfiltered' }
}

// First sentence (or a 160-char slice) of a primer — used for lightweight gists.
function firstSentence(s: string): string {
  const t = (s || '').trim()
  if (!t) return ''
  const m = t.match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : t).trim().slice(0, 160)
}

// Compact global calendar block — the next 7 days, injected at every Arm/Hand so
// scheduling is available everywhere (the schedule arm already gets this via
// buildLiveBlock, so composeBase skips it there to avoid duplication).
function buildGlobalCalendarBlock(events: CalendarEvent[]): string {
  return `\n\n[CALENDAR — next 7 days]\n${formatEventsForPrimer(events, false)}`
}

// Lightweight Sources index for a Project Hand's primer — filenames + ids only, capped so
// the block stays under ~200 tokens regardless of file count. Never includes file content;
// Spectre pulls a file on demand via a readFile action. Empty string when there are none.
function buildSourcesBlock(files: SourceFile[]): string {
  if (!files.length) return ''
  const shown = files.slice(0, 15)
  const lines = shown.map(f => `• ${f.filename} (id: ${f.id})`)
  const more = files.length > shown.length ? `\n• …and ${files.length - shown.length} more` : ''
  return `\n\n[PROJECT SOURCES]\nThe following reference files are available in this project. You can read any of them when asked:\n${lines.join('\n')}${more}\n\nYou have access to these Sources files. When ${USER} asks you to read, search, or reference a file, return a readFile action with the file id, e.g. {"action": "readFile", "id": "<id>"}. To search across files, read them one at a time and synthesize what you find and in which file.`
}

// Lightweight Notebooks index for a Project Hand's primer — folders + notebooks with ids
// (titles only, never content). Always present for project Hands so Spectre knows it can
// create/read/write documents; `open` carries the currently-open notebook's full markdown.
function buildNotebooksBlock(notebooks: NotebookMeta[], open: { id: string; title: string; markdown: string } | null): string {
  const folders = notebooks.filter(n => n.type === 'folder')
  const loose = notebooks.filter(n => n.type === 'notebook' && !n.parent_id)
  const lines: string[] = []
  for (const f of folders) {
    const kids = notebooks.filter(c => c.type === 'notebook' && c.parent_id === f.id)
    lines.push(`📓 ${f.title} (Notebook, id: ${f.id}, ${kids.length} document${kids.length === 1 ? '' : 's'})`)
    kids.slice(0, 12).forEach(c => lines.push(`   - ${c.title} (Document, id: ${c.id})`))
  }
  loose.forEach(n => lines.push(`📄 ${n.title} (Document, id: ${n.id})`))
  const tree = lines.length ? lines.join('\n') : '(no notebooks yet)'
  // Terminology: a "Notebook" is a container (DB type='folder'); a "Document" is a content
  // page (DB type='notebook'). The action JSON below keeps the literal DB type values.
  const instructions = `This is the LIVE directory of this project's Notebooks and Documents — you always know what exists here without being told. When ${USER} refers to a document by name (even loosely or partially), resolve it against the titles above and use that exact id. NEVER ask ${USER} for a document/file id, and NEVER use an id that isn't listed here or in the [DIAGRAM TREE]. If a name matches nothing here, check the [DIAGRAM TREE] for other projects before saying it doesn't exist.
You have access to this project's Notebooks system. A Document is a page with content; a Notebook is a folder container that holds Documents.
SAVING CONTENT: when asked to save, write up, draft, or document something, emit createDocument with the COMPLETE markdown in "content" — the Document is created with the content already inside it, in one step:
{"action":"createDocument","title":"<short title>","content":"<full markdown — escape newlines as \\n>"}
Optional fields: "parent_id" (an existing Notebook folder id from the tree above) · "node_id" (a different project's node id; defaults to this project).
Never emit createDocument with empty content, and never claim something was saved without emitting the action in that SAME message — the UI answers every save with a "→ Saved …" confirmation line, and a save without the action does not exist.
Other actions: {"action":"createNotebook","title":"…","type":"folder"} — creates an EMPTY Notebook folder only (it cannot hold content; use createDocument for content) · {"action":"readNotebook","id":"…"} — pulls a Document's full content into your context; use it whenever ${USER} asks you to read, check, review, summarize, react to, or give feedback on a document (chain openNotebook after it if they should see the document too) · {"action":"writeToNotebook","id":"<existing Document id>","content":"…markdown…","mode":"append"|"replace"} — adds to a Document that already exists · {"action":"listNotebooks"}.`
  const openBlock = open
    ? `\n\n[OPEN DOCUMENT: "${open.title}"] (id: ${open.id}) — ${USER_CAP} is viewing this document in the editor right now:\n${open.markdown.slice(0, 32000)}`
    : ''
  return `\n\n[NOTEBOOKS IN THIS PROJECT]\nNotebooks (containers) and Documents you can read or create content in:\n${tree}\n\n${instructions}${openBlock}`
}

// Semantic decision guide injected on EVERY turn (all scopes). Tells Spectre which
// navigation/UI action to use based on how the user phrases a request, and how to chain them.
// The action JSON is parsed + sequenced client-side; Spectre never explains it in prose.
const NAV_CONTROL_PRIMER = `[NAVIGATION AND FILE CONTROL]
You control what ${USER} sees on screen. Whenever they ask for something here — however they phrase it — infer the intent and emit the matching action. Resolve loose names against the [DIAGRAM TREE] and the directory blocks in your context yourself; never ask for an id and never invent one; if nothing matches, say what does exist. Every id MUST come from the tree or a directory block. You may emit several action blocks in one reply — they run in order. To act on something in another location, emit navigateTo first ("go back" → navigateTo the first "Recently visited" entry). If a request fits several items, ask which; if it fits none, offer to create it.

navigateTo {"action":"navigateTo","node_id":"<id>","node_name":"<name>"} — go to / open / switch to an arm or project.
openNotebook {"action":"openNotebook","id":"<id>","mode":"view"|"edit"} — show a document ("view") or open it to write in ("edit").
openFile {"action":"openFile","id":"<id>"} — show a source file (PDF, image, etc.).
readNotebook {"action":"readNotebook","id":"<id>"} / readFile {"action":"readFile","id":"<id>"} — pull a document's or file's content into your context to read, summarize, check, review, or react to it. No UI change; once it arrives, respond substantively. Chain openNotebook/openFile to also show it on screen.
createDocument {"action":"createDocument","title":"…","content":"<full markdown>","node_id"?:"<project node id>"} — any intent to save, keep, note, or write up content. Creates a NEW Document with the content already inside, in one step. Infer the title yourself; documents live in a project's Notebooks panel, so include node_id of the best-fitting project when you aren't inside one. Never claim content was saved unless this action is in the same reply.
writeToNotebook {"action":"writeToNotebook","id":"<id>","content":"…","mode":"append"|"replace"} — add to an EXISTING document; follow with openNotebook(mode:"view").
openSession {"action":"openSession","mode":"new"|"recent"|"specific","session_id"?:"<id>","node_id"?:"<id>"} — open a new / most-recent / specific chat. (navigateTo already opens the most recent at its destination, so use this only for a new or specific one.)
searchSessions {"action":"searchSessions","query":"<topic>","node_id"?:"<id>","open_result":true} — when they name an existing conversation by topic. Opens the best match (and falls back to the most recent if none), so use it liberally; node_id defaults to the current location.
searchVault {"action":"searchVault","query":"<topic>","node_id"?:"<id>","limit"?:8} — explicit semantic search across their notes + Source files when they ask to search their vault / notes / knowledge base. Results return to you to present; node_id scopes it to one project, otherwise everything.`

// Mirror of lib/vault.ts's VaultResult (that module is server-only — fs imports — so we
// keep a local shape here rather than importing across the server/client boundary).
type VaultResult = { text: string; title: string; source_type: string; node_id: string; score: number; path: string }

const PROJECT_PRIMERS: Record<string, string> = {
  'project-diagram': `${USER_CAP} has opened The Diagram project — this personal AI operating system. Focus on build decisions, technical architecture, and next steps.`,
  'project-lab': `${USER_CAP} has opened the Research project — an example research project. Focus on experimental results, data analysis, and research direction.`,
  'project-build': `${USER_CAP} has opened the Side Project — an example build project. Focus on component selection, design decisions, and build planning.`,
}

const FOLDER_LABELS: Record<FolderId, string> = {
  main: 'SPECTRE',
  schedule: 'SCHEDULE',
  body: 'BODY STATS',
  projects: 'PROJECTS',
  training: 'TRAINING',
}

const EMPTY_MESSAGES: Record<string, Message[]> = {
  main: [], schedule: [], body: [], projects: [], training: [],
}

const EMPTY_PROJECT_MESSAGES: Record<string, Message[]> = {
  'project-diagram': [],
  'project-lab': [],
  'project-build': [],
}

const MODE_CONFIG = {
  Orderly: {
    accent: '#0EA5E9',
    glow: 'rgba(14,165,233,0.35)',
    border: 'rgba(14,165,233,0.18)',
    dim: 'rgba(14,165,233,0.08)',
    tag: 'Structured · Focused · Precise',
  },
  Creative: {
    accent: '#A855F7',
    glow: 'rgba(168,85,247,0.35)',
    border: 'rgba(168,85,247,0.18)',
    dim: 'rgba(168,85,247,0.08)',
    tag: 'Generative · Fluid · Exploratory',
  },
  Abstract: {
    accent: '#10B981',
    glow: 'rgba(16,185,129,0.35)',
    border: 'rgba(16,185,129,0.18)',
    dim: 'rgba(16,185,129,0.08)',
    tag: 'Intuitive · Emergent · Holistic',
  },
}

// ── Initial data ────────────────────────────────────────────

const INITIAL_BODY_STATS: BodyStat[] = [
  { label: 'Sleep', value: 87, unit: '%', bar: true, context: '7h 20m total · 1h 45m deep · within optimal range' },
  { label: 'Readiness', value: 91, unit: '%', bar: true, context: 'High — body primed for training or cognitive load' },
  { label: 'HRV', value: 68, unit: 'ms', bar: false, context: 'Elevated · parasympathetic dominance · recovery running' },
  { label: 'Recovery', value: 79, unit: '%', bar: true, context: 'Good · minor residual fatigue from yesterday\'s session' },
]

const INITIAL_PROJECTS: Project[] = [
  {
    id: 'diagram', name: 'The Diagram', sub: 'Personal OS', progress: 0,
    phase: 'Active',
    description: 'This personal AI operating system — chat, memory, voice, and the dashboard itself.',
  },
  {
    id: 'lab', name: 'Research', sub: 'Example research project', progress: 0,
    phase: 'Active',
    description: 'An example research project — rename it or replace it with your own. Track experiments, data, and next steps here.',
  },
  {
    id: 'build', name: 'Side Project', sub: 'Example build project', progress: 0,
    phase: 'Planning',
    description: 'An example build project — rename it or replace it with your own. Component sourcing, design, and build planning.',
  },
]


// The three seeded projects exist in two stores that must stay in lockstep: the legacy
// `projects` array (drives the ProjectDetail panel + the dashboard/arm primers) and the
// `nodes` tree (drives the ExpandedProjects cards, persisted in diagram_nodes). The node
// row is the source of truth; `projects` is mirrored from it on load and on every edit so
// updateNode / updateProgress / updateProject / the sliders never leave a view stale.
const LEGACY_TO_NODE_ID: Record<string, string> = { diagram: 'project-diagram', lab: 'project-lab', build: 'project-build' }
const NODE_TO_LEGACY_ID: Record<string, string> = { 'project-diagram': 'diagram', 'project-lab': 'lab', 'project-build': 'build' }

// ── Utilities ────────────────────────────────────────────────

function fuzzyMatchProjectId(raw: string): string | null {
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (n.includes('diagram')) return 'diagram'
  if (n.includes('lab') || n.includes('research')) return 'lab'
  if (n.includes('build') || n.includes('side')) return 'build'
  return null
}

// Walks one {"action":...} block from `start`, tracking JSON string state so braces
// inside string values (markdown content, code snippets) never truncate the block.
// Returns the index of the closing brace, or -1 if the block is incomplete.
function scanActionBlock(text: string, start: number): number {
  let depth = 0; let inStr = false; let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

// Parses an action block leniently. Strict JSON first; on failure, repair the one
// systematic model mistake — raw control characters (real newlines/tabs) inside string
// values, common when a long markdown "content" rides in the JSON — and re-parse.
// Returns null only when genuinely unparseable (logged by the caller, never silent).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseActionJson(raw: string): Record<string, any> | null {
  try { return JSON.parse(raw) } catch { /* fall through to repair */ }
  let repaired = ''; let inStr = false; let esc = false
  for (const ch of raw) {
    if (inStr && !esc && (ch === '\n' || ch === '\r' || ch === '\t')) {
      repaired += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'
      continue
    }
    if (esc) esc = false
    else if (ch === '\\') esc = true
    else if (ch === '"') inStr = !inStr
    repaired += ch
  }
  try {
    const parsed = JSON.parse(repaired)
    console.warn('[Spectre] action JSON repaired (raw control chars inside strings)')
    return parsed
  } catch {
    return null
  }
}

// Locate the next action block start. Tolerates pretty-printed JSON — models (gpt-oss
// especially) sometimes write the action as indented JSON in a ```json fence instead of
// the compact form, e.g. `{\n  "action": "writeToNotebook", …`. A strict indexOf
//('{"action"') missed those entirely: raw JSON rendered in the bubble AND the action
// never executed (the Lesson-plan loss on 2026-06-11).
const ACTION_START_RE = /\{\s*"action"\s*:/
function findActionStart(text: string, from = 0): number {
  const idx = text.slice(from).search(ACTION_START_RE)
  return idx === -1 ? -1 : from + idx
}
// After removing a fenced action block, an empty ```json``` shell can remain — drop it.
function dropEmptyFences(text: string): string {
  return text.replace(/```(?:json)?\s*```/gi, '')
}

// Strips all complete {"action":...} blocks and any trailing partial block.
// Used during streaming so JSON never appears in chat bubbles.
function stripJsonForDisplay(text: string): string {
  let result = text
  while (true) {
    const start = findActionStart(result)
    if (start === -1) break
    const end = scanActionBlock(result, start)
    if (end === -1) { result = result.slice(0, start).trimEnd(); break }
    result = result.slice(0, start) + result.slice(end + 1)
  }
  result = dropEmptyFences(result)
  // Streaming guard: an action block arrives character-by-character, so a trailing
  // fragment that is only a *prefix* of `{"action"` (e.g. `{`, `{"`, `{"acti`) reaches
  // the bubble for a few frames before the loop above can detect the full token — strip
  // that partial prefix so the raw `{"` never flashes. (The final render uses
  // extractAllSpectreActions' cleanText, so this only affects in-flight streaming frames.)
  const PREFIX = '{"action"'
  for (let n = Math.min(PREFIX.length - 1, result.length); n >= 1; n--) {
    if (result.slice(-n) === PREFIX.slice(0, n)) { result = result.slice(0, -n).trimEnd(); break }
  }
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

// Extracts ALL {"action":...} JSON blocks from text after streaming completes.
// Returns cleanText with every block removed, and array of parsed action objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAllSpectreActions(text: string): { cleanText: string; actions: Record<string, any>[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: Record<string, any>[] = []
  let result = text
  while (true) {
    const start = findActionStart(result)
    if (start === -1) break
    const end = scanActionBlock(result, start)
    if (end === -1) { result = result.slice(0, start).trimEnd(); break }
    const parsed = parseActionJson(result.slice(start, end + 1))
    if (parsed?.action) {
      // Dedupe create actions by title+target within one response — local models sometimes
      // emit the same tool call twice, which would save two copies of the document.
      const isCreate = parsed.action === 'createDocument' || parsed.action === 'createNotebook'
      const dup = isCreate && actions.some(a =>
        (a.action === 'createDocument' || a.action === 'createNotebook')
        && String(a.title ?? '') === String(parsed.title ?? '')
        && String(a.node_id ?? '') === String(parsed.node_id ?? ''))
      if (dup) console.warn('[Spectre] duplicate create action dropped:', parsed.title)
      else actions.push(parsed)
    }
    // A dropped block is loud, not silent — content-bearing actions are too costly to lose.
    else console.error('[Spectre] unparseable action block dropped:', result.slice(start, start + 300))
    result = result.slice(0, start) + result.slice(end + 1)
  }
  return { cleanText: dropEmptyFences(result).replace(/\n{3,}/g, '\n\n').trim(), actions }
}

// ── Save-intent intelligence (Docu-scape thought-catching) ──────────────────
// Three layers, each costing tokens only when it earns them:
//  1. the always-on NAV_CONTROL_PRIMER paragraph states the PRINCIPLE (any keep/note/
//     remember phrasing → createDocument, title inferred, never ask);
//  2. detectSaveIntent() below gates a ~50-token [SAVE INTENT DETECTED] nudge appended
//     to THAT turn's primer only — the just-in-time reliability lever for gpt-oss;
//  3. isSubstantialContent() drives the zero-token proactive save chip (saveOffer).

// Deterministic save-intent gate for the conditional micro-primer. Errs broad — a false
// positive costs ~50 conditional-phrased tokens the model can ignore; a false negative
// still has Layer 1. Covers keep/save/note/jot/capture/store/write-up/doc phrasings.
const SAVE_INTENT_RE = new RegExp(
  [
    /\b(save|keep|store|preserve|capture|jot|archive)\b/.source,
    /\b(note|write)\s+(this|that|it)?\s*(down|up)\b/.source,
    /\bmake\s+(me\s+)?(a\s+)?(note|doc|document)\b/.source,
    /\b(take|leave)\s+a\s+note\b/.source,
    /\bnote\s+(this|that)\b/.source,
    /\bdocument\s+(this|that|it)\b/.source,
    /\bwrite\s+(me\s+)?(a|an)\s+(doc|document|note|guide|plan|summary|writeup|write-up)\b/.source,
    /\bput\s+(this|that|it)\s+(in|into)\b/.source,
    /\badd\s+(this|that|it)\s+to\b/.source,
    /\b(remember|hold\s+on\s*to)\s+(this|that)\b/.source,
    /\bnotebooks?\b/.source,
    /\bdocu-?scape\b/.source,
  ].join('|'),
  'i',
)
function detectSaveIntent(text: string): boolean {
  return SAVE_INTENT_RE.test(text)
}

// The conditional micro-primer (Layer 2). Appended after composeBase + vault context on
// intent turns only — never part of the standing prompt.
const SAVE_INTENT_BLOCK = `

[SAVE INTENT DETECTED]
The user's message likely asks to save/keep/note content (theirs or yours from this conversation). If so, emit createDocument NOW in this same reply: the full markdown in "content", a short title you infer yourself (never ask for one), and node_id of the best-fitting project from the [DIAGRAM TREE] if you are not already inside one. Confirm in one short sentence.`

// Title inference for the proactive chip: first markdown heading, else first non-empty
// line, cleaned of markdown tokens and clamped.
function inferDocTitle(md: string): string {
  const lines = md.split('\n').map(l => l.trim()).filter(Boolean)
  const heading = lines.find(l => /^#{1,3}\s+\S/.test(l))
  const raw = (heading ?? lines[0] ?? 'Untitled').replace(/^#{1,6}\s+/, '').replace(/[*_`>]/g, '').trim()
  const clamped = raw.length > 64 ? raw.slice(0, 64).replace(/\s+\S*$/, '') : raw
  return clamped || 'Untitled'
}

// "Worth offering to save": long enough to be a real artifact, or moderately long with
// document-like structure (headings / lists / code / tables). Pure text heuristic — the
// proactive chip costs zero tokens, so this only tunes signal-to-noise.
function isSubstantialContent(md: string): boolean {
  const t = md.trim()
  if (t.length >= 1200) return true
  if (t.length < 500) return false
  const headings = (t.match(/^#{1,4}\s+\S/gm) ?? []).length
  const bullets = (t.match(/^\s*([-*+]|\d+[.)])\s+\S/gm) ?? []).length
  const hasCode = /```/.test(t)
  const tableRows = (t.match(/^\|.+\|$/gm) ?? []).length
  return headings >= 2 || bullets >= 5 || hasCode || tableRows >= 2
}

// When a local model returns only a JSON action block with no prose, synthesize a
// one-line confirmation so the response bubble is never empty.
// Module-level twin of MapOverlay's describeAction — for the root-level Secretary
// proposal pop-out (which can't reach the overlay's local closure).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeSecretaryAction(a: any): string {
  const rel = a.step_relation ? ` (${a.step_relation}${a.anchor_title ? ` "${a.anchor_title}"` : ''})` : ''
  if (a.op === 'create') return `Add "${a.title}"${rel}${a.phase ? ` · phase ${a.phase}` : ''}`
  if (a.op === 'move') return `Move a task${rel}`
  if (a.op === 'delete') return `Delete a task`
  if (a.op === 'merge') return `Merge ${(a.task_ids || []).length} tasks → "${a.into_title}"`
  if (a.op === 'set_phase') return `Label ${(a.task_ids || []).length} tasks · phase ${a.phase}`
  return String(a.op ?? 'change')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeActions(actions: Record<string, any>[]): string {
  if (!actions.length) return ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = actions.map((a: Record<string, any>) => {
    switch (a.action) {
      case 'updateProgress': return `Progress updated.`
      case 'updateProject':  return `Project updated.`
      case 'updateNode':     return `Project updated.`
      case 'calendarSync':   return a.op === 'delete' ? `Event removed from your calendar.` : a.op === 'update' ? `Calendar event updated.` : `Event added to your calendar.`
      case 'updateWorkout':
      case 'updateTraining': return `Workout updated.`
      case 'logSet':         return `Logged that set.`
      case 'reorderBlocks':  return `Reordered the exercises.`
      case 'setRest':        return `Rest timer updated.`
      case 'readFile':       return `Reading the file…`
      case 'readNotebook':   return `Reading the document…`
      case 'listNotebooks':  return `Checking the notebooks…`
      case 'searchVault':    return `Searching the vault…`
      case 'openNotebook':   return `Opening it now.`
      case 'openFile':       return `Opening the file.`
      case 'navigateTo':     return `Opening ${a.node_name ?? 'it'}.`
      case 'openSession':    return `Opening the conversation.`
      case 'searchSessions': return `Looking for that conversation…`
      case 'deepResearch':   return `Setting up deep research…`
      case 'createDocument': return `Saving "${a.title ?? 'document'}"…`
      case 'createNotebook': return a.type === 'folder' && !a.content ? `Creating "${a.title ?? 'notebook'}"…` : `Saving "${a.title ?? 'document'}"…`
      case 'writeToNotebook': return `Writing to the document…`
      default:               return `Done.`
    }
  })
  return lines.join(' ')
}

// Actions whose RESULT the client fetches + re-injects (drained after the stream). When a
// reply contains one of these, the turn isn't done — it's an intermediate "I'm looking at X"
// step. We surface a silent status indicator (not a chat bubble) and let the drain produce
// the real answer, instead of persisting a "Reading the file…" filler turn.
const DRAIN_ACTION_NAMES = new Set(['readFile', 'readNotebook', 'listNotebooks', 'searchVault'])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drainStatusFor(actions: Record<string, any>[]): { kind: 'reading' | 'vault'; label: string } | null {
  const a = actions.find(x => DRAIN_ACTION_NAMES.has(x.action))
  if (!a) return null
  switch (a.action) {
    case 'readFile':      return { kind: 'reading', label: 'Reading the file' }
    case 'readNotebook':  return { kind: 'reading', label: 'Reading the document' }
    case 'listNotebooks': return { kind: 'reading', label: 'Checking the notebooks' }
    case 'searchVault':   return { kind: 'vault', label: `Searching the vault${a.query ? ` for “${String(a.query).slice(0, 40)}”` : ''}` }
    default:              return null
  }
}

// ── Voice activity detection tuning (RMS of float time-domain, ~0..1) ──────
const SPEECH_THRESHOLD = 0.018   // level above which we consider the user speaking
const SILENCE_THRESHOLD = 0.012  // level below which we count toward end-of-turn silence
const SILENCE_MS = 1000          // sustained silence after speech → auto-stop & send. Was 2000ms,
                                 // which added ~1s of dead air to EVERY turn before STT even started
                                 // (the biggest single STT-side latency source). 1000ms keeps a safe
                                 // margin against cutting off slower/pausing speech; tune on-device.
const NO_SPEECH_MS = 8000        // never spoke → abandon the turn, return to idle
// There is intentionally NO hard cap on a single utterance — a turn ends only on
// sustained silence, so a long thought is never cut off mid-sentence. (Previously a
// 30 s MAX_RECORD_MS cap would force-stop and transcribe while the user was still
// talking; that has been removed.)
// ── Barge-in (language-gated) — DISABLED ───────────────────────────────────
// Voice is now fully TURN-BASED: the mic is physically closed for the entire SPEAKING
// state, and the ONLY way to interrupt Spectre mid-speech is a manual button click. The
// analyser-driven barge-in below (energy gate + isDecipherableSpeech capture during
// playback) was hallucinating phantom user turns on near-silence/ambient audio, so it is
// gated off behind this single flag. Flip BARGE_IN_ENABLED back to true to restore it —
// no other change is required (the analyser loop, helpers, and thresholds are all intact).
const BARGE_IN_ENABLED: boolean = false
const BARGE_SPEECH_THRESHOLD = 0.06  // mic energy during playback that suggests real speech — kept high so echo-cancelled TTS bleed doesn't self-trigger a capture
const BARGE_MIN_MS = 350             // minimum speech duration worth transcribing (ignores blips)
const BARGE_END_SILENCE_MS = 700     // pause after the interruption → finalize & transcribe it
const BARGE_MAX_PROBE_MS = 8000      // safety: finalize a very long interruption capture

// Whisper tends to hallucinate these short phrases from silence/noise — never treat
// them as a real interruption.
const WHISPER_NOISE_OUTPUTS = new Set([
  'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'bye', 'bye.', 'um', 'uh', 'hmm', 'mm', 'so', '.', '..', '...', 'okay', 'ok',
])

// FIX 1 — after the TTS playback queue fully drains, keep the mic hard-closed this long
// before reopening passive listening, so the audio tail / room reverb can't be captured.
const MIC_REOPEN_COOLDOWN_MS = 350

// Secondary defense against phantom turns: Groq Whisper hallucinates these short tokens
// from near-silence. A transcript UNDER 4 words that exactly matches one of these is
// discarded silently — it never fires a turn (and so never reaches Mem0 / Qdrant).
const HALLUCINATION_TOKENS = new Set([
  'okay', 'yeah', 'yes', 'bye', 'thank you', 'hmm', 'alright', 'sure', 'right', 'uh huh',
])
function isHallucinatedTranscript(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim()
  if (!norm) return true
  const wordCount = norm.split(/\s+/).filter(Boolean).length
  if (wordCount >= 4) return false
  return HALLUCINATION_TOKENS.has(norm)
}

// Short status label for the mini (PiP) voice orb's emotional/phase state.
function voicePhaseLabel(p: VoicePhase): string {
  switch (p) {
    case 'listening':     return 'LISTENING…'
    case 'transcribing':  return 'TRANSCRIBING…'
    case 'thinking':      return 'THINKING…'
    case 'speaking':      return 'SPEAKING…'
    case 'reconfiguring': return 'RECONFIGURING…'
    default:              return 'STANDBY'
  }
}

// Decides whether a barge-in capture is real speech (a genuine interruption) vs noise.
// Requires at least one word with two or more letters, a minimum length, and that the
// whole thing isn't a known Whisper noise artifact.
function isDecipherableSpeech(text: string): boolean {
  const raw = text.trim().toLowerCase()
  if (raw.length < 2) return false
  if (WHISPER_NOISE_OUTPUTS.has(raw)) return false
  const cleaned = raw.replace(/[^a-z0-9'\s]/g, ' ').trim()
  if (cleaned.length < 2) return false
  const words = cleaned.split(/\s+/).filter(w => /[a-z]{2,}/.test(w))
  return words.length >= 1
}

// Picks a MediaRecorder mime type the browser actually supports.
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  for (const t of types) {
    try { if (MediaRecorder.isTypeSupported(t)) return t } catch { /* ignore */ }
  }
  return undefined
}

// Strips <think>…</think> (qwen3 with think:false sometimes still emits these) before TTS.
function stripThinkingTokens(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}

// ── Voice sentence-packet tuning ────────────────────────────────────────────────
const SENTENCE_MIN_CHARS = 20    // below this, buffer the fragment with the next sentence
const SENTENCE_MAX_CHARS = 300   // above this, split one sentence at a clause boundary
const CODE_BLOCK_SPOKEN = '[code block displayed above]'   // said in place of fenced code

// Abbreviations whose trailing period must NOT be read as a sentence end.
const TTS_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
  'no', 'dept', 'fig', 'inc', 'ltd', 'co', 'approx', 'col', 'gen', 'rev', 'gov',
  'sen', 'rep', 'mt', 'ave', 'blvd', 'ph', 'al',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

// True when the period at `periodIdx` belongs to an abbreviation (Mr. e.g. i.e.) or a
// single initial (J.) rather than ending a sentence. Decimals (3.14) never reach here —
// the boundary regex only matches a period followed by whitespace/end.
function isAbbreviationDot(text: string, periodIdx: number): boolean {
  let i = periodIdx - 1
  let token = ''
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) { token = text[i] + token; i-- }
  const word = token.replace(/\./g, '').toLowerCase()
  if (word.length === 0) return false
  if (word.length === 1) return true          // initial ("J.") or the "g" of "e.g."
  return TTS_ABBREVIATIONS.has(word)
}

// Breaks an over-long sentence into ≤max pieces at the nearest clause boundary
// (comma/semicolon/colon/dash) before the cap, falling back to a word boundary.
function splitLongClause(sentence: string, max = SENTENCE_MAX_CHARS): string[] {
  const out: string[] = []
  let rest = sentence.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '))
    if (cut > max * 0.4) cut += 1                       // keep the punctuation, drop its space
    else { const sp = window.lastIndexOf(' '); cut = sp > 0 ? sp : max }
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

// Extracts complete sentences from `text` starting at `fromIdx`, ready for TTS.
// Rules: emit on . ! ? … followed by whitespace/end; never split on abbreviations or
// decimals; buffer fragments under SENTENCE_MIN_CHARS into the next sentence; cap each
// packet at SENTENCE_MAX_CHARS (split at a clause boundary); skip fenced code blocks
// entirely, speaking CODE_BLOCK_SPOKEN once instead. A 200-char force-flush keeps long
// boundary-less stretches from starving the queue. `newIdx` is the resume cursor.
function extractSentences(text: string, fromIdx: number): { sentences: string[]; newIdx: number } {
  const out: string[] = []
  const push = (chunk: string) => { for (const s of splitLongClause(chunk.trim())) if (s) out.push(s) }
  let pos = fromIdx                       // start of the not-yet-emitted region

  while (pos < text.length) {
    const fence = text.indexOf('```', pos)
    const proseEnd = fence === -1 ? text.length : fence
    // Sentence-split the prose in [pos, proseEnd).
    const re = /[.!?…]+(?=\s|$)|\n{2,}/g
    re.lastIndex = pos
    let lastEnd = pos
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null && m.index < proseEnd) {
      if (m[0] === '.' && isAbbreviationDot(text, m.index)) continue
      const end = m.index + m[0].length
      const chunk = text.slice(lastEnd, end)
      if (chunk.trim().length < SENTENCE_MIN_CHARS) continue   // too short — buffer with next
      push(chunk)
      lastEnd = end
    }

    if (fence === -1) {
      // No code ahead: force-flush a long boundary-less tail so TTS doesn't starve.
      const pending = text.slice(lastEnd)
      if (pending.length >= 200) {
        const cutAt = pending.lastIndexOf(' ', 200)
        const cut = cutAt > 50 ? cutAt + 1 : 200
        push(pending.slice(0, cut))
        lastEnd += cut
      }
      return { sentences: out, newIdx: lastEnd }
    }

    const close = text.indexOf('```', fence + 3)
    if (close === -1) {
      // Unclosed fence (still streaming): flush complete prose before it, then wait.
      const pre = text.slice(lastEnd, fence).trim()
      if (pre.length >= SENTENCE_MIN_CHARS) { push(pre); lastEnd = fence }
      return { sentences: out, newIdx: lastEnd }
    }
    // Closed code block: flush prose before it, announce the block, skip past it.
    const pre = text.slice(lastEnd, fence).trim()
    if (pre.length > 0) push(pre)
    out.push(CODE_BLOCK_SPOKEN)
    pos = close + 3
  }
  return { sentences: out, newIdx: pos }
}

// Hidden instruction that makes Spectre greet on voice-mode entry. Sent as the user
// turn but never shown — only Spectre's spoken reply appears.
const VOICE_GREETING_PROMPT =
  `[${USER_CAP} just opened voice mode by tapping the orb. Greet them in one short, natural spoken sentence and invite them to speak — something like "Online. What do you need?". Keep it to a single sentence. No lists, no markdown.]`

// A tiny silent WAV data URI, generated deterministically. Played once inside the
// orb-click gesture to unlock HTMLAudioElement playback on mobile Safari, so the
// greeting (and every later sentence) can autoplay without a tap.
function silentWavDataUri(): string {
  const sampleRate = 8000, numSamples = 80, dataSize = numSamples
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
  w(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); w(8, 'WAVE')
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  w(36, 'data'); view.setUint32(40, dataSize, true)
  for (let i = 0; i < dataSize; i++) view.setUint8(44 + i, 128) // 8-bit silence
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return 'data:audio/wav;base64,' + btoa(bin)
}

const PANEL = 'rgba(8,12,30,0.88)'

// V4 dashboard-canvas helpers (maximalist grid). `Box` = a grid-area panel (className
// lab-box, styled by the scoped <style> rendered inside the dashboard); `spark` = a tiny
// sparkline. Top-level so the giant render closure stays lean.
type DashIcon = React.ComponentType<{ size?: number; color?: string; stroke?: number }>
// `headerRight` puts live controls in the header strip instead of a static `tag` pill — used by
// the enlarged-notepad view, which reuses this one header row for the pad's title + its controls
// rather than stacking a second header inside the body (in a one-row grid cell that second row
// costs about half the readable content).
function Box({ area, accent, icon: Icon, label, tag, big, onClick, headerRight, children }: { area: string; accent: string; icon: DashIcon; label: string; tag?: string; big?: boolean; onClick?: () => void; headerRight?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="lab-box" data-area={area} onClick={onClick} style={{ gridArea: area, padding: big ? '14px 16px' : '11px 13px', cursor: onClick ? 'pointer' : 'default', '--accent': accent } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: big ? '11px' : '8px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
          <Icon size={big ? 15 : 13} color={accent} stroke={1.7} />
          <span style={{ fontSize: big ? '10px' : '9px', letterSpacing: '0.16em', color: accent, fontWeight: 700, textShadow: `0 0 9px ${accent}55`, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        </span>
        {headerRight}
        {tag && !headerRight && <span style={{ fontSize: '8px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.4)', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '4px', padding: '1px 5px' }}>{tag}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
    </section>
  )
}
function spark(data: number[], accent: string) {
  return <span style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '16px' }}>{data.map((v, i) => <span key={i} style={{ width: '3px', height: `${v}%`, background: accent, borderRadius: '1px', opacity: 0.85 }} />)}</span>
}

// Sentinel the API streams when a web search starts (must match SEARCH_MARKER in
// app/api/spectre/route.ts). Stripped from all display/TTS; toggles the indicator.
const SEARCH_MARKER = '[[SPECTRE_SEARCH]]'

export default function Home() {
  const [mode, setMode] = useState<Mode>('Orderly')
  const [ttsMode, setTtsMode] = useState<TtsMode>('cloud') // Cartesia primary (Plan A: free GPU VRAM for gpt-oss; local Chatterbox via VOICE=LOCAL toggle)
  // Streaming TTS (Cartesia SSE → Web Audio): first audio at ~265ms vs ~975ms for the buffered
  // /tts/bytes path (benchmarked). Opt-in (persisted diagram_tts_streaming) until verified to sound
  // smooth on the target device; the buffered path stays the default + automatic fallback.
  const [ttsStreaming, setTtsStreaming] = useState(false)
  // Scribe — the chronicle. `scribeEntries` newest-first; `scribeLatest` feeds the ribbon; the
  // Chronicle overlay opens from the ribbon. Mirrors ScribeEntryRow (server type not imported client-side).
  type ScribeEntry = { id: string; date: string; status: 'live' | 'final'; title: string; narrative: string; themes: string; source_count: number; updated_at: number }
  const [scribeEntries, setScribeEntries] = useState<ScribeEntry[]>([])
  const [scribeLatest, setScribeLatest] = useState<ScribeEntry | null>(null)
  const [scribeOpen, setScribeOpen] = useState(false)
  // Rhythm wind-down: the evening interception. 'card' = the offer,
  // 'chip' = deferred-to-boundary (a quiet moon in the corner, zero re-pings — the user comes to it).
  const [windDownOpen, setWindDownOpen] = useState(false)
  const [windDownOffer, setWindDownOffer] = useState<'card' | 'chip' | null>(null)
  const windDownOpenRef = useRef(false)
  useEffect(() => { windDownOpenRef.current = windDownOpen }, [windDownOpen])
  // Curated For You — the real morning read (lib/news.ts; compiled server-side on the local
  // model each morning). Brief bounded re-poll while a compile is in flight.
  const [morningNews, setMorningNews] = useState<{ status: string; items: { title: string; summary: string; source: string; url: string; topic?: string }[]; morning_note: string } | null>(null)
  const newsPollRef = useRef(0)
  const loadNews = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/news${refresh ? '?refresh=1' : ''}`)
      const data = await res.json()
      setMorningNews(data)
      if (data?.status === 'compiling' && newsPollRef.current < 5) {
        newsPollRef.current += 1
        setTimeout(() => { void loadNews() }, 75_000)
      }
    } catch { /* the box shows its resting state */ }
  }, [])
  useEffect(() => { void loadNews() }, [loadNews])
  // ── Main-page live sections (everything on the main page has a purpose) — habits,
  //    focus timer, notepads, inbox. All deterministic reads; no LLM. ──
  const [habitsData, setHabitsData] = useState<{ habits: { id: string; name: string; target_per_week: number }[]; checks: { habit_id: string; date: string }[]; streaks: Record<string, number> }>({ habits: [], checks: [], streaks: {} })
  const loadHabits = useCallback(async () => {
    try { const r = await fetch('/api/habits'); const d = await r.json(); setHabitsData({ habits: d.habits ?? [], checks: d.checks ?? [], streaks: d.streaks ?? {} }) } catch { /* resting state */ }
  }, [])
  const [newHabit, setNewHabit] = useState('')
  const toggleHabit = useCallback(async (id: string, checked: boolean) => {
    const today = localDateStr(Date.now())
    setHabitsData(d => ({ ...d, checks: checked ? [...d.checks, { habit_id: id, date: today }] : d.checks.filter(c => !(c.habit_id === id && c.date === today)) }))
    try {
      await fetch('/api/habits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: checked ? 'check' : 'uncheck', id }) })
      void loadHabits()
    } catch { /* optimistic state stands; next load reconciles */ }
  }, [loadHabits])
  type FocusSession = { id: string; label: string; started_at: number; ended_at: number | null; task_id?: string }
  const [focusData, setFocusData] = useState<{ open: FocusSession | null; today_total_ms: number; sessions: FocusSession[] }>({ open: null, today_total_ms: 0, sessions: [] })
  const [focusLabel, setFocusLabel] = useState('')
  const loadFocus = useCallback(async () => { try { const r = await fetch('/api/focus'); const d = await r.json(); setFocusData({ open: d.open ?? null, today_total_ms: d.today_total_ms ?? 0, sessions: d.sessions ?? [] }) } catch { /* resting */ } }, [])
  const focusPost = useCallback(async (op: string, label?: string, taskId?: string) => {
    try { const r = await fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, label, task_id: taskId }) }); const d = await r.json(); setFocusData({ open: d.open ?? null, today_total_ms: d.today_total_ms ?? 0, sessions: d.sessions ?? [] }) } catch { /* next load reconciles */ }
  }, [])
  // The running clock must repaint every second — the header clock's state only changes
  // once a MINUTE (hh:mm), so React bails out on identical strings and nothing re-renders
  // in between (the "timer stays at 0:00" bug). A dedicated 1s tick while a session is open.
  const [, setFocusTick] = useState(0)
  useEffect(() => {
    if (!focusData.open) return
    const id = setInterval(() => setFocusTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [focusData.open])
  const [notepads, setNotepads] = useState<{ id: string; title: string; content: string }[]>([])
  const notepadsRef = useRef<{ id: string; title: string; content: string }[]>([])
  useEffect(() => { notepadsRef.current = notepads }, [notepads])
  const [openNotepadId, setOpenNotepadId] = useState<string | null>(null)
  // ENLARGED NOTEPAD — one pad promoted to fill the whole NOTEPADS box, so a list the user is
  // actively working from (groceries, a build checklist) stays readable at a glance instead
  // of collapsing to a chip. It's a persistent view state, not a mode: it survives reloads
  // (localStorage) and holds until they collapse it back to the list.
  const [expandedNotepadId, setExpandedNotepadId] = useState<string | null>(null)
  useEffect(() => { try { const v = localStorage.getItem('diagram_notepad_expanded'); if (v) setExpandedNotepadId(v) } catch { /* no storage — starts as the list */ } }, [])
  const toggleNotepadExpanded = useCallback((id: string | null) => {
    setExpandedNotepadId(prev => {
      const next = prev === id ? null : id
      try { if (next) localStorage.setItem('diagram_notepad_expanded', next); else localStorage.removeItem('diagram_notepad_expanded') } catch { /* view state only */ }
      return next
    })
  }, [])
  // The enlarged pad was archived (here or on another device) → drop back to the list rather
  // than leaving a stale id pinned. Only once pads have actually loaded.
  useEffect(() => {
    if (!expandedNotepadId || !notepads.length) return
    if (!notepads.some(n => n.id === expandedNotepadId)) {
      setExpandedNotepadId(null)
      try { localStorage.removeItem('diagram_notepad_expanded') } catch { /* view state only */ }
    }
  }, [notepads, expandedNotepadId])
  // Full-page views: Tasks (with completed history + note categories) and Notepads.
  const [tasksFullOpen, setTasksFullOpen] = useState(false)
  const [notepadsFullOpen, setNotepadsFullOpen] = useState(false)
  const loadNotepads = useCallback(async () => { try { const r = await fetch('/api/notepads'); const d = await r.json(); setNotepads(d.notepads ?? []) } catch { /* resting */ } }, [])
  const notepadSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notepadDirty, setNotepadDirty] = useState(false)
  // The save itself — full current row, so interleaved title/content edits never drop.
  const saveNotepadNow = useCallback(async (id: string) => {
    if (notepadSaveTimer.current) { clearTimeout(notepadSaveTimer.current); notepadSaveTimer.current = null }
    const cur = notepadsRef.current.find(n => n.id === id)
    if (!cur) return
    try {
      await fetch('/api/notepads', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: cur.title, content: cur.content }) })
      setNotepadDirty(false)
    } catch { /* still dirty; the next edit or close retries */ }
  }, [])
  const patchNotepadLocal = useCallback((id: string, patch: { title?: string; content?: string }) => {
    setNotepads(ns => ns.map(n => (n.id === id ? { ...n, ...patch } : n)))
    setNotepadDirty(true)
    if (notepadSaveTimer.current) clearTimeout(notepadSaveTimer.current)
    notepadSaveTimer.current = setTimeout(() => { void saveNotepadNow(id) }, 500)
  }, [saveNotepadNow])
  const [inboxData, setInboxData] = useState<{ events: { id: string; kind: string; title: string; body: string; created_at: number; read_at: number | null }[]; unread: number }>({ events: [], unread: 0 })
  const [bellOpen, setBellOpen] = useState(false)   // the top-bar notifications dropdown
  const loadInbox = useCallback(async () => { try { const r = await fetch('/api/inbox'); const d = await r.json(); setInboxData({ events: d.events ?? [], unread: d.unread ?? 0 }) } catch { /* resting */ } }, [])
  // ── Secretary proposals pop-out: review lands wherever the user IS — never requires
  //    reopening the map. Slim root twin of the MapOverlay review, against the same API. ──
  const [secPop, setSecPop] = useState<{ nodeId: string; nodeName: string; id: string; summary: string; actions: Record<string, unknown>[] } | null>(null)
  const [secApproved, setSecApproved] = useState<Set<number>>(new Set())
  const [secReviewOpen, setSecReviewOpen] = useState(false)
  const secSeenRef = useRef<string>('')   // last proposal id surfaced (don't re-pop after dismiss)
  const checkSecretaryProposals = useCallback(async () => {
    try {
      const hands = nodesRef.current.filter(n => n.level === 'hand' && n.parent_id === 'projects' && !n.is_archived)
      const results = await Promise.all(hands.map(async h => {
        try {
          const r = await fetch(`/api/secretary/proposals?node_id=${encodeURIComponent(h.id)}`, { cache: 'no-store' })
          const d = await r.json()
          return d?.proposal ? { node: h, proposal: d.proposal } : null
        } catch { return null }
      }))
      const hit = results.find(Boolean)
      if (!hit) { setSecPop(null); return }
      if (hit.proposal.id === secSeenRef.current) return
      let actions: Record<string, unknown>[] = []
      try { actions = JSON.parse(hit.proposal.actions_json) } catch { /* corrupt json → empty list */ }
      secSeenRef.current = hit.proposal.id
      setSecPop({ nodeId: hit.node.id, nodeName: hit.node.name, id: hit.proposal.id, summary: hit.proposal.summary, actions })
      setSecApproved(new Set(actions.map((_, i) => i)))
    } catch { /* quiet */ }
  }, [])
  useEffect(() => { const t = setTimeout(() => { void checkSecretaryProposals() }, 4000); return () => clearTimeout(t) }, [checkSecretaryProposals])
  const secResolve = useCallback(async (op: 'apply' | 'dismiss') => {
    setSecPop(cur => {
      if (cur) void fetch('/api/secretary/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op === 'apply' ? { op, id: cur.id, approved: [...secApproved] } : { op, id: cur.id }) }).catch(() => {})
      return null
    })
    setSecReviewOpen(false)
    loadDashTasksRef.current()
  }, [secApproved])
  useEffect(() => { void loadHabits(); void loadFocus(); void loadNotepads(); void loadInbox() }, [loadHabits, loadFocus, loadNotepads, loadInbox])
  useEffect(() => { const id = setInterval(() => { void loadInbox() }, 120_000); return () => clearInterval(id) }, [loadInbox])
  const [scribeRefreshing, setScribeRefreshing] = useState(false)
  const [scribeToday, setScribeToday] = useState('') // server's local day (for the TODAY label across timezones)
  const [scribeIndex, setScribeIndex] = useState(0)  // Chronicle book page — index into scribeEntries (0 = newest/today; higher = older)
  const [scribeQuote, setScribeQuote] = useState<{ quote: string; author: string }>({ quote: '', author: '' }) // quote of the day (North Star spot)
  const [scribeWord, setScribeWord] = useState<{ word: string; def: string; pron: string }>({ word: '', def: '', pron: '' }) // word of the day (top bar, vocab)
  // ── Librarian (autonomous document organizer) — types mirror lib/librarian.ts (server-only module).
  type LibrarianAction = {
    id: string; op: 'move' | 'create_folder' | 'archive' | 'merge' | 'rename'
    confidence: 'high' | 'low'; why: string; status: 'pending' | 'applied' | 'failed'
    note?: string; escalated?: boolean
    doc_id?: string; doc_title?: string
    target_folder_id?: string; target_new_folder?: string; target_label?: string
    folder_name?: string; reason?: string
    doc_ids?: string[]; doc_titles?: string[]; merge_into_title?: string; new_title?: string
  }
  type LibrarianPlan = { id: string; node_id: string; status: string; model: string; summary: string; created_at: number; updated_at: number; actions: LibrarianAction[] }
  const [librarianOpen, setLibrarianOpen] = useState(false)
  const [librarianNodeId, setLibrarianNodeId] = useState<string | null>(null)
  const [librarianPlan, setLibrarianPlan] = useState<LibrarianPlan | null>(null)
  const [librarianBusy, setLibrarianBusy] = useState(false)                 // generating or applying
  const [librarianApproved, setLibrarianApproved] = useState<Set<string>>(new Set())
  const [librarianEdits, setLibrarianEdits] = useState<Record<string, { target_folder_id?: string; target_new_folder?: string }>>({})
  const [librarianFolders, setLibrarianFolders] = useState<{ id: string; title: string }[]>([]) // folders in the target project (redirect dropdown)
  const [librarianResult, setLibrarianResult] = useState<string | null>(null)
  const [librarianPending, setLibrarianPending] = useState(0)               // # of open plans → bell badge
  const [effortMode, setEffortMode] = useState<'low' | 'medium' | 'high'>('low') // REASONING bar: gpt-oss reasoning_effort (low default = fast chats); HIGH also enables Claude extended thinking
  const [thinkMode, setThinkMode] = useState(false)       // CLAUDE-only extended thinking (legacy; folded into the REASONING bar)
  const [settingsOpen, setSettingsOpen] = useState(false) // settings dropdown
  // Web Push (Phase 2 notifications) — permission state + the enable/test flow.
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>('default')
  const [notifBusy, setNotifBusy] = useState(false)
  const [notifMsg, setNotifMsg] = useState<string | null>(null)
  const [notifBannerHidden, setNotifBannerHidden] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false) // input-bar "+" add menu (attach / research / conversations)
  const [selectedModel, setSelectedModel] = useState<ModelId>('claude-sonnet-4-6') // Haiku | Sonnet | Opus — persisted as diagram_model
  // Deep research: which mode is armed on the input (null = normal chat), and the mode popover.
  // One self-scaling research mode now — the beaker "arms" research; no Full/Max selection.
  const [researchArmed, setResearchArmed] = useState(false)
  // Confirmation gate — research CANNOT fire (button OR voice/chat deepResearch action) without an
  // explicit "Start Research" click here. Holds the pending request until confirmed/cancelled.
  // `sessionId` + `history` are snapshotted at request time (session context isolation): the
  // triggering chat session's id and its last ≤20 text messages, so the launch sends exactly the
  // conversation that was on screen even if the user navigates while the modal is open.
  const [researchConfirm, setResearchConfirm] = useState<{ query: string; model: ModelId; scope: string; plan?: SpectrePlan; sessionId: string | null; history: ResearchHistoryMsg[]; mode: ResearchModeUI } | null>(null)
  // Client-side request lock: scopes with a research run in flight. Disables the button + ignores
  // duplicate deepResearch actions so a double-submit never reaches the server.
  const researchRunningRef = useRef<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)       // web search in progress
  const [deepThinking, setDeepThinking] = useState(false) // think-mode reasoning before first token
  // Silent UI status (file reads, vault searches, doc references) — a subtle persistent
  // indicator near the composer, NEVER a chat bubble. Cleared the moment the answer streams.
  const [chatStatus, setChatStatus] = useState<{ kind: 'reading' | 'searching' | 'vault'; label: string } | null>(null)
  // Per-read-chain cache of fetched file/notebook content, so a model that re-requests an
  // item it was just given resolves instantly into a completion instead of dead-ending.
  const readContentCacheRef = useRef<Map<string, { name: string; text: string }>>(new Map())
  // Set when a model re-requests an item it already read this chain (the dedup suppresses the
  // re-read). Instead of leaving the turn stuck on "Reading…", the drain does ONE final
  // regenerate from cache with a firm "answer now" — guaranteeing the loop completes.
  const forceAnswerRef = useRef(false)
  const [chatOpen, setChatOpen] = useState(false)
  // Keyed by scope id. Seeded arms use known ids; user-created Arms use UUIDs.
  const [allMessages, setAllMessages] = useState<Record<string, Message[]>>(EMPTY_MESSAGES)
  const [activeFolder, setActiveFolder] = useState<string>('main')
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [projectMessages, setProjectMessages] = useState<Record<string, Message[]>>(EMPTY_PROJECT_MESSAGES)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [orbActive, setOrbActive] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false) // STT in flight after the inline mic stops
  const [clock, setClock] = useState('')
  const [mounted, setMounted] = useState(false)
  const [mobileTab, setMobileTab] = useState<'dashboard' | 'chat'>('dashboard')
  // Mobile workspace pager — the Arm/Hand split view (chat + detail) is a full-screen pager
  // on phones: pane 0 = chat, pane 1 = workspace (Sources/Notebooks, calendar, gym…). It's a
  // TRANSFORM pager (margin-left on the first pane via the --pane/--drag CSS vars), NOT native
  // scroll — so a vertical swipe only scrolls the pane and the pager shifts horizontally only on
  // a deliberate, axis-locked horizontal swipe (no sideways wiggle / rubber-band). Desktop is
  // untouched: the margin rule + the tiny pane indicator live inside the 767px media query.
  const [swipePane, setSwipePane] = useState(0)
  const swipePanesRef = useRef<HTMLDivElement | null>(null)
  const swipeGesture = useRef<{ x: number; y: number; axis: '' | 'h' | 'v'; w: number } | null>(null)
  const goToSwipePane = (i: number) => setSwipePane(i)
  const onPanesTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]
    swipeGesture.current = { x: t.clientX, y: t.clientY, axis: '', w: e.currentTarget.clientWidth || 1 }
  }
  const onPanesTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = swipeGesture.current
    if (!g) return
    const t = e.touches[0]
    const dx = t.clientX - g.x, dy = t.clientY - g.y
    if (g.axis === '' && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) g.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    if (g.axis === 'h') {
      const el = swipePanesRef.current
      if (!el) return
      el.classList.add('swipe-dragging')
      // Resist dragging past the first / last pane.
      const atEdge = (swipePane === 0 && dx > 0) || (swipePane === 1 && dx < 0)
      el.style.setProperty('--drag', `${atEdge ? dx * 0.28 : dx}px`)
    }
  }
  const onPanesTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = swipeGesture.current
    swipeGesture.current = null
    const el = swipePanesRef.current
    if (el) { el.classList.remove('swipe-dragging'); el.style.setProperty('--drag', '0px') }
    if (!g || g.axis !== 'h') return
    const dx = e.changedTouches[0].clientX - g.x
    if (dx < -g.w * 0.22 && swipePane < 1) setSwipePane(1)
    else if (dx > g.w * 0.22 && swipePane > 0) setSwipePane(0)
  }
  const renderPaneTabs = (detailLabel: string) => (
    <div className="mobile-pane-tabs" style={{ display: 'none', alignItems: 'center', justifyContent: 'center', gap: '16px', flexShrink: 0, padding: '1px 0 4px' }}>
      {([['CHAT', 0], [detailLabel, 1]] as [string, number][]).map(([lbl, i]) => (
        <button
          key={i}
          onClick={() => goToSwipePane(i)}
          style={{
            padding: '0 0 2px', background: 'transparent', border: 'none',
            borderBottom: `1px solid ${swipePane === i ? accentHex : 'transparent'}`,
            color: swipePane === i ? accentHex : 'rgba(255,255,255,0.26)',
            fontSize: '8.5px', letterSpacing: '0.18em', fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.2s, border-color 0.2s',
          }}
        >
          {lbl}
        </button>
      ))}
    </div>
  )
  const [voiceMode, setVoiceMode] = useState(false)
  // Mini (picture-in-picture) voice mode: launched from a folder/project panel's orb.
  // Shares the full voice pipeline; only the UI differs (the corner orb expands in
  // place instead of the dashboard taking over).
  const [miniVoice, setMiniVoice] = useState(false)
  // ── Permanence across navigation: when a turn navigates the user to another scope,
  //    the destination's NEXT turn carries the handoff — who sent them, what they asked, what
  //    was said — so the receiving Spectre continues the thread instead of starting cold. ──
  const handoffRef = useRef<{ fromScope: string; fromName: string; ask: string; said: string; at: number } | null>(null)
  // ── Manual chat/work ratio: a draggable divider between the chat panel and the
  //    right panel in project workspaces. Voice mode overrides to 25/75 (hands-busy layout). ──
  const [chatPct, setChatPct] = useState(48)
  const [dividerDragging, setDividerDragging] = useState(false)
  useEffect(() => { try { const v = Number(localStorage.getItem('diagram_chat_pct')); if (v >= 20 && v <= 70) setChatPct(v) } catch { /* default 48 */ } }, [])
  const dividerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const el = swipePanesRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setDividerDragging(true)
    const move = (ev: PointerEvent) => setChatPct(Math.min(70, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDividerDragging(false)
      setChatPct(p => { try { localStorage.setItem('diagram_chat_pct', String(Math.round(p))) } catch { /* persist best-effort */ } return p })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle')
  // Transient notification (voice-failover outcomes); survives exiting voice mode.
  const [toast, setToast] = useState<string | null>(null)

  // Live-editable state — updated by Spectre actions
  const [projects, setProjects] = useState<Project[]>(INITIAL_PROJECTS)
  // Google Calendar — lean 7-day window (context + What's Next) and the full
  // month view (schedule folder). gcalConnected gates the connect CTA.
  const [weekEvents, setWeekEvents] = useState<CalendarEvent[]>([])
  const [monthEvents, setMonthEvents] = useState<CalendarEvent[]>([])
  const [viewMonth, setViewMonth] = useState<Date>(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1) })
  const [selectedDay, setSelectedDay] = useState<Date>(() => new Date())
  const [gcalConnected, setGcalConnected] = useState(false)
  const [bodyStats, setBodyStats] = useState<BodyStat[]>(INITIAL_BODY_STATS)
  // Live Oura Ring data (null until connected/loaded).
  const [ouraData, setOuraData] = useState<OuraSnapshot | null>(null)
  const [ouraConnected, setOuraConnected] = useState(false)
  const [ouraError, setOuraError] = useState<string | null>(null)  // 'sync_failed' → cached data + warning
  // Gym arm — master workout file (keyed by ISO date) + derived exercise library.
  // viewDate is the day currently on screen in the day navigator.
  const [workouts, setWorkouts] = useState<WorkoutsMap>({})
  const [exercises, setExercises] = useState<ExercisesMap>({})
  const [viewDate, setViewDate] = useState<Date>(() => new Date())

  // Persistent chat sessions (cross-device, SQLite-backed). `sessions` is keyed by
  // scope (folder_id); `activeSessionId` tracks the open session per scope. The
  // folder/project left panel toggles between the session list and the chat via
  // `chatView`; the main page uses a slide-in drawer (`mainDrawerOpen`).
  // `sessionMsgMeta` holds the flagged rows of the active session — it drives both
  // the sliding-window context assembly and the "history compressed" indicator.
  const [sessions, setSessions] = useState<Record<string, SessionMeta[]>>({})
  const [activeSessionId, setActiveSessionId] = useState<Record<string, string | null>>({})
  const [chatView, setChatView] = useState<'sessions' | 'chat'>('sessions')
  const [mainDrawerOpen, setMainDrawerOpen] = useState(false)
  const [sessionMsgMeta, setSessionMsgMeta] = useState<SessionMsg[]>([])

  // ── Diagram tree (Arms / Hands) ────────────────────────────────────────────────
  // Loaded from /api/nodes; drives the data-driven bento grid, Hands navigation, and
  // per-node editable primers. A node's id is its session scope.
  const [nodes, setNodes] = useState<NodeMeta[]>([])
  const [activeHand, setActiveHand] = useState<string | null>(null)   // hand node id when inside a Hand
  // When the active workspace changes, snap the mobile pager back to the chat pane.
  useEffect(() => {
    setSwipePane(0)
    const el = swipePanesRef.current
    if (el) el.style.setProperty('--drag', '0px')
  }, [activeProject, activeHand, activeFolder])
  const [creatingArm, setCreatingArm] = useState(false)               // New Arm modal
  const [creatingHand, setCreatingHand] = useState(false)             // New Hand modal
  const [creatingHandParent, setCreatingHandParent] = useState<string>('projects')  // parent Arm for the New Hand modal
  const [editingPrimer, setEditingPrimer] = useState(false)           // primer editor open in session layer
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string; level: NodeLevel } | null>(null)
  const [renamingNode, setRenamingNode] = useState<{ id: string; name: string; level: NodeLevel } | null>(null)

  // Projects landing — freshly generated activity summaries per Hand id (Haiku).
  const [projectSummaries, setProjectSummaries] = useState<Record<string, string>>({})
  const [projectSpent, setProjectSpent] = useState<Record<string, number>>({})   // node_id → tracked ms
  useEffect(() => { void (async () => { try { const r = await fetch('/api/tasks/time'); const d = await r.json(); setProjectSpent(d.spent ?? {}) } catch { /* resting */ } })() }, [])
  // Project Hand SOURCES — reference files keyed by node (scope) id.
  const [sourceFiles, setSourceFiles] = useState<Record<string, SourceFile[]>>({})
  const sourceFilesRef = useRef<Record<string, SourceFile[]>>({})
  sourceFilesRef.current = sourceFiles
  // Chat composer attachments (files/images staged for the next message) + drag state.
  const [chatAttachments, setChatAttachments] = useState<PendingAttachment[]>([])
  const chatAttachmentsRef = useRef<PendingAttachment[]>([])
  chatAttachmentsRef.current = chatAttachments
  const [chatDragActive, setChatDragActive] = useState(false)
  const chatFileInputRef = useRef<HTMLInputElement>(null)
  // readFile action queue — Spectre's on-demand Sources reads, drained after each stream.
  const readFileQueueRef = useRef<string[]>([])
  const readFileDepthRef = useRef(0)
  // Ids already drained in the CURRENT read chain (cleared with readFileDepthRef). A
  // model that re-requests a file/notebook it was just given (gpt-oss did this 3× in a
  // row on 2026-06-11, tripling the answer) gets the duplicate silently skipped.
  const drainedReadIdsRef = useRef<Set<string>>(new Set())
  const readFileBusyRef = useRef(false)
  // ONE shared wake-up tick for all three drain effects (readFile / notebook / vault).
  // Bumped whenever ANY read/search is queued — including by the action sequencing queue's
  // 350ms-delayed dispatches, which land AFTER `streaming` has already flipped false. A
  // per-queue tick missed those late arrivals entirely (the 2026-06-11 "Opening it now."
  // → silence bug): the effect had already run on the streaming flip, found its queue
  // empty, and nothing ever re-triggered it. Shared also means each drain's finally
  // re-wakes the OTHER queues, so serialized drains always resume.
  const [drainTick, setDrainTick] = useState(0)
  // searchVault action queue — Spectre's on-demand vault searches, drained after each
  // stream (same pattern as readFile; shares the per-turn read budget).
  const vaultSearchQueueRef = useRef<{ query: string; node_id?: string; limit?: number }[]>([])
  const vaultSearchBusyRef = useRef(false)
  // ── Docu-scape (NOTEBOOKS) ──────────────────────────────────────────────────────
  // Flat non-archived notebook/folder list per scope id; views derive levels client-side.
  const [notebooksByNode, setNotebooksByNode] = useState<Record<string, NotebookMeta[]>>({})
  const notebooksByNodeRef = useRef<Record<string, NotebookMeta[]>>({})
  notebooksByNodeRef.current = notebooksByNode
  // The open notebook (editor view) + focus mode. Lifted here so the workspace branch
  // can collapse the chat panel for focus mode, and composeBase can inject open content.
  const [openNotebookId, setOpenNotebookId] = useState<string | null>(null)
  const openNotebookIdRef = useRef<string | null>(null)
  openNotebookIdRef.current = openNotebookId
  // 'edit' = normal TipTap editing (card click default); 'view' = read-only render
  // (Spectre's openNotebook mode:'view'). Drives NotebookEditor's `readOnly` prop.
  const [openNotebookMode, setOpenNotebookMode] = useState<'view' | 'edit'>('edit')
  const [notebookFocus, setNotebookFocus] = useState(false)
  const [notebookFolder, setNotebookFolder] = useState('')   // open folder in the library (state 2)
  // openFile action — a Sources file previewed in the right panel (image/PDF/text). The ref
  // mirror lets the (async) per-turn open-document retrieval read it without a dep cycle.
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  const previewFileIdRef = useRef<string | null>(null)
  previewFileIdRef.current = previewFileId
  // On opening a Source file, ensure it's vectorized so the second-screen scoped search has
  // its chunks ready. Fire-and-forget; no-op when already indexed; silent if the vault is down.
  useEffect(() => {
    if (!previewFileId) return
    fetch('/api/vault/index', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id: previewFileId, source_type: 'file' }),
    }).catch(() => { /* vault offline — scoped search just returns empty */ })
  }, [previewFileId])
  // Live editor handle (registered by the mounted NotebookEditor) for Spectre writes,
  // plus the open notebook's current markdown for the [OPEN NOTEBOOK] primer block.
  const openEditorApiRef = useRef<{ id: string; insertMarkdown: (md: string, mode: 'append' | 'replace') => void } | null>(null)
  const openNotebookContentRef = useRef<{ id: string; title: string; markdown: string } | null>(null)
  // readNotebook / listNotebooks action queue — drained after each stream (mirrors readFile).
  const notebookReadQueueRef = useRef<string[]>([])
  const notebookReadBusyRef = useRef(false)
  // ── Spatial awareness ────────────────────────────────────────────────────────────
  // The full live Diagram tree (from /api/tree, 30s server cache) injected into every
  // primer, plus an item index (notebook/file id → owning node id) used by the action
  // queue for implicit-navigate before opening an item.
  const diagramTreeRef = useRef<string>('')
  const itemIndexRef = useRef<{ notebooks: Record<string, string>; files: Record<string, string> }>({ notebooks: {}, files: {} })
  // ── Action sequencing queue ────────────────────────────────────────────────────────
  // Spectre can return several actions in one response; they must run in order (navigate
  // before open, etc.), not all at once. Actions are pushed here and drained one at a time
  // with a settle delay so React re-renders between steps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actionQueueRef = useRef<{ action: Record<string, any>; scope: string }[]>([])
  const actionQueueBusyRef = useRef(false)
  // enqueueActions is defined after the navigation handlers (it depends on them); the
  // streaming paths (sendMessage/regenerate) are defined earlier, so they invoke it
  // through this ref to avoid a declaration cycle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enqueueActionsRef = useRef<(actions: Record<string, any>[], scope: string) => void>(() => {})
  // Recently-visited scopes (newest last), for "go back" — surfaced in the spatial primer.
  const navHistoryRef = useRef<string[]>([])
  // Project Hand SECTIONS — tags per node id, and the active filter per scope (null = "All").
  const [tagsByNode, setTagsByNode] = useState<Record<string, Tag[]>>({})
  const [activeTagByScope, setActiveTagByScope] = useState<Record<string, string | null>>({})
  const activeTagByScopeRef = useRef<Record<string, string | null>>({})
  activeTagByScopeRef.current = activeTagByScope

  const chatEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const ttsModeRef = useRef<TtsMode>('cloud')
  ttsModeRef.current = ttsMode
  const ttsStreamingRef = useRef(false)
  ttsStreamingRef.current = ttsStreaming
  // Stable indirection so sendMessage can delegate to the (later-defined) agent path without a dep cycle.
  const sendViaAgentRef = useRef<(text: string, opts?: { voice?: boolean; skipMemory?: boolean }) => void>(() => {})
  // Web Audio streaming-TTS scheduling: the running schedule cursor (ctx time) + the live buffer
  // sources, so playback is gapless and a stop/interrupt can halt every scheduled buffer.
  const audioCursorRef = useRef(0)
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([])
  // The streaming-vs-buffered decision snapshotted ONCE per spoken turn (set on the turn's first
  // enqueued sentence), so a mid-reply ttsMode/ttsStreaming flip can't split one turn across both
  // paths (which would run two completion machines and reopen the mic over still-playing audio).
  const ttsStreamModeRef = useRef(false)
  const effortModeRef = useRef<'low' | 'medium' | 'high'>('low')
  effortModeRef.current = effortMode
  const thinkModeRef = useRef(false)
  thinkModeRef.current = thinkMode
  // Mirror of the selected Claude model so send/regenerate/research paths read it synchronously.
  const selectedModelRef = useRef<ModelId>('claude-sonnet-4-6')
  selectedModelRef.current = selectedModel
  const researchArmedRef = useRef(false)
  researchArmedRef.current = researchArmed
  const settingsRef = useRef<HTMLDivElement>(null) // settings dropdown — click-outside
  const voiceModeRef = useRef(false)
  voiceModeRef.current = voiceMode
  const miniVoiceRef = useRef(false)
  miniVoiceRef.current = miniVoice
  const voicePhaseRef = useRef<VoicePhase>('idle')
  voicePhaseRef.current = voicePhase
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  // Voice-failover single-trigger guard + toast auto-dismiss timer.
  const failoverActiveRef = useRef(false)
  const toastTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Voice pipeline refs ───────────────────────────────────────────────
  // Persistent mic capture + Web Audio analyser for VAD (lives across turns)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  // Per-turn recording
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const cancelNextRef = useRef(false)        // when true, the next onstop is discarded (no STT)
  const speechStartedRef = useRef(false)     // has the user actually spoken this turn
  const silenceStartRef = useRef<number | null>(null)
  const recordStartRef = useRef(0)
  // Language-gated barge-in: a separate recorder captures a possible interruption
  // during playback; it's transcribed and only cuts Spectre off if it's real speech.
  const bargeRecorderRef = useRef<MediaRecorder | null>(null)
  const bargeChunksRef = useRef<Blob[]>([])
  const bargeSpeechStartedRef = useRef(false)
  const bargeSpeechStartTimeRef = useRef(0)
  const bargeSilenceStartRef = useRef<number | null>(null)
  const bargeProbingRef = useRef(false)      // an interruption capture is being transcribed
  // Sentence-streamed TTS pipeline (audio is primary in voice mode). Two independent
  // queues: a REQUEST queue (sentences awaiting TTS, sent to Chatterbox/Cartesia strictly
  // one-at-a-time — concurrent requests degrade Chatterbox quality) feeds a PLAYBACK
  // queue (ttsItemsRef, drained sequentially by pumpTTS as audio arrives).
  type TtsItem = { url: string | null; aborted: boolean; controller: AbortController }
  const ttsItemsRef = useRef<TtsItem[]>([])  // PLAYBACK queue (ordered, audio blobs)
  const ttsCursorRef = useRef(0)             // index of the next item to PLAY
  const ttsPlayingRef = useRef(false)
  const ttsStreamDoneRef = useRef(false)     // text stream finished & all sentences enqueued
  const ttsRequestQueueRef = useRef<string[]>([])      // REQUEST queue (sentences awaiting TTS)
  const ttsRequestActiveRef = useRef(false)            // a TTS fetch is in flight
  const ttsCurrentControllerRef = useRef<AbortController | null>(null)  // abort the in-flight fetch
  // FIX 1 — hard mic mute during TTS. While ANY packet is playing (incl. the gaps between
  // sentence packets) the passive listening path is hard-closed; it reopens only after the
  // whole playback queue drains + a 350ms cooldown, so the TTS tail/reverb can never be
  // captured as a phantom user turn. Barge-in (live analyser energy + language gate) is the
  // sanctioned exception and stays live during playback — the mute is passive-listening only.
  const ttsHardMuteRef = useRef(false)                 // true from first packet → cooldown end
  const micCooldownTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Turn-based voice: the mic hardware is fully CLOSED (tracks stopped) during SPEAKING, so
  // this tracks whether the mic is currently open. A monotonic turn sequence lets a manual
  // interrupt invalidate the in-flight stream's remaining TTS enqueues ("clear streamBuffer").
  const isMicOpenRef = useRef(false)
  const voiceTurnSeqRef = useRef(0)
  // Synchronous mirror of `streaming` — set imperatively the instant a turn commits (not on the
  // next render), so the `if (streamingRef.current) return` guard in sendMessage/regenerate can
  // never be defeated by a stale closure or a same-tick double-fire (the S3 "greeting silently
  // dropped → stuck in THINKING" race).
  const streamingRef = useRef(false)
  // The in-flight /api/spectre fetch's AbortController + a deliberate-interrupt flag. Binding the
  // controller to the BODY (not just the header timer) makes a voice turn cancellable mid-stream:
  // a tap during THINKING aborts generation so it can't keep streaming, run actions, or persist a
  // reply the user cut off. The flag tells postSpectre an abort was intentional (don't retry it).
  const spectreStreamAbortRef = useRef<AbortController | null>(null)
  const spectreInterruptRef = useRef(false)
  // Voice latency probe — one spoken turn's stage timestamps (logged as [VOICE LATENCY]).
  const voiceTimingRef = useRef<{ t0: number; firstToken: number; firstAudio: number } | null>(null)
  // One reusable <audio> element, unlocked on the orb-click gesture (iOS autoplay).
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const audioUnlockedRef = useRef(false)
  // One-shot mic for the text input bar (separate from the voice-mode loop)
  const oneShotStreamRef = useRef<MediaStream | null>(null)
  const oneShotRecRef = useRef<MediaRecorder | null>(null)
  const oneShotChunksRef = useRef<Blob[]>([])
  const activeFolderRef = useRef<string>('main')
  activeFolderRef.current = activeFolder
  const activeProjectRef = useRef<string | null>(null)
  activeProjectRef.current = activeProject
  const allMessagesRef = useRef(allMessages)
  allMessagesRef.current = allMessages
  const projectMessagesRef = useRef(projectMessages)
  projectMessagesRef.current = projectMessages
  const weekEventsRef = useRef(weekEvents)
  weekEventsRef.current = weekEvents
  const viewMonthRef = useRef(viewMonth)
  viewMonthRef.current = viewMonth
  const bodyStatsRef = useRef(bodyStats)
  bodyStatsRef.current = bodyStats
  const ouraDataRef = useRef(ouraData)
  ouraDataRef.current = ouraData
  const workoutsRef = useRef(workouts)
  workoutsRef.current = workouts
  const exercisesRef = useRef(exercises)
  exercisesRef.current = exercises
  const viewDateRef = useRef(viewDate)
  viewDateRef.current = viewDate
  // Exercise name of the block-detail subpage currently open (null on the day view).
  // Lifted to a ref so buildPrimer can tell Spectre exactly what's on screen.
  const openBlockRef = useRef<string | null>(null)
  // Debounce timer for write-through persistence of the master workout file.
  const persistTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // Session refs — read synchronously inside the async sendMessage path.
  const activeSessionIdRef = useRef<Record<string, string | null>>({})
  activeSessionIdRef.current = activeSessionId
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const sessionMsgMetaRef = useRef<SessionMsg[]>([])
  sessionMsgMetaRef.current = sessionMsgMeta
  const compressingRef = useRef(false)   // guards against overlapping compression runs
  const nodesRef = useRef<NodeMeta[]>([])
  nodesRef.current = nodes
  const activeHandRef = useRef<string | null>(null)
  activeHandRef.current = activeHand

  // ── Google Calendar fetch ────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' })
      const data = await res.json()
      setGcalConnected(!!data.connected)
    } catch { /* server offline */ }
  }, [])

  // Lean 7-day window — drives Spectre context + the dashboard calendar + the NOW list.
  // timeMin = START OF TODAY (not `now`): the NOW list's carried-over section and the
  // block-end recovery need today's already-ended events, and Google filters on event END —
  // fetching from `now` made an ended block vanish within one 15-min poll (TASKS-PLAN §2).
  // The fetch also runs the server-side block auto-matcher, so block links reload after.
  const loadDashTasksRef = useRef<() => void>(() => {})
  const refreshWeek = useCallback(async () => {
    const now = new Date()
    const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const timeMax = new Date(now.getTime() + 7 * 864e5).toISOString()
    try {
      const res = await fetch(`/api/calendar?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`, { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.events)) setWeekEvents(data.events)
      if (typeof data.connected === 'boolean') setGcalConnected(data.connected)
      loadDashTasksRef.current()   // pick up any links the auto-matcher just made
    } catch { /* server offline */ }
  }, [])

  // Full month range (padded a week each side so grid edge days have events).
  const refreshMonth = useCallback(async (month: Date) => {
    const start = new Date(month.getFullYear(), month.getMonth(), 1)
    start.setDate(start.getDate() - 7)
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1)
    end.setDate(end.getDate() + 7)
    try {
      const res = await fetch(`/api/calendar?timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}`, { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.events)) setMonthEvents(data.events)
    } catch { /* server offline */ }
  }, [])

  // ── Task system — dashboard state ─────────────────────────
  // The full open-task set (small — a personal system) + today's block links. The NOW
  // list derives from these via the pure nowList() on every render (the clock tick keeps
  // it current); nothing about "what matters now" is ever stored.
  const [dashTasks, setDashTasks] = useState<NowTask[]>([])
  const dashTasksRef = useRef<NowTask[]>([])
  const [dashBlocks, setDashBlocks] = useState<{ event_id: string; node_id: string; title: string; start_at: number; end_at: number }[]>([])
  const [doneOpen, setDoneOpen] = useState(false)
  const [taskInput, setTaskInput] = useState('')
  const loadDashTasks = useCallback(async () => {
    try {
      const [tr, br] = await Promise.all([
        fetch('/api/tasks?include_done=1', { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/blocks', { cache: 'no-store' }).then(r => r.json()),
      ])
      if (Array.isArray(tr.tasks)) { setDashTasks(tr.tasks); dashTasksRef.current = tr.tasks }
      if (Array.isArray(br.blocks)) setDashBlocks(br.blocks)
    } catch { /* server offline — widget shows what it has */ }
  }, [])
  useEffect(() => { loadDashTasks(); loadDashTasksRef.current = loadDashTasks; const iv = setInterval(loadDashTasks, 5 * 60_000); return () => clearInterval(iv) }, [loadDashTasks])

  // Web Push: register the SW on mount, reflect the current permission, and silently
  // re-subscribe if already granted (iOS drops subscriptions — refreshing on every open
  // keeps the user's phone reachable).
  useEffect(() => {
    setNotifPerm(notifPermission())
    void registerSW()
    void refreshSubscription()
  }, [])
  const handleEnableNotifs = useCallback(async () => {
    setNotifBusy(true); setNotifMsg(null)
    // iOS only allows push for an INSTALLED PWA — guide the user to add to home screen first.
    if (pushSupported() && !isStandalone() && /iphone|ipad|ipod/i.test(navigator.userAgent) && notifPermission() === 'default') {
      setNotifMsg('On iPhone: tap Share → “Add to Home Screen”, open the Diagram from there, then enable.')
      setNotifBusy(false); return
    }
    const r = await enableNotifications((USER_NAME ? `${USER_NAME}’s ` : '') + (/iphone|ipad/i.test(navigator.userAgent) ? 'iPhone' : 'device'))
    setNotifPerm(notifPermission())
    setNotifMsg(r.ok ? 'Enabled — sending a test…' : (r.reason ?? 'Could not enable.'))
    if (r.ok) { const t = await sendTestPush(); setNotifMsg(t.ok ? 'Enabled ✓ — check for the test notification.' : (t.reason ?? 'Enabled, but the test didn’t send.')) }
    setNotifBusy(false)
  }, [])
  const handleTestNotif = useCallback(async () => {
    setNotifBusy(true); setNotifMsg(null)
    const t = await sendTestPush()
    setNotifMsg(t.ok ? 'Test sent — check your device.' : (t.reason ?? 'Test failed.'))
    setNotifBusy(false)
  }, [])

  // ── Project map overlay (the constrained-lanes progress map) ─────────────────────
  const [mapOpen, setMapOpen] = useState<{ nodeId: string; name: string } | null>(null)

  // ── Block popover (link a calendar event ↔ project, assign tasks) ────────────────
  const [blockPop, setBlockPop] = useState<{ event: CalendarEvent; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!blockPop) return
    const close = () => setBlockPop(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [blockPop])
  const linkBlock = useCallback(async (e: CalendarEvent, nodeId: string) => {
    try {
      await fetch('/api/blocks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: e.id, node_id: nodeId, recurring_event_id: e.recurringEventId ?? '', title: e.title, start_at: new Date(e.start).getTime(), end_at: new Date(e.end).getTime() }),
      })
    } catch { /* offline */ }
    loadDashTasksRef.current()
  }, [])
  const unlinkBlock = useCallback(async (eventId: string) => {
    try { await fetch(`/api/blocks?event_id=${encodeURIComponent(eventId)}`, { method: 'DELETE' }) } catch { /* offline */ }
    loadDashTasksRef.current()
  }, [])
  const assignTaskToBlock = useCallback(async (taskId: string, eventId: string) => {
    try { await fetch(`/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ block_event_id: eventId }) }) } catch { /* offline */ }
    loadDashTasksRef.current()
  }, [])

  // Carried-over recovery — passive buttons, never questions (TASKS-PLAN §7). "Later" is
  // defined: → next block = today's next upcoming linked block for that project (falls
  // through to → today when none), → today = unassigned + due today (untimed).
  const recoverCarried = useCallback(async (blockEventId: string, tasks: NowTask[], action: 'done-all' | 'next-block' | 'today') => {
    const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    let target: { kind: 'done' } | { kind: 'block'; id: string } | { kind: 'today' }
    if (action === 'done-all') target = { kind: 'done' }
    else if (action === 'next-block') {
      const src = dashBlocks.find(b => b.event_id === blockEventId)
      const next = dashBlocks.filter(b => b.start_at > Date.now() && (!src || b.node_id === src.node_id)).sort((a, b) => a.start_at - b.start_at)[0]
      target = next ? { kind: 'block', id: next.event_id } : { kind: 'today' }
    } else target = { kind: 'today' }
    for (const t of tasks) {
      const body = target.kind === 'done' ? { status: 'done' } : target.kind === 'block' ? { block_event_id: target.id } : { block_event_id: '', due_at: todayStr }
      try { await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } catch { /* offline */ }
    }
    loadDashTasksRef.current()
  }, [dashBlocks])

  // Quick-add — the notebook's capture speed: chrono parses NL time locally ("groceries at
  // 9am" → timed due; no time → due TODAY so a capture is never invisible), optimistic row,
  // then the server row reconciles. Works even when the LLM stack is down.
  const quickAddTask = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const { title, due_at } = parseQuickAdd(text)
    const temp: NowTask = { id: `temp-${Date.now()}`, node_id: '', title, status: 'todo', step: null, lane: 0, due_at, block_event_id: '', position: 9999, created_at: Date.now() }
    setDashTasks(t => [...t, temp]); dashTasksRef.current = [...dashTasksRef.current, temp]
    setTaskInput('')
    try {
      const res = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, due_at }) })
      const data = await res.json()
      if (data.task) { setDashTasks(t => t.map(x => x.id === temp.id ? data.task : x)); dashTasksRef.current = dashTasksRef.current.map(x => x.id === temp.id ? data.task : x) }
    } catch { /* offline: the optimistic row stays for this session */ }
  }, [])

  const toggleTaskDone = useCallback(async (task: NowTask) => {
    const next = task.status === 'done' ? 'todo' : 'done'
    const apply = (list: NowTask[]) => list.map(x => x.id === task.id ? { ...x, status: next } : x)
    setDashTasks(apply); dashTasksRef.current = apply(dashTasksRef.current)
    try { await fetch(`/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) }) } catch { /* offline */ }
  }, [])

  // ── Oura Ring fetch ──────────────────────────────────────────────────────
  // refreshOura: cheap cache read (no Oura API call) — drives the body cards +
  // Spectre context on every load. syncOura: forces a fresh pull from Oura's
  // cloud (only fired in the 7–11am window + on the webhook's behalf).
  const refreshOura = useCallback(async () => {
    try {
      const res = await fetch('/api/oura/data', { cache: 'no-store' })
      const data = await res.json()
      setOuraConnected(!!data.connected)
      if (data.data) setOuraData(data.data as OuraSnapshot)
      // Surface a revoked/expired token so the Body panel shows Reconnect instead of silently
      // empty — the every-load poll now reports auth_expired, not just the 7-11am sync.
      setOuraError(typeof data.error === 'string' ? data.error : null)
    } catch { /* server offline */ }
  }, [])
  const syncOura = useCallback(async () => {
    try {
      const res = await fetch('/api/oura/sync', { cache: 'no-store' })
      const data = await res.json()
      setOuraConnected(!!data.connected)
      if (data.data) setOuraData(data.data as OuraSnapshot)
      setOuraError(typeof data.error === 'string' ? data.error : null)
    } catch { setOuraError('sync_failed') }
  }, [])

  // ── Gym arm: load + write-through persistence ─────────────────────────────
  // The master workout file is the source of truth. GET hydrates state on mount
  // and when the training arm opens; every mutation POSTs the full map back so
  // the server re-derives the exercise library (PRs + e1RM) and returns it.
  const persistInFlightRef = useRef(false)
  const persistWorkouts = useCallback((next: WorkoutsMap, immediate = false) => {
    const post = async () => {
      persistInFlightRef.current = true
      try {
        const res = await fetch('/api/workouts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workouts: next }),
        })
        const data = await res.json()
        if (data.exercises) setExercises(data.exercises as ExercisesMap)
      } catch { /* server offline — local state still holds the edit */ }
      finally { persistInFlightRef.current = false }
    }
    if (persistTidRef.current) { clearTimeout(persistTidRef.current); persistTidRef.current = null }
    if (immediate) post()
    else persistTidRef.current = setTimeout(post, 700)
  }, [])

  const loadWorkouts = useCallback(async () => {
    // Permanence ("the box is not filled anymore" bug): a pending or in-flight
    // write means LOCAL is newer than the server — re-entering the training arm must
    // NEVER clobber just-typed sets with a stale fetch. Pending debounce → flush it and
    // skip the read (the POST response refreshes the PR library anyway).
    if (persistTidRef.current) {
      clearTimeout(persistTidRef.current); persistTidRef.current = null
      persistWorkouts(workoutsRef.current, true)
      return
    }
    if (persistInFlightRef.current) return
    try {
      const res = await fetch('/api/workouts', { cache: 'no-store' })
      const data = await res.json()
      if (data.workouts) { setWorkouts(data.workouts as WorkoutsMap); workoutsRef.current = data.workouts as WorkoutsMap }
      if (data.exercises) setExercises(data.exercises as ExercisesMap)
    } catch { /* server offline */ }
  }, [persistWorkouts])

  // Last-resort flush: closing/refreshing the tab with a debounced workout write pending
  // beacons it out so a logged set can never be lost to the 700ms window.
  useEffect(() => {
    const flush = () => {
      if (!persistTidRef.current) return
      clearTimeout(persistTidRef.current); persistTidRef.current = null
      try { navigator.sendBeacon('/api/workouts', new Blob([JSON.stringify({ workouts: workoutsRef.current })], { type: 'application/json' })) } catch { /* best effort */ }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // ── Global rest timer: ONE timer that survives navigation and reloads
  //    (absolute endsAt in localStorage) and fires a REAL phone push server-side. ──
  const [restTimer, setRestTimer] = useState<{ endsAt: number; label: string; seconds: number } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('diagram_rest_timer')
      if (raw) {
        const t = JSON.parse(raw)
        if (t?.endsAt > Date.now()) setRestTimer(t)
        else localStorage.removeItem('diagram_rest_timer')
      }
    } catch { /* fresh */ }
  }, [])
  const startRestTimer = useCallback((seconds: number, label: string) => {
    const t = { endsAt: Date.now() + seconds * 1000, label, seconds }
    setRestTimer(t)
    try { localStorage.setItem('diagram_rest_timer', JSON.stringify(t)) } catch { /* memory-only */ }
    // Server-precise push — fires on time even if the tab sleeps or the user is away from the screen.
    void fetch('/api/rest-timer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds, label }) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!restTimer) return
    const id = setInterval(() => {
      if (Date.now() > restTimer.endsAt + 6000) {
        setRestTimer(null)
        try { localStorage.removeItem('diagram_rest_timer') } catch { /* fine */ }
      }
    }, 1000)
    return () => clearInterval(id)
  }, [restTimer])

  // Single funnel for every workout edit (UI inputs AND Spectre actions). Reads
  // the latest map from the ref (no stale closures), updates state, and persists.
  // Structural changes (reorder, set-done, actions) pass immediate=true; rapid
  // input typing uses the debounce.
  const mutateWorkouts = useCallback((updater: (prev: WorkoutsMap) => WorkoutsMap, immediate = false) => {
    const next = updater(workoutsRef.current)
    workoutsRef.current = next
    setWorkouts(next)
    persistWorkouts(next, immediate)
  }, [persistWorkouts])

  const cfg = MODE_CONFIG[mode]
  const accentHex = cfg.accent

  // V4 per-domain accent palette — cyan stays the base; each life-domain carries its own
  // accent so the UI reads by area. Defined inside the component since calendar/notes/summary
  // bind to the live accentHex.
  const DOMAIN = {
    calendar: accentHex, body: '#10B981', training: '#F59E0B', tasks: '#F59E0B', notes: accentHex,
    focus: '#38BDF8', habits: '#5EE08A', north: '#E8C76B', projects: '#A855F7', inbox: '#FF7A5C',
    stock: '#34D399', trends: '#7DD3FC', scribe: '#E8C76B', news: '#FF7A5C', summary: accentHex,
  } as const

  // dnd-kit sensors for the bento grid. Pointer needs a small activation distance so a
  // plain tap navigates rather than starting a drag; the grip handle owns the listeners.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Which messages to display — switches between Arm, Hand, and project level.
  const messages = activeHand
    ? (allMessages[activeHand] || [])
    : activeProject !== null
      ? (projectMessages[`project-${activeProject}`] || [])
      : (allMessages[activeFolder] || [])

  useEffect(() => {
    setMounted(true)
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        })
      )
    tick()
    const id = setInterval(tick, 1000)
    // Restore the model preference (diagram_model). Default is Sonnet on a fresh load / unknown value.
    try {
      const saved = localStorage.getItem('diagram_model')
      if (saved === 'claude-opus-4-6' || saved === 'claude-haiku-4-5-20251001' || saved === 'local-gpt-oss') setSelectedModel(saved)
      if (localStorage.getItem('diagram_tts_streaming') === 'on') setTtsStreaming(true)
    } catch { /* no storage */ }
    return () => clearInterval(id)
  }, [])

  // Persist the model choice (same localStorage pattern as the other toggle prefs).
  useEffect(() => {
    try { localStorage.setItem('diagram_model', selectedModel) } catch { /* no storage */ }
  }, [selectedModel])

  // Persist the streaming-TTS preference.
  useEffect(() => {
    try { localStorage.setItem('diagram_tts_streaming', ttsStreaming ? 'on' : 'off') } catch { /* no storage */ }
  }, [ttsStreaming])

  // ── Scribe (chronicle) loaders ─────────────────────────────────────────────
  // loadScribe = read-only (fast, no LLM); refreshScribe = lazy generation (refresh today's live
  // chapter + finalize yesterday). The server hash-guards so an unchanged day costs no LLM call.
  const loadScribe = useCallback(async () => {
    try {
      const res = await fetch('/api/scribe', { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.entries)) setScribeEntries(data.entries)
      setScribeLatest(data.latest ?? null)
      if (data.today) setScribeToday(data.today)
      if (data.quote) setScribeQuote(data.quote)
      if (data.word) setScribeWord(data.word)
    } catch { /* offline — ribbon keeps its last state */ }
  }, [])
  const refreshScribe = useCallback(async () => {
    setScribeRefreshing(true)
    try {
      const res = await fetch('/api/scribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rewrite: true }) })
      const data = await res.json()
      if (Array.isArray(data.entries)) setScribeEntries(data.entries)
      setScribeLatest(data.latest ?? null)
      if (data.today) setScribeToday(data.today)
      if (data.quote) setScribeQuote(data.quote)
      if (data.word) setScribeWord(data.word)
    } catch { /* offline */ } finally { setScribeRefreshing(false) }
  }, [])
  // On app open: load stored entries immediately (ribbon shows last chapter), then refresh today's
  // live chapter. The Scribe is a CONSTANT background process — re-mirror every few minutes while
  // the app is open. Each refresh is hash-guarded server-side, so an unchanged day costs no LLM
  // call (and it runs on the local model anyway), making continuous mirroring effectively free.
  useEffect(() => {
    // The chapter is built by the 3 scheduled checkpoints (+ the manual ↻) APPENDING passages — a
    // running story. Passive refreshes must NOT generate (that would append a fragment every few
    // minutes); on open + periodically we only RELOAD so the dashboard reflects the latest writes.
    loadScribe()
    const id = setInterval(() => { loadScribe() }, 4 * 60_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Chronicle keys: Esc closes; ← turns to the older day (left), → to the newer day (right).
  useEffect(() => {
    if (!scribeOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScribeOpen(false)
      else if (e.key === 'ArrowLeft') setScribeIndex(i => Math.min(i + 1, Math.max(scribeEntries.length - 1, 0)))
      else if (e.key === 'ArrowRight') setScribeIndex(i => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scribeOpen, scribeEntries.length])

  // Connect status + 7-day window on mount, refreshed every 15 minutes.
  useEffect(() => {
    refreshStatus()
    refreshWeek()
    const id = setInterval(refreshWeek, 15 * 60_000)
    return () => clearInterval(id)
  }, [refreshStatus, refreshWeek])

  // Month view: refetch whenever the schedule folder opens or the month changes.
  useEffect(() => {
    if (activeFolder === 'schedule') refreshMonth(viewMonth)
  }, [activeFolder, viewMonth, gcalConnected, refreshMonth])

  // Oura sync schedule: always paint the cached snapshot on mount; only force a
  // fresh pull from Oura between 7–11am (when its cloud refreshes after a morning
  // ring sync), then re-poll every 10 min inside that window. Webhooks remain the
  // real-time bonus on top of this guaranteed-floor schedule.
  useEffect(() => {
    refreshOura()
    if (withinOuraSyncWindow()) syncOura()
    const id = setInterval(() => { if (withinOuraSyncWindow()) syncOura() }, 10 * 60_000)
    return () => clearInterval(id)
  }, [refreshOura, syncOura])

  // Refetch Oura whenever the body folder is opened.
  useEffect(() => {
    if (activeFolder === 'body') refreshOura()
  }, [activeFolder, refreshOura])

  // Gym arm: hydrate on mount, and re-hydrate when the training arm opens.
  useEffect(() => { loadWorkouts() }, [loadWorkouts])
  useEffect(() => {
    if (activeFolder === 'training') loadWorkouts()
  }, [activeFolder, loadWorkouts])

  // One-time: when the workouts first load and TODAY has no logged session, open the day navigator
  // on the most RECENT workout so the history is visible immediately instead of an empty "today".
  // (The data was never lost — it just defaults to today, which is empty until a session is logged.)
  const gymJumpedRef = useRef(false)
  useEffect(() => {
    if (gymJumpedRef.current) return
    const dates = Object.keys(workouts)
    if (!dates.length) return
    gymJumpedRef.current = true
    if (!workouts[isoDate(new Date())]) {
      const latest = dates.sort().slice(-1)[0]
      if (latest) setViewDate(new Date(`${latest}T12:00:00`))   // noon avoids a TZ midnight day-shift
    }
  }, [workouts])

  // Escape closes the main conversation drawer.
  useEffect(() => {
    if (!mainDrawerOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMainDrawerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mainDrawerOpen])

  // After an OAuth redirect (?gcal=connected / ?oura=connected), refresh + clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('gcal')) {
      refreshStatus()
      refreshWeek()
    }
    if (params.get('oura')) {
      refreshOura()
    }
    if (params.get('gcal') || params.get('oura')) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [refreshStatus, refreshWeek, refreshOura])

  useEffect(() => {
    if (userScrolledUpRef.current) return
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const currentScrollTop = el.scrollTop
    if (currentScrollTop < lastScrollTopRef.current) {
      userScrolledUpRef.current = true
    }
    lastScrollTopRef.current = currentScrollTop
  }, [])

  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`
  }, [input])

  // Tear down the voice pipeline if the component unmounts mid-session.
  useEffect(() => () => {
    stopSpeaking()
    teardownMic()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close the settings dropdown when clicking outside of it.
  useEffect(() => {
    if (!settingsOpen) return
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [settingsOpen])

  // Close the input-bar "+" menu when clicking outside it.
  useEffect(() => {
    if (!plusOpen) return
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setPlusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [plusOpen])

  // Auto-grow the chat textarea up to a cap as the message wraps (resets when input clears).
  useEffect(() => {
    const ta = inputRef.current
    if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px` }
  }, [input])

  // ── Session helpers ────────────────────────────────────────────────────────
  // Set the display buffer (the rendered messages) for a scope. Folder scopes live
  // in allMessages; project scopes ('project-x') in projectMessages.
  const setScopeDisplay = (scope: string, msgs: Message[]) => {
    if (scope.startsWith('project-')) setProjectMessages(prev => ({ ...prev, [scope]: msgs }))
    else setAllMessages(prev => ({ ...prev, [scope]: msgs }))
  }

  const loadSessions = useCallback(async (scope: string) => {
    try {
      const res = await fetch(`/api/chat/sessions?folder_id=${encodeURIComponent(scope)}`, { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.sessions)) setSessions(prev => ({ ...prev, [scope]: data.sessions }))
    } catch { /* server offline */ }
  }, [])

  // Refresh the spatial tree + item index from /api/tree into the refs composeBase reads.
  // The server busts its tree cache on every diagram_nodes/notebooks/files write, so a
  // call right after a mutation returns fresh data — new items reach Spectre immediately,
  // not after the 30s TTL. Best-effort; the primer just omits the tree until it resolves.
  const refreshDiagramTree = useCallback(async () => {
    try {
      const res = await fetch('/api/tree', { cache: 'no-store' })
      const data = await res.json()
      if (typeof data.tree === 'string') diagramTreeRef.current = data.tree
      if (data.index) itemIndexRef.current = { notebooks: data.index.notebooks ?? {}, files: data.index.files ?? {} }
    } catch { /* offline — primer omits the tree until reconnect */ }
  }, [])

  // ── Diagram tree (Arms / Hands) ────────────────────────────────────────────────
  const loadNodes = useCallback(async () => {
    try {
      const res = await fetch('/api/nodes', { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.nodes)) {
        setNodes(data.nodes); nodesRef.current = data.nodes
        // Reconcile the legacy `projects` mirror from the persisted project Hands so a
        // reload reflects DB truth (progress/phase/etc.) instead of INITIAL_PROJECTS.
        setProjects(prev => prev.map(p => {
          const node = data.nodes.find((n: NodeMeta) => n.id === LEGACY_TO_NODE_ID[p.id])
          return node ? { ...p, name: node.name, progress: node.progress, phase: node.phase, description: node.description } : p
        }))
      }
    } catch { /* server offline — bento falls back to empty until reconnect */ }
    // Node create/delete/reorder all reconcile through here — keep Spectre's tree in sync.
    refreshDiagramTree()
  }, [refreshDiagramTree])

  // Apply a project edit to BOTH stores (legacy `projects` + the project Hand node) and
  // persist to the DB. Keyed by the legacy id ('lab' etc.). The single funnel for
  // every project mutation so the cards, the ProjectDetail panel, and the primer agree.
  const syncProject = useCallback((legacyId: string, patch: { progress?: number; phase?: string; description?: string; name?: string }) => {
    setProjects(prev => prev.map(p => p.id === legacyId ? { ...p, ...patch } : p))
    const nodeId = LEGACY_TO_NODE_ID[legacyId]
    if (nodeId) {
      setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, ...patch } : n))
      fetch(`/api/nodes/${nodeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {})
      // A name change alters the tree text Spectre reads (progress/phase don't appear there).
      if (patch.name !== undefined) refreshDiagramTree()
    }
  }, [refreshDiagramTree])

  // Projects landing: regenerate every Project Hand's activity summary (parallel Haiku,
  // server-side) and merge into state. Cards show the last-known node.summary until this
  // resolves. Called on every Projects-arm open — always fresh, no TTL.
  const loadProjectSummaries = useCallback(async () => {
    try {
      const res = await fetch('/api/nodes/summaries', { method: 'POST', cache: 'no-store' })
      const data = await res.json()
      if (data.summaries) setProjectSummaries(prev => ({ ...prev, ...data.summaries }))
    } catch { /* offline — cards fall back to persisted node.summary */ }
  }, [])

  // SOURCES — load a node's reference files into state.
  const loadFiles = useCallback(async (nodeId: string) => {
    try {
      const res = await fetch(`/api/files?node_id=${encodeURIComponent(nodeId)}`, { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.files)) {
        // Ref updated synchronously so an awaited load is visible to composeBase in the
        // same tick (the render-time ref sync only catches up after a re-render).
        sourceFilesRef.current = { ...sourceFilesRef.current, [nodeId]: data.files }
        setSourceFiles(prev => ({ ...prev, [nodeId]: data.files }))
      }
    } catch { /* offline */ }
  }, [])

  // Upload a reference file to a Project Hand's SOURCES, optimistically refreshing the list.
  const uploadFile = useCallback(async (nodeId: string, file: File): Promise<boolean> => {
    try {
      const form = new FormData()
      form.append('node_id', nodeId)
      form.append('file', file)
      const res = await fetch('/api/files/upload', { method: 'POST', body: form })
      const data = await res.json()
      if (data.file) {
        setSourceFiles(prev => ({ ...prev, [nodeId]: [data.file, ...(prev[nodeId] ?? [])] }))
        refreshDiagramTree()   // new Source must appear in Spectre's tree immediately
        return true
      }
    } catch { /* offline */ }
    return false
  }, [refreshDiagramTree])

  const deleteFile = useCallback(async (nodeId: string, id: string) => {
    setSourceFiles(prev => ({ ...prev, [nodeId]: (prev[nodeId] ?? []).filter(f => f.id !== id) }))
    try { await fetch(`/api/files/${id}`, { method: 'DELETE' }); refreshDiagramTree() } catch { /* offline */ }
  }, [refreshDiagramTree])

  // ── Notebooks CRUD (Docu-scape) — all keyed by scope (node) id ───────────────────
  const loadNotebooks = useCallback(async (nodeId: string) => {
    try {
      const res = await fetch(`/api/notebooks?node_id=${encodeURIComponent(nodeId)}&all=1`, { cache: 'no-store' })
      const data = await res.json()
      if (Array.isArray(data.notebooks)) {
        // Ref updated synchronously so an awaited load is visible to composeBase in the
        // same tick (the render-time ref sync only catches up after a re-render).
        notebooksByNodeRef.current = { ...notebooksByNodeRef.current, [nodeId]: data.notebooks }
        setNotebooksByNode(prev => ({ ...prev, [nodeId]: data.notebooks }))
      }
    } catch { /* offline */ }
  }, [])

  // ── Librarian handlers (the autonomous document organizer) ──────────────────────
  const refreshLibrarianPending = useCallback(async () => {
    try { const r = await fetch('/api/librarian'); const d = await r.json(); setLibrarianPending(Array.isArray(d.plans) ? d.plans.length : 0) } catch { /* offline */ }
  }, [])

  const loadLibrarianFolders = useCallback(async (nodeId: string) => {
    try {
      const r = await fetch(`/api/notebooks?node_id=${encodeURIComponent(nodeId)}&all=1`, { cache: 'no-store' })
      const d = await r.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setLibrarianFolders((d.notebooks ?? []).filter((n: any) => n.type === 'folder').map((n: any) => ({ id: n.id, title: n.title })))
    } catch { setLibrarianFolders([]) }
  }, [])

  // Pre-check high-confidence pending actions; leave low-confidence ones unchecked for a human look.
  const seedLibrarianApproval = useCallback((plan: LibrarianPlan | null) => {
    const s = new Set<string>()
    if (plan) for (const a of plan.actions) if (a.status === 'pending' && a.confidence === 'high') s.add(a.id)
    setLibrarianApproved(s); setLibrarianEdits({})
  }, [])

  const openLibrarian = useCallback(async (nodeId: string) => {
    setLibrarianOpen(true); setLibrarianNodeId(nodeId); setLibrarianResult(null); setLibrarianPlan(null)
    loadLibrarianFolders(nodeId)
    try { const r = await fetch(`/api/librarian?node_id=${encodeURIComponent(nodeId)}`); const d = await r.json(); setLibrarianPlan(d.plan ?? null); seedLibrarianApproval(d.plan ?? null) } catch { /* offline */ }
  }, [loadLibrarianFolders, seedLibrarianApproval])

  const runLibrarian = useCallback(async (nodeId: string) => {
    setLibrarianBusy(true); setLibrarianResult(null)
    try {
      const r = await fetch('/api/librarian', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'generate', node_id: nodeId }) })
      const d = await r.json(); setLibrarianPlan(d.plan ?? null); seedLibrarianApproval(d.plan ?? null); loadLibrarianFolders(nodeId); refreshLibrarianPending()
    } catch { /* offline */ } finally { setLibrarianBusy(false) }
  }, [seedLibrarianApproval, loadLibrarianFolders, refreshLibrarianPending])

  const applyLibrarian = useCallback(async () => {
    if (!librarianPlan) return
    setLibrarianBusy(true)
    try {
      const r = await fetch('/api/librarian', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'apply', plan_id: librarianPlan.id, approved: Array.from(librarianApproved), edits: librarianEdits }) })
      const d = await r.json()
      setLibrarianResult(`Done — ${d.applied ?? 0} applied${d.failed ? `, ${d.failed} couldn't be` : ''}.`)
      setLibrarianPlan(d.plan ?? null)
      if (librarianNodeId) loadNotebooks(librarianNodeId)
      refreshDiagramTree(); refreshLibrarianPending()
    } catch { setLibrarianResult('Something went wrong applying the plan.') } finally { setLibrarianBusy(false) }
  }, [librarianPlan, librarianApproved, librarianEdits, librarianNodeId, loadNotebooks, refreshDiagramTree, refreshLibrarianPending])

  const dismissLibrarian = useCallback(async () => {
    const id = librarianPlan?.id
    setLibrarianOpen(false)
    if (id) { try { await fetch('/api/librarian', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'dismiss', plan_id: id }) }) } catch { /* offline */ } }
    setLibrarianPlan(null); refreshLibrarianPending()
  }, [librarianPlan, refreshLibrarianPending])

  const toggleLibrarianApprove = useCallback((id: string) => {
    setLibrarianApproved(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }, [])

  const redirectLibrarianMove = useCallback((id: string, patch: { target_folder_id?: string; target_new_folder?: string }) => {
    setLibrarianEdits(prev => ({ ...prev, [id]: patch }))
    setLibrarianApproved(prev => new Set(prev).add(id))   // redirecting a move implies you want it
  }, [])

  useEffect(() => { void refreshLibrarianPending() }, [refreshLibrarianPending])

  const createNotebookRemote = useCallback(async (nodeId: string, opts: {
    title: string; type: 'folder' | 'notebook'; parent_id?: string; icon?: string; color?: string; content?: string; created_by?: string
  }): Promise<NotebookMeta | null> => {
    try {
      const res = await fetch('/api/notebooks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId, ...opts }),
      })
      const data = await res.json()
      if (data.notebook) { await loadNotebooks(nodeId); refreshDiagramTree(); return data.notebook as NotebookMeta }
    } catch { /* offline */ }
    return null
  }, [loadNotebooks, refreshDiagramTree])

  const updateNotebookRemote = useCallback(async (nodeId: string, id: string, patch: {
    title?: string; content?: string; icon?: string; color?: string; parent_id?: string; position?: number
  }, opts: { reload?: boolean } = {}) => {
    // Optimistic local patch so the grid/editor react instantly.
    setNotebooksByNode(prev => ({ ...prev, [nodeId]: (prev[nodeId] ?? []).map(n => n.id === id ? { ...n, ...patch, updated_at: Date.now() } : n) }))
    try {
      await fetch(`/api/notebooks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      if (opts.reload) await loadNotebooks(nodeId)
      // Title/move changes alter the tree Spectre reads; content autosaves don't (skip those).
      if (patch.title !== undefined || patch.parent_id !== undefined) refreshDiagramTree()
    } catch { /* offline */ }
  }, [loadNotebooks, refreshDiagramTree])

  const deleteNotebookRemote = useCallback(async (nodeId: string, id: string) => {
    setNotebooksByNode(prev => ({ ...prev, [nodeId]: (prev[nodeId] ?? []).filter(n => n.id !== id && n.parent_id !== id) }))
    if (openNotebookIdRef.current === id) { setOpenNotebookId(null); setNotebookFocus(false) }
    try { await fetch(`/api/notebooks/${id}`, { method: 'DELETE' }); refreshDiagramTree() } catch { /* offline */ }
  }, [refreshDiagramTree])

  // Reorder notebooks within one level (drag-and-drop) — persist each new position.
  const reorderNotebooks = useCallback((nodeId: string, parentId: string, orderedIds: string[]) => {
    setNotebooksByNode(prev => ({
      ...prev,
      [nodeId]: (prev[nodeId] ?? []).map(n => n.parent_id === parentId ? { ...n, position: orderedIds.indexOf(n.id) } : n),
    }))
    orderedIds.forEach((id, position) => {
      fetch(`/api/notebooks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position }) }).catch(() => {})
    })
  }, [])

  // Escape exits notebook focus mode (the editor consumes Escape only to dismiss a ghost
  // suggestion, otherwise it bubbles here).
  useEffect(() => {
    if (!notebookFocus) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotebookFocus(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notebookFocus])

  // ── Chat attachments (file/image upload on any message) ─────────────────────────
  // The scope a chat attachment / message belongs to (same resolution as sendMessage).
  const chatScope = useCallback(() =>
    activeHandRef.current ?? (activeProjectRef.current ? `project-${activeProjectRef.current}` : activeFolderRef.current),
  [])

  // Stage one or more files into the composer: validate, build previews (images get a
  // base64 + object URL), and upload to /api/files/upload with source='chat'.
  const handleChatFiles = useCallback((files: File[]) => {
    const scope = chatScope()
    const staged: PendingAttachment[] = []
    for (const file of files) {
      let ext = (file.name.includes('.') ? file.name.split('.').pop() ?? '' : '').toLowerCase()
      // Pasted screenshots often arrive without a filename extension — derive from MIME.
      if (!CHAT_ALLOWED_EXT.includes(ext) && file.type.startsWith('image/')) {
        const mt = file.type.split('/')[1]
        ext = mt === 'jpeg' ? 'jpg' : mt
      }
      if (!CHAT_ALLOWED_EXT.includes(ext)) continue
      const filename = file.name && file.name.includes('.') ? file.name : `pasted-image.${ext}`
      if (file.size > MAX_ATTACH_BYTES) {
        setChatAttachments(prev => [...prev, {
          localId: randomLocalId(), file, filename, file_type: ext,
          size_bytes: file.size, kind: attachKind(ext), uploading: false,
          error: 'Too large (max 25MB)',
        }])
        continue
      }
      const kind = attachKind(ext)
      const att: PendingAttachment = {
        localId: randomLocalId(), file, filename, file_type: ext,
        size_bytes: file.size, kind, uploading: true,
        previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
        mediaType: kind === 'image' ? (file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`) : undefined,
      }
      // Images: read base64 for the Claude image content block (live turn).
      if (kind === 'image') {
        att.base64Promise = new Promise<string | undefined>(resolve => {
          const reader = new FileReader()
          reader.onload = () => {
            const res = String(reader.result)
            const b64 = res.includes(',') ? res.split(',')[1] : res
            setChatAttachments(prev => prev.map(p => p.localId === att.localId ? { ...p, base64: b64 } : p))
            resolve(b64)
          }
          reader.onerror = () => resolve(undefined)
          reader.readAsDataURL(file)
        })
      }
      // Upload (source='chat') so the file persists + gets an id for text extraction.
      att.uploadPromise = (async (): Promise<string | undefined> => {
        try {
          const form = new FormData()
          form.append('node_id', scope)
          form.append('source', 'chat')
          form.append('file', file)
          const res = await fetch('/api/files/upload', { method: 'POST', body: form })
          const data = await res.json()
          setChatAttachments(prev => prev.map(p => p.localId === att.localId
            ? { ...p, uploading: false, fileId: data.file?.id, error: data.file ? undefined : 'Upload failed' }
            : p))
          return data.file?.id
        } catch {
          setChatAttachments(prev => prev.map(p => p.localId === att.localId ? { ...p, uploading: false, error: 'Upload failed' } : p))
          return undefined
        }
      })()
      staged.push(att)
    }
    if (staged.length) setChatAttachments(prev => [...prev, ...staged])
  }, [chatScope])

  const removeChatAttachment = useCallback((localId: string) => {
    setChatAttachments(prev => {
      const target = prev.find(p => p.localId === localId)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(p => p.localId !== localId)
    })
  }, [])

  const clearChatAttachments = useCallback(() => {
    setChatAttachments(prev => { prev.forEach(p => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl) }); return [] })
  }, [])

  // ── Sections / tags (project Hand chat organization) ───────────────────────────
  // The active tag filter persists per node in localStorage so it restores on return.
  const tagFilterKey = (nodeId: string) => `diagram_tag_filter_${nodeId}`

  // Load a node's tags and restore its saved active-tag filter (null = "All").
  const loadTags = useCallback(async (nodeId: string) => {
    let restored: string | null = null
    try { const v = localStorage.getItem(tagFilterKey(nodeId)); restored = v && v !== 'all' ? v : null } catch { /* no storage */ }
    try {
      const res = await fetch(`/api/tags?node_id=${encodeURIComponent(nodeId)}`, { cache: 'no-store' })
      const data = await res.json()
      const tags: Tag[] = Array.isArray(data.tags) ? data.tags : []
      setTagsByNode(prev => ({ ...prev, [nodeId]: tags }))
      // Drop a stale saved filter if its tag no longer exists.
      if (restored && !tags.some(t => t.id === restored)) restored = null
    } catch { /* offline */ }
    setActiveTagByScope(prev => ({ ...prev, [nodeId]: restored }))
  }, [])

  // Set (and persist) the active tag filter for a scope.
  const setActiveTag = useCallback((scope: string, tagId: string | null) => {
    setActiveTagByScope(prev => ({ ...prev, [scope]: tagId }))
    try { localStorage.setItem(tagFilterKey(scope), tagId ?? 'all') } catch { /* no storage */ }
  }, [])

  // Create a section/tag and append it. Does NOT change the active filter — auto-activating
  // the new (empty) section hid every chat, so the feature felt broken (you couldn't even see
  // chats to assign them). Tag chats via right-click → MOVE TO SECTION, then filter by the pill.
  const createTagRemote = useCallback(async (nodeId: string, name: string): Promise<Tag | null> => {
    try {
      const res = await fetch('/api/tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId, name }),
      })
      const data = await res.json()
      if (data.tag) {
        setTagsByNode(prev => ({ ...prev, [nodeId]: [...(prev[nodeId] ?? []), data.tag] }))
        return data.tag as Tag
      }
    } catch { /* offline */ }
    return null
  }, [])

  // Delete a tag; its sessions become untagged. Reset the filter to "All" if it was active.
  const deleteTagRemote = useCallback(async (nodeId: string, id: string) => {
    setTagsByNode(prev => ({ ...prev, [nodeId]: (prev[nodeId] ?? []).filter(t => t.id !== id) }))
    setActiveTagByScope(prev => (prev[nodeId] === id ? { ...prev, [nodeId]: null } : prev))
    try { localStorage.removeItem(tagFilterKey(nodeId)) } catch { /* no storage */ }
    try { await fetch(`/api/tags/${id}`, { method: 'DELETE' }) } catch { /* offline */ }
    loadSessions(nodeId)
  }, [loadSessions])

  // Set or clear a session's tag (context menu). Optimistic, then refresh the list.
  const setSessionTagRemote = useCallback(async (scope: string, sessionId: string, tagId: string | null) => {
    setSessions(prev => ({
      ...prev,
      [scope]: (prev[scope] ?? []).map(s => s.id === sessionId ? { ...s, tag_id: tagId } : s),
    }))
    try {
      await fetch(`/api/sessions/${sessionId}/tag`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: tagId }),
      })
    } catch { /* offline */ }
  }, [])

  // Ordered Arms (level 'arm'), and the Hands of a given Arm.
  const arms = nodes.filter(n => n.level === 'arm' && !n.is_archived).sort((a, b) => a.position - b.position)
  const handsOf = useCallback((armId: string | null) =>
    nodes.filter(n => n.level === 'hand' && n.parent_id === armId && !n.is_archived).sort((a, b) => a.position - b.position),
  [nodes])
  const nodeById = useCallback((id: string | null) => id ? nodesRef.current.find(n => n.id === id) ?? null : null, [])

  useEffect(() => { loadNodes() }, [loadNodes])
  // Prime Spectre's spatial tree on first load so navigation works from the very first turn.
  useEffect(() => { refreshDiagramTree() }, [refreshDiagramTree])
  // Re-pull the tree on every navigation so "Current location" + the structure stay live
  // (the 30s server cache keeps this cheap — most calls return the cached string).
  useEffect(() => { refreshDiagramTree() }, [activeFolder, activeProject, activeHand, refreshDiagramTree])
  // Prime the dashboard Projects widget with fresh summaries on first load (Haiku is
  // skipped server-side when there's no new activity, so this is cheap).
  useEffect(() => { loadProjectSummaries() }, [loadProjectSummaries])

  // Persist a new bento order: PATCH each Arm whose position changed, then reconcile.
  const persistArmOrder = useCallback(async (ordered: NodeMeta[]) => {
    try {
      await Promise.all(ordered.map((n, i) =>
        n.position === i ? null : fetch(`/api/nodes/${n.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: i }),
        }),
      ))
      loadNodes()
    } catch { /* offline — optimistic order still holds locally */ }
  }, [loadNodes])

  // Create an Arm or Hand. Optimistic; reconciles from the server response.
  const createNodeRemote = useCallback(async (payload: {
    name: string; level: NodeLevel; parent_id?: string | null; template: NodeTemplate; icon: string
  }): Promise<NodeMeta | null> => {
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, primer: TEMPLATE_PRIMERS[payload.template] }),
      })
      const data = await res.json()
      if (data.node) {
        const created = data.node as NodeMeta
        setNodes(prev => [...prev, created])
        refreshDiagramTree()   // new Arm/Hand must appear in Spectre's tree immediately
        // Upgrade the placeholder template primer to a personalized Haiku-generated
        // default (fire-and-forget; the node already carries the template primer, so
        // it is never empty in the meantime). Mirrors the smart chat-naming pattern.
        fetch(`/api/nodes/${created.id}/primer`, { method: 'POST' })
          .then(r => (r.ok ? r.json() : null))
          .then(d => { if (d?.primer) setNodes(prev => prev.map(n => n.id === created.id ? { ...n, primer: d.primer } : n)) })
          .catch(() => { /* offline / Haiku down — template primer stands */ })
        return created
      }
    } catch { /* offline */ }
    return null
  }, [refreshDiagramTree])

  // Export a conversation to a downloadable markdown file (client-side). Pulls the
  // session's surviving, in-context, non-compressed turns and formats You/Spectre.
  const exportSession = useCallback(async (scope: string, sid: string) => {
    try {
      const res = await fetch(`/api/chat/sessions/${sid}/messages`, { cache: 'no-store' })
      const data = await res.json()
      const rows: SessionMsg[] = Array.isArray(data.messages) ? data.messages : []
      const turns = rows.filter(r => !r.is_compressed && r.in_context && !r.deleted_at)
      const meta = sessionsRef.current[scope]?.find(s => s.id === sid)
      const title = meta?.title ?? 'Conversation'
      const armName = scope === 'main' ? 'Spectre' : (nodeById(scope)?.name ?? armLabel(scope) ?? scope)
      const created = meta ? new Date(meta.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
      const bodyMd = turns.map(t => `**${t.role === 'user' ? 'You' : 'Spectre'}:** ${t.content}`).join('\n\n')
      const md = `# ${title}\n${armName} — ${created}\n\n---\n\n${bodyMd}\n\n---\n*Exported from The Diagram — ${new Date().toLocaleString()}*\n`
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'conversation'
      const date = isoDate(new Date())
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}-${date}.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch { /* offline — export unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeById])

  // Save a node's primer (PATCH) + update local state so buildPrimer picks it up.
  const saveNodePrimer = useCallback(async (id: string, primer: string) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, primer } : n))
    try {
      await fetch(`/api/nodes/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primer }),
      })
    } catch { /* offline — local state already updated */ }
  }, [])

  // Soft-archive a node (and all its child Hands if it's an Arm). Sessions are preserved.
  const deleteNodeRemote = useCallback(async (id: string, level: NodeLevel) => {
    if (level === 'arm') {
      const childHands = nodesRef.current.filter(n => n.level === 'hand' && n.parent_id === id && !n.is_archived)
      await Promise.all(childHands.map(h => fetch(`/api/nodes/${h.id}`, { method: 'DELETE' }).catch(() => {})))
    }
    try { await fetch(`/api/nodes/${id}`, { method: 'DELETE' }) } catch { /* offline */ }
    setNodes(prev => prev.map(n => {
      if (n.id === id) return { ...n, is_archived: 1 }
      if (level === 'arm' && n.parent_id === id) return { ...n, is_archived: 1 }
      return n
    }))
    refreshDiagramTree()   // archived node must drop out of Spectre's tree immediately
  }, [refreshDiagramTree])

  // Rename a node (PATCH name) + update local state.
  const renameNodeRemote = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setNodes(prev => prev.map(n => n.id === id ? { ...n, name: trimmed } : n))
    try {
      await fetch(`/api/nodes/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      refreshDiagramTree()   // renamed node label changes the tree Spectre reads
    } catch { /* offline */ }
  }, [refreshDiagramTree])

  // ── Instructional primer for a scope (editable node primer + live-data block) ──
  // Shared by sendMessage and the edit/retry regeneration path. CORE keeps its
  // aggregate dashboard primer; Arms/Hands use their diagram_nodes.primer.
  // Spatial-awareness prefix injected on EVERY turn (all scopes): the full live tree,
  // Spectre's current location, and the navigation/file-control semantic guide. Built
  // from refs (the tree is refreshed from /api/tree on nav + create/delete) so it stays
  // synchronous. Always present so Spectre can navigate from anywhere, including CORE.
  const buildSpatialPrefix = useCallback((scope: string): string => {
    const tree = diagramTreeRef.current
    const nameOf = (id: string) => id === 'main' ? 'CORE' : (nodesRef.current.find(n => n.id === id)?.name ?? id)
    const locName = scope === 'main' ? 'CORE (the main dashboard)' : nameOf(scope)
    const loc = `Current location: ${locName} (${scope})`
    // "go back" support: the trail of recently-visited nodes (most recent previous first),
    // excluding the current one. Spectre navigates to the first entry to go back.
    const prev = navHistoryRef.current.filter(s => s !== scope).reverse()
    const back = prev.length
      ? `\nRecently visited (newest first, for "go back"): ${prev.map(s => `${nameOf(s)} (${s})`).join(', ')}`
      : ''
    return `${tree ? tree + '\n\n' : ''}${loc}${back}\n\n${NAV_CONTROL_PRIMER}\n\n`
  }, [])

  // STABLE primer — the cacheable prefix. Everything that does NOT change turn-to-turn:
  // diagram tree, nav rules, node primer, live-data blocks (these change only on a data sync,
  // not every turn), sources + notebooks. The per-minute timestamp is the one thing pulled
  // out (composeVolatile) so the prompt cache (llama-server prefix reuse / Anthropic
  // cache_control) is reused every turn instead of re-prefilling the whole ~5-6k-token primer.
  const composeStable = useCallback((scope: string): string => {
    const spatial = buildSpatialPrefix(scope)
    const node = nodesRef.current.find(n => n.id === scope) ?? null
    const profile = getInjectionProfile(scope, node)
    if (scope === 'main') {
      // CORE — full dashboard. The [DIAGRAM TREE] already names every Arm, so the old
      // per-Arm primer-gist summaries ([ARMS — what each space is for]) were redundant
      // standing weight and were dropped. If re-added later, do it on-fetch, not standing.
      return spatial + buildMainPrimer(weekEventsRef.current, bodyStatsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current)
    }
    // The training scope's live block is entirely viewed-day / open-block dependent (pure UI nav
    // state), so it rides the VOLATILE current turn (see the turnContext builders), NOT this
    // cacheable prefix — otherwise navigating gym days/blocks busts the whole prompt cache mid-chat.
    const liveBlock = scope === 'training' ? '' : buildLiveBlock(scope, weekEventsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current, exercisesRef.current, viewDateRef.current, openBlockRef.current)
    // Global calendar everywhere (schedule is "globally useful"), except the schedule
    // arm itself — its buildLiveBlock already injects the calendar, so skip to avoid
    // duplication. Derived from template (not a hardcoded name).
    const calendarBlock = profile.calendar && node?.template !== 'schedule' ? buildGlobalCalendarBlock(weekEventsRef.current) : ''
    // Project Hands get a lightweight Sources index (filenames + ids only, never content)
    // so Spectre knows what reference files exist and can pull them via a readFile action.
    const isProjectHand = node?.level === 'hand' && node?.parent_id === 'projects'
    const sourcesBlock = isProjectHand ? buildSourcesBlock(sourceFilesRef.current[scope] ?? []) : ''
    // Notebooks index (+ open-notebook content) so Spectre can create/read/write documents.
    const openNb = openNotebookContentRef.current && openNotebookIdRef.current === openNotebookContentRef.current.id ? openNotebookContentRef.current : null
    const notebooksBlock = isProjectHand ? buildNotebooksBlock(notebooksByNodeRef.current[scope] ?? [], openNb) : ''
    if (node) {
      const primerText = node.primer?.trim() || TEMPLATE_PRIMERS[node.template] || ''
      // Hands carry a one-line gist of their parent arm's primer (summary only).
      const parent = node.level === 'hand' && node.parent_id ? (nodesRef.current.find(n => n.id === node.parent_id) ?? null) : null
      const parentName = parent?.name ?? (node.level === 'hand' && node.parent_id ? 'its parent' : '')
      const parentGist = parent ? firstSentence(parent.primer?.trim() || TEMPLATE_PRIMERS[parent.template] || '') : ''
      const parentLine = parentName
        ? `You are in ${node.name}, within the ${parentName} Arm.${parentGist ? ` (${parentName}: ${parentGist})` : ''}\n\n`
        : ''
      return spatial + `${parentLine}${primerText}${liveBlock}${calendarBlock}${sourcesBlock}${notebooksBlock}`.trim()
    }
    return spatial + (PROJECT_PRIMERS[scope] ?? '') + liveBlock + calendarBlock + sourcesBlock + notebooksBlock
  }, [buildSpatialPrefix])

  // VOLATILE per-turn block — only the timestamp (changes every minute). Injected into the
  // current user turn (not the primer) so the cache prefix stays byte-identical across turns.
  const composeVolatile = useCallback((): string => `Current time: ${formatNow()}`, [])

  // Convenience wrapper (stable primer + the timestamp) for ghost text / thought bubbles
  // (runSpectrePlain) — one-off, non-cached calls that don't separate the two.
  const composeBase = useCallback((scope: string): string => `${composeStable(scope)}\n\n${composeVolatile()}`, [composeStable, composeVolatile])

  // AGENT-PATH context — the live-awareness block for the unified tool-framework path. Same
  // spatial tree + node primer + live dashboard/arm data as composeStable, but WITHOUT the
  // pieces the native tools replace: NAV_CONTROL_PRIMER (navigate/open are tools now), the
  // Sources/Notebooks prose indexes (list_documents/read_document are tools), and any stale
  // "emit an updateNode action" instruction (update_project is a tool). This is what finally
  // lets Spectre SEE the user's day on the new path. Sent per-turn; the timestamp rides the user turn.
  const composeAgentContext = useCallback((scope: string): string => {
    const tree = diagramTreeRef.current
    const nameOf = (id: string) => id === 'main' ? 'CORE' : (nodesRef.current.find(n => n.id === id)?.name ?? id)
    const locName = scope === 'main' ? 'CORE (the main dashboard)' : nameOf(scope)
    const prev = navHistoryRef.current.filter(s => s !== scope).reverse()
    const back = prev.length ? `\nRecently visited (newest first, for "go back"): ${prev.map(s => `${nameOf(s)} (${s})`).join(', ')}` : ''
    const spatial = `${tree ? tree + '\n\n' : ''}Current location: ${locName} (${scope})${back}\n${rhythmContextLine(new Date())}`
    if (scope === 'main') {
      return `${spatial}\n\n${buildMainPrimer(weekEventsRef.current, bodyStatsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current)}`
    }
    const node = nodesRef.current.find(n => n.id === scope) ?? null
    const liveBlock = buildLiveBlock(scope, weekEventsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current, exercisesRef.current, viewDateRef.current, openBlockRef.current)
      .replace(/\n\nTo change its progress[\s\S]*?action with id "[^"]*"\./g, '')   // drop legacy prose-action line — tools replace it
    const calendarBlock = node?.template !== 'schedule' ? buildGlobalCalendarBlock(weekEventsRef.current) : ''
    const primerText = node?.primer?.trim() || (node ? (TEMPLATE_PRIMERS[node.template] ?? '') : (PROJECT_PRIMERS[scope] ?? ''))
    const parent = node?.level === 'hand' && node?.parent_id ? (nodesRef.current.find(n => n.id === node.parent_id) ?? null) : null
    const parentLine = parent && node ? `You are in ${node.name}, within the ${parent.name} Arm.\n\n` : ''
    return `${spatial}\n\n${`${parentLine}${primerText}${liveBlock}${calendarBlock}`.trim()}`
  }, [])

  // Guarantee the ambient directory before composing a project-Hand primer: if this
  // scope's notebooks/files were never loaded this session (deep link, voice nav, any
  // path that skipped the card-click loaders), fetch them now — otherwise the
  // [NOTEBOOKS IN THIS PROJECT] block would falsely claim "(no notebooks yet)". No-op
  // (zero awaits) once loaded; loaders fail silently offline, so this never blocks a send.
  const ensureProjectContextLoaded = useCallback(async (scope: string) => {
    const node = nodesRef.current.find(n => n.id === scope)
    if (!(node?.level === 'hand' && node.parent_id === 'projects')) return
    const jobs: Promise<void>[] = []
    if (notebooksByNodeRef.current[scope] === undefined) jobs.push(loadNotebooks(scope))
    if (sourceFilesRef.current[scope] === undefined) jobs.push(loadFiles(scope))
    if (jobs.length) await Promise.all(jobs)
  }, [loadNotebooks, loadFiles])

  // ── Open-document context (the "second screen") ──────────────────────────────────
  // When a Source file is open in the preview pane, it's the document the user is actively
  // referencing. On EVERY turn we silently semantic-search ONLY that document's chunks with
  // the current message and inject the most relevant sections as a system-level block — so
  // "consult that again" always re-queries the live index with the NEW question and pulls
  // exactly the section that's relevant now, instead of a stale once-read blob. Never a
  // chat bubble. Empty + silent when nothing is open / the vault is down.
  const fetchOpenDocContext = useCallback(async (queryText: string): Promise<string> => {
    const fileId = previewFileIdRef.current
    if (!fileId) return ''
    const q = (queryText || '').slice(0, 500).trim()
    if (!q) return ''
    const name = findFileMeta(fileId)?.filename ?? 'the open document'
    try {
      const res = await fetch('/api/vault/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, source_id: fileId, source_type: 'file', limit: 6, threshold: 0.2 }),
      })
      const data = await res.json().catch(() => ({ results: [] }))
      const results: VaultResult[] = Array.isArray(data?.results) ? data.results : []
      if (!results.length) return ''
      let block = `\n\n[OPEN DOCUMENT — "${name}"]\n${USER_CAP} has this document open and is referencing it. These are the sections most relevant to the current message (re-queried live each turn — treat this as glancing at the open document, not a one-time read):\n`
      for (const r of results) {
        const excerpt = r.text.split(/\s+/).slice(0, 220).join(' ')
        const entry = `\n— ${excerpt}\n`
        if (block.length + entry.length > 4000) break   // ~1k token cap for the open doc
        block += entry
      }
      return block + '\n---'
    } catch { return '' }
  }, [])

  // ── Notebook ghost text + thought-bubble confirmation (routed through Spectre) ───
  // Both reuse the project-aware primer (composeBase) as the first turn so Spectre knows
  // the project + open document, then a focused instruction turn. skipMemory + no session
  // persistence (these never touch /api/chat/sessions). Action JSON is stripped client-side.
  const runSpectrePlain = useCallback(async (scope: string, instruction: string): Promise<string> => {
    const base = composeBase(scope)
    const apiMessages = [
      { role: 'user', content: base },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: instruction },
    ]
    try {
      const res = await fetch('/api/spectre', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, model: backendFor(selectedModelRef.current), modelId: selectedModelRef.current, voice: false, skipMemory: true, save: false, think: false }),
      })
      if (!res.ok || !res.body) return ''
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let acc = ''
      while (true) { const { done, value } = await reader.read(); if (done) break; acc += dec.decode(value) }
      return stripJsonForDisplay(acc.split(SEARCH_MARKER).join('')).trim()
    } catch { return '' }
  }, [composeBase])

  // Ghost completion: continue the current paragraph in the document's style/voice/topic.
  const ghostComplete = useCallback(async (paragraph: string, docMarkdown: string): Promise<string> => {
    const scope = chatScope()
    const instruction =
      `You are helping complete a document. Continue the following text naturally in the same style, voice, and topic. Return ONLY the continuation — 1-2 sentences maximum, no explanation, no preamble.\n\n` +
      `[DOCUMENT SO FAR]\n${docMarkdown.slice(0, 2000)}\n\n[CONTINUE THIS PARAGRAPH]\n${paragraph}`
    return runSpectrePlain(scope, instruction)
  }, [chatScope, runSpectrePlain])

  // Thought-bubble gate: ask Spectre whether a structural suggestion is worth surfacing.
  const thoughtConfirm = useCallback(async (paragraph: string, label: string): Promise<boolean> => {
    const scope = chatScope()
    const instruction = `Should I suggest formatting this as ${label}? Reply YES or NO only.\n\n${paragraph}`
    const reply = (await runSpectrePlain(scope, instruction)).toUpperCase()
    return /\bYES\b/.test(reply)
  }, [chatScope, runSpectrePlain])

  // Functional updater for a scope's display buffer (project scopes vs. the rest).
  const updateScopeDisplay = useCallback((scope: string, updater: (prev: Message[]) => Message[]) => {
    if (scope.startsWith('project-')) setProjectMessages(all => ({ ...all, [scope]: updater(all[scope] || []) }))
    else setAllMessages(all => ({ ...all, [scope]: updater(all[scope] || []) }))
  }, [])

  // ── FIX 2 — transient-failure retry around /api/spectre ─────────────────────────
  // Speak a single standalone line (the retry notice) outside the sentence queue, so it
  // doesn't disturb the TTS state machine — the queue is idle when a request fails.
  const speakOneOff = useCallback(async (line: string) => {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line, provider: ttsModeRef.current === 'local' ? 'local' : 'cartesia' }),
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = getTtsAudio()
      audio.muted = false
      audio.src = url
      // Register on currentAudioRef so stopSpeaking()/exitVoiceMode can halt a one-off line
      // (failover notice, "one moment…") — previously it played on the shared element invisibly
      // to stopSpeaking, so it kept talking after an interrupt/exit (part of S4).
      currentAudioRef.current = audio
      const clear = () => { URL.revokeObjectURL(url); if (currentAudioRef.current === audio) currentAudioRef.current = null }
      audio.onended = clear
      audio.onerror = clear
      await audio.play().catch(() => {})
    } catch { /* the notice is best-effort */ }
  }, [])

  // ── Rhythm: the wind-down interception ──────────────────
  // Client-side timer (there is no server→client channel — the server heartbeat covers
  // push; THIS covers the at-PC experience). Inside [windDownAt, asleepBy): offer the
  // takeover once, speak the call once (best-effort — autoplay may be gesture-locked).
  // Declined tonight → silent until tomorrow. Snoozed → the corner chip, no re-pings.
  useEffect(() => {
    const check = () => {
      const now = new Date()
      const { windDown, asleepBy } = rhythmTimes(now)
      if (now < windDown || now >= asleepBy) {
        setWindDownOffer(prev => (prev ? null : prev))
        return
      }
      if (windDownOpenRef.current) return
      const dk = localDateStr(now.getTime())
      if (localStorage.getItem(`rhythm_dismissed_${dk}`)) return
      setWindDownOffer(prev => prev ?? 'card')
      if (!localStorage.getItem(`rhythm_announced_${dk}`)) {
        localStorage.setItem(`rhythm_announced_${dk}`, '1')
        speakOneOff(windDownLine(now))
      }
    }
    check()
    const id = setInterval(check, 30_000)
    return () => clearInterval(id)
  }, [speakOneOff])

  // POST to /api/spectre with ONE automatic retry on a transient failure (the route returns
  // 503 for overloaded/unavailable/timeout; a client-side network drop or fetch timeout is
  // also transient). Logs the real status + body on every failure. Returns the streaming
  // Response on success. On final failure throws an Error tagged `.transient` so the caller
  // shows the right UI: transient → "temporarily unreachable — tap to retry"; hard (credits/
  // auth) → the server's actionable reason. In voice mode it speaks a brief notice + waits 2s
  // before the retry.
  const postSpectre = useCallback(async (body: Record<string, unknown>, voice: boolean): Promise<Response> => {
    let transientMsg = 'Spectre is temporarily unreachable — tap to retry'
    // The interrupt flag means "an interrupt was requested for THIS in-flight fetch" — clear it as
    // each call begins so a flag left set by a prior interrupt (e.g. one that landed during a drain
    // regenerate, which never resets it) can't suppress a legitimate transient retry on this turn.
    spectreInterruptRef.current = false
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        console.warn('[Spectre] transient failure — retrying once after 2s')
        if (voice && voiceModeRef.current) speakOneOff('One moment — let me try that again.')
        await new Promise(r => setTimeout(r, 2000))
      }
      let res: Response
      // ONE AbortController for the whole fetch, exposed via spectreStreamAbortRef so a voice
      // interrupt (handleMicTap during THINKING) can abort the in-flight BODY stream — the real
      // S2 cancellation. A 45s header timer also aborts it if the response never starts; we clear
      // that timer the instant headers arrive (so a long body stream is unbounded), but the
      // controller stays live for the duration so an interrupt can still abort the body read.
      const controller = new AbortController()
      spectreStreamAbortRef.current = controller
      const headerTimer = setTimeout(() => controller.abort(), 45000)
      try {
        res = await fetch('/api/spectre', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        })
      } catch (e) {
        clearTimeout(headerTimer)
        // A deliberate interrupt aborted the request — surface it as non-transient so the caller
        // cancels cleanly instead of retrying (which would resurrect the turn the user just killed).
        if (spectreInterruptRef.current) throw Object.assign(new Error('interrupted'), { interrupted: true, transient: false })
        // Network drop / fetch timeout (TypeError / AbortError) — transient, retry.
        console.error(`[Spectre] request failed (attempt ${attempt + 1}/2):`, e instanceof Error ? e.message : String(e))
        continue
      }
      clearTimeout(headerTimer)  // headers received — the body stream is now unbounded by this timer
      if (res.ok) return res
      const errBody = await res.text().catch(() => '')
      console.error(`[Spectre] non-200 (attempt ${attempt + 1}/2): status=${res.status} body=${errBody.slice(0, 500)}`)
      if (res.status === 503) { transientMsg = errBody.trim() || transientMsg; continue }  // route flagged transient — retry
      // Non-transient (credits / auth / rate-limit) — surface the actionable reason, no retry.
      throw Object.assign(new Error(errBody.trim() || 'offline'), { transient: false })
    }
    throw Object.assign(new Error(transientMsg), { transient: true })
  }, [speakOneOff])

  // ── Regenerate the assistant reply from the current end of the session ──────────
  // Shared by message-edit and retry. The DB has already been truncated (so the
  // session meta ends at the user message to answer); this streams a fresh reply,
  // updates the display buffer, applies actions, persists, and compresses if needed.
  // Text-only (no voice/TTS) — edit/retry are typed UI actions.
  // `apiOverrideLastUser` replaces the last user turn's content in the API call only
  // (display/persist keep the original) — used by the readFile follow-up to feed full
  // file text to Spectre while history keeps just a compact placeholder.
  // `injectContext` appends a silent context block to the primer (used by the read/search
  // drains to feed fetched content WITHOUT a visible/persisted placeholder turn — the
  // question stays intact, the content rides as context). `reuseLastAssistant` streams into
  // the existing trailing assistant bubble instead of appending a new one (so a drain that
  // follows a "thinking" placeholder overwrites it rather than stacking an empty bubble).
  const regenerate = useCallback(async (scope: string, sid: string | null, opts?: { apiOverrideLastUser?: string; injectContext?: string; reuseLastAssistant?: boolean; voice?: boolean }) => {
    if (streamingRef.current) return
    stopSpeaking()
    userScrolledUpRef.current = false
    setStreaming(true)
    streamingRef.current = true
    setOrbActive(true)
    // Voice drains (readFile/searchVault/readNotebook) regenerate the spoken answer through THIS
    // path. When the originating turn is voice, this regenerate must ALSO speak — otherwise the
    // drained answer streams silently (the verified S1(f) "silent answer" bug). turnSeq is the
    // CURRENT voice turn (not a new one — a drain is a continuation); a mid-stream interrupt bumps
    // it and our enqueues/actions become no-ops.
    const voice = !!opts?.voice && voiceModeRef.current
    const turnSeq = voiceTurnSeqRef.current
    const isDrain = !!opts?.injectContext || !!opts?.apiOverrideLastUser
    // A TYPED (non-voice) drain re-stream — one hop of a document-read chain. To kill the "writes
    // then deletes" flicker, these re-streams do NOT blank or churn the visible bubble: the prior
    // text (usually "on it, reading…") stays put under a Reading… status until the FINAL synthesis
    // (a regenerate that emits no further read) replaces it in one clean write. Voice drains and
    // edit/retry regenerates keep the old blank-and-restream behavior.
    const drainRegen = !!opts?.reuseLastAssistant && !voice
    // Think Mode is Claude-only — its thinking params abort the llama-server request, so never
    // send them in LOCAL mode (the toggle is also hidden there).
    const isLocal = backendFor(selectedModelRef.current) === 'local'
    const think = !isLocal && (effortModeRef.current === 'high' || thinkModeRef.current)
    setSearching(false)
    // Pre-first-token "Thinking" indicator: always for LOCAL (gpt-oss reasons natively and always
    // pauses before streaming, which otherwise looks frozen), and for Claude only when Think Mode is
    // on. Cleared the instant the first visible token streams in (same as Claude).
    setDeepThinking(isLocal || think)
    if (opts?.reuseLastAssistant) {
      // Typed drain re-streams keep the existing bubble (no blank) — only voice drains blank here.
      if (!drainRegen) updateScopeDisplay(scope, m => {
        const c = [...m]
        for (let i = c.length - 1; i >= 0; i--) {
          if (c[i].role === 'assistant') { c[i] = { ...c[i], content: '', saveOffer: undefined, kind: undefined }; break }
        }
        return c
      })
    } else {
      updateScopeDisplay(scope, m => [...m, { role: 'assistant', content: '' }])
    }

    const meta = sessionMsgMetaRef.current
    const summaries = meta
      .filter(m => m.is_compressed && m.in_context)
      .sort((a, b) => (b.compression_level - a.compression_level) || (a.timestamp - b.timestamp))
    const verbatim: Message[] = meta
      .filter(m => !m.is_compressed && m.in_context && !m.deleted_at)
      // Research-result rows reach the model as a one-line note, never the raw JSON snapshot.
      .map(m => ({ role: m.role, content: m.content.startsWith(RESEARCH_MSG_PREFIX) ? researchContextLine(m.content) : m.content }))
    // Vault auto-injection keyed on the last user turn. Skipped when a drain already injects
    // its own content via apiOverrideLastUser (readFile / notebook / searchVault) — no point
    // re-searching the placeholder turn.
    const lastUserText = !opts?.apiOverrideLastUser
      ? String([...verbatim].reverse().find(m => m.role === 'user')?.content ?? '')
      : ''
    // Save-intent Layer 2 (same gate as sendMessage) — an edit/retry of a save request
    // keeps its just-in-time nudge.
    await ensureProjectContextLoaded(scope)   // ambient directory before composing
    const base = composeStable(scope)
    const openDocBlock = lastUserText ? await fetchOpenDocContext(lastUserText) : ''
    const summaryBlock = summaries.length
      ? `\n\n[EARLIER CONVERSATION — COMPRESSED HISTORY]\n${summaries.map(s => `- ${s.content}`).join('\n')}` : ''
    const sessTitle = sessionsRef.current[scope]?.find(s => s.id === sid)?.title ?? 'conversation'
    // Per-turn VOLATILE context — timestamp + session counter + open-doc + save-intent + any
    // drain-injected content — all go on the CURRENT user turn (below), NOT the primer, so the
    // primer stays a byte-stable cacheable prefix shared with sendMessage's.
    const sessionContextText = sid
      ? `[SESSION CONTEXT]\nActive conversation: "${sessTitle}" (id ${sid}). Messages so far: ${verbatim.length}.` +
        (summaries.length ? ` Earlier history is compressed into ${summaries.length} summar${summaries.length === 1 ? 'y' : 'ies'} (deepest level ${summaries[0].compression_level}) — treat those summaries as established context.` : '')
      : ''
    const turnContext = [
      composeVolatile(),
      // Training live-data rides the volatile turn (not the cached prefix) — see composeStable.
      scope === 'training' ? buildLiveBlock(scope, weekEventsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current, exercisesRef.current, viewDateRef.current, openBlockRef.current) : '',
      sessionContextText,
      openDocBlock,
      (lastUserText && detectSaveIntent(lastUserText)) ? SAVE_INTENT_BLOCK : '',
      opts?.injectContext ?? '',
    ].filter(Boolean).join('\n\n').trim()
    const primerFinal = (base + summaryBlock).trim()
    const apiMessages: Message[] = primerFinal
      ? [{ role: 'user', content: primerFinal }, { role: 'assistant', content: 'Understood.' }, ...verbatim]
      : verbatim
    // The current user turn carries the volatile context (prefix) + either a drain's injected
    // content (readFile/notebook/searchVault override) or the existing trailing turn's text.
    {
      const override = opts?.apiOverrideLastUser
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i].role === 'user') {
          const baseContent = override ?? String(apiMessages[i].content ?? '')
          apiMessages[i] = { role: 'user', content: turnContext ? `${turnContext}\n\n---\n\n${baseContent}` : baseContent }
          break
        }
      }
    }

    // Hoisted so the catch can preserve partial text on a mid-stream cutoff.
    let accumulated = ''
    try {
      // voice flag drives the route's spoken-prose instructions + LOW reasoning floor; isDrain
      // skips Mem0 (the injected content already carries the answer — re-searching the placeholder
      // turn is pure latency waste, Phase-2 critical-path diet).
      const res = await postSpectre({ messages: apiMessages, model: backendFor(selectedModelRef.current), modelId: selectedModelRef.current, voice, save: true, skipMemory: isDrain, think, effort: effortModeRef.current, userText: lastUserText }, voice)
      if (!res.body) throw new Error('No stream')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let lastFlush = 0
      let spokenIdx = 0   // chars of cleaned text already queued to TTS (voice drains)
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        accumulated += dec.decode(value)
        // PERF: coalesce render updates to ~30/sec (see sendMessage). Final state flushed below.
        const now = Date.now()
        if (now - lastFlush < 33) continue
        lastFlush = now
        const markerless = accumulated.split(SEARCH_MARKER).join('')
        const displayText = stripJsonForDisplay(markerless)
        if (displayText.trim() !== '') { setSearching(false); setDeepThinking(false); if (!drainRegen) setChatStatus(null) }
        else if (accumulated.includes(SEARCH_MARKER)) { setSearching(true); setDeepThinking(false) }
        // Typed drain hops don't churn the bubble live — keep the prior text + Reading… status; the
        // final synthesis writes once below. Voice + normal streams update live as before.
        if (!drainRegen) updateScopeDisplay(scope, m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: displayText }; return c })
        // Voice drain: stream complete sentences to TTS as they arrive (mirrors sendMessage), so a
        // read/search answer is SPOKEN, not silent. Gated on turnSeq so an interrupt halts it.
        if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current) {
          if (voiceTimingRef.current && !voiceTimingRef.current.firstToken && displayText.trim()) voiceTimingRef.current.firstToken = performance.now()
          const { sentences, newIdx } = extractSentences(displayText, spokenIdx)
          sentences.forEach(s => enqueueSentence(s))
          spokenIdx = newIdx
        }
      }
      setSearching(false); setDeepThinking(false)
      const finalAccumulated = accumulated.split(SEARCH_MARKER).join('')
      const { cleanText, actions } = extractAllSpectreActions(finalAccumulated)
      // A voice interrupt during this regenerate bumps turnSeq — discard the superseded turn's
      // actions, persistence, and TTS so a cut-off drain can't mutate state or keep talking.
      const superseded = voice && turnSeq !== voiceTurnSeqRef.current
      if (!superseded) enqueueActionsRef.current(actions, scope)
      // A read/search follows: surface a silent status indicator (not a filler bubble), and
      // don't persist this intermediate — the drain's regenerate produces the real answer.
      const drain = drainStatusFor(actions)
      if (drain && !superseded) setChatStatus(drain)
      const finalText = drain ? cleanText : (cleanText || describeActions(actions))
      // Save-intent Layer 3: substantial reply with no save action → ephemeral 💾 chip.
      const saveOffer = drain ? null : buildSaveOffer(cleanText, actions)
      // A typed drain hop that emits ANOTHER read (drain truthy) must NOT paint its "let me check the
      // next one" preamble over the bubble — that's the flicker. Keep the prior text; only the final
      // synthesis (a regenerate with no further read → drain falsy) writes here, once.
      if (!drainRegen || !drain) updateScopeDisplay(scope, m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: finalText, ...(saveOffer ? { saveOffer } : {}) }; return c })

      if (!superseded && !drain && sid && finalText.trim()) {
        try {
          const ares = await fetch(`/api/chat/sessions/${sid}/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'assistant', content: finalText }),
          })
          const adata = await ares.json()
          if (adata.message) {
            const nm = [...sessionMsgMetaRef.current, adata.message as SessionMsg]
            sessionMsgMetaRef.current = nm; setSessionMsgMeta(nm)
          }
          if (adata.needsCompression && !compressingRef.current) {
            compressingRef.current = true
            ;(async () => {
              try {
                await fetch(`/api/chat/sessions/${sid}/compress`, { method: 'POST' })
                const r = await fetch(`/api/chat/sessions/${sid}/messages`, { cache: 'no-store' })
                const d = await r.json()
                if (Array.isArray(d.messages)) { sessionMsgMetaRef.current = d.messages; setSessionMsgMeta(d.messages) }
                loadSessions(scope)
              } catch { /* offline */ } finally { compressingRef.current = false }
            })()
          }
          loadSessions(scope)
        } catch { /* offline */ }
      }

      // Voice drain: THIS regenerate produced the spoken answer — flush the tail and complete the
      // SPEAKING phase (→ reopen the mic). Skipped when it emitted ANOTHER drain action (a chained
      // read, whose own regenerate speaks) or was superseded by an interrupt (turnSeq stale).
      if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current && !drain) {
        const fc = stripJsonForDisplay(finalAccumulated)
        let tail = fc.slice(Math.min(spokenIdx, fc.length)).trim()
        if (!fc.trim() && !cleanText) tail = describeActions(actions)
        if (tail) enqueueSentence(tail)
        finalizeTtsStreamDone()   // branches streaming vs buffered; completes the spoken turn
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transient = (err as any)?.transient === true
      setChatStatus(null)   // an error ends any read/search in progress — clear the indicator
      // Deliberate interrupt (handleMicTap aborted the stream / bumped turnSeq): already stopped
      // audio + reopened the mic. Don't show an error, persist, or reopen again — just unwind,
      // dropping the (reuse-blanked) trailing assistant bubble so it doesn't linger empty.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.interrupted === true || (voice && turnSeq !== voiceTurnSeqRef.current)) {
        updateScopeDisplay(scope, m => { const c = [...m]; const last = c[c.length - 1]; if (last && last.role === 'assistant' && !String(last.content).trim()) c.pop(); return c })
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      const isOffline = err instanceof TypeError || raw === 'offline' || raw === 'No stream' || raw === 'Failed to fetch'
      // Mid-stream cutoff (long-response "BodyStreamBuffer was aborted" class) — preserve the
      // partial text and explain gracefully instead of dumping the raw abort error. See sendMessage.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamCutoff = !transient && !isOffline && (
        /bodystreambuffer|aborted|the operation was aborted|network error|err_incomplete|stream (was )?(closed|interrupted)/i.test(raw) ||
        (err as any)?.name === 'AbortError'
      )
      let errorText: string
      if (streamCutoff) {
        const partial = stripJsonForDisplay(accumulated.split(SEARCH_MARKER).join('')).trim()
        const note = 'That response ran too long and got cut off — ask me to continue and I’ll pick up where I left off, or break it into parts.'
        errorText = partial ? `${partial}\n\n_⚠️ ${note}_` : note
        console.warn('[Spectre] regenerate stream cut off mid-response — handled gracefully:', raw)
      } else {
        errorText = transient ? 'Spectre is temporarily unreachable — tap to retry'
          : (isOffline ? 'Spectre is temporarily offline. Restart the dev server to reconnect.' : raw)
      }
      updateScopeDisplay(scope, m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: errorText, kind: transient ? 'error' : undefined }; return c })
      // A voice drain that genuinely failed must still reopen the mic — the conversation loop
      // must survive a failed read/search instead of hanging in THINKING.
      if (voice && voiceModeRef.current) { stopSpeaking(); setTimeout(() => { if (voiceModeRef.current) reopenMicAndListen() }, 1200) }
    } finally {
      setStreaming(false); streamingRef.current = false; setOrbActive(false); setSearching(false); setDeepThinking(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, composeBase, ensureProjectContextLoaded, updateScopeDisplay, loadSessions, postSpectre])

  // ── readFile queue drain ────────────────────────────────────────────────────────
  // When a stream finishes (streaming → false) and Spectre queued a readFile, fetch the
  // file's content (cached per chain) and regenerate with it injected as silent CONTEXT —
  // the original question stays intact, the content rides along, and a subtle status
  // indicator (not a chat bubble) shows the read. Each reply can chain further reads →
  // sequential cross-file search, bounded by MAX_READS. A re-read of an already-fetched file
  // (forceAnswerRef) does ONE final completion from cache so the loop never dead-ends.
  //
  // INVARIANT (the 2026-06-11 fix): once a read/search is queued, a regenerate ALWAYS
  // follows — a failed fetch / unknown id injects an honest READ FAILED block with the
  // live directory instead of silently skipping, so the turn can never end on a stuck
  // status indicator with no answer. The three drains are serialized through anyDrainBusy
  // (regenerate is single-flight — a second concurrent call would silently no-op and lose
  // its read), and they all wake on the shared drainTick.
  const MAX_READS = 12   // headroom for reading several papers before the chain is force-capped
  const anyDrainBusy = () => readFileBusyRef.current || notebookReadBusyRef.current || vaultSearchBusyRef.current
  useEffect(() => {
    if (streaming || anyDrainBusy()) return
    const scope = chatScope()
    const sid = activeSessionIdRef.current[scope] ?? null
    // Force-answer: the model re-requested content it already has. Complete the turn from
    // cache with a firm "answer now" instead of leaving it stuck on the status indicator.
    // Counts against MAX_READS so a pathologically-looping model can't recurse forever.
    // Deferred while other reads are still queued — those drain first, then this completes.
    if (readFileQueueRef.current.length === 0 && notebookReadQueueRef.current.length === 0
        && vaultSearchQueueRef.current.length === 0 && forceAnswerRef.current) {
      forceAnswerRef.current = false
      if (readContentCacheRef.current.size === 0 || readFileDepthRef.current >= MAX_READS) { setChatStatus(null); return }
      readFileBusyRef.current = true
      readFileDepthRef.current += 1
      ;(async () => {
        try {
          const blocks = [...readContentCacheRef.current.values()]
            .map(c => `[CONTENT — "${c.name}"]\n${c.text}`).join('\n\n')
          const inject = `\n\n[REFERENCED CONTENT]\nYou already have the content below — answer ${USER_POSS} question now, directly and completely. Do NOT call any read tool again.\n\n${blocks}\n---`
          await regenerate(scope, sid, { injectContext: inject, reuseLastAssistant: true, voice: voiceModeRef.current })
        } catch { /* offline */ }
        finally { readFileBusyRef.current = false; setChatStatus(null); setDrainTick(t => t + 1) }
      })()
      return
    }
    if (readFileQueueRef.current.length === 0) return
    if (readFileDepthRef.current >= MAX_READS) { readFileQueueRef.current = []; setChatStatus(null); return }
    const fileId = readFileQueueRef.current.shift()!
    if (drainedReadIdsRef.current.has(fileId)) { setDrainTick(t => t + 1); return }   // duplicate — skip
    drainedReadIdsRef.current.add(fileId)
    readFileBusyRef.current = true
    readFileDepthRef.current += 1
    ;(async () => {
      try {
        setChatStatus({ kind: 'reading', label: 'Reading the file' })
        let cached = readContentCacheRef.current.get(fileId)
        if (!cached) {
          try {
            const res = await fetch(`/api/files/${fileId}/content`, { cache: 'no-store' })
            const data = await res.json()
            if (data && data.content !== undefined) {
              cached = { name: data.filename ?? 'file', text: String(data.content).slice(0, 80000) }
              readContentCacheRef.current.set(fileId, cached)
            }
          } catch { /* not found / offline — falls through to the READ FAILED recovery */ }
        }
        let inject: string
        if (cached) {
          setChatStatus({ kind: 'reading', label: `Reading ${cached.name}` })
          inject = `\n\n[FILE CONTENT — "${cached.name}"]\nThe full text of this Source file is below — answer ${USER_POSS} question directly from it. Do NOT call readFile again for this file.\n\n${cached.text}\n---`
        } else {
          // Unknown/stale id or a failed fetch — recover with the live directory so the
          // model can correct the id once, or answer honestly. Never a silent dead-end.
          const files = sourceFilesRef.current[scope] ?? []
          const dir = files.length ? files.map(f => `• ${f.filename} (id: ${f.id})`).join('\n') : '(this project has no Sources files)'
          inject = `\n\n[FILE READ FAILED]\nThe Source file id "${fileId}" could not be read — it may be a guessed or stale id. The files actually in this project:\n${dir}\nIf the file ${USER} means is listed, call readFile ONCE with its exact id; if it lives in another project, its id is in the [DIAGRAM TREE]. Otherwise tell ${USER} plainly that you couldn't find it — do not invent content.\n---`
        }
        await regenerate(scope, sid, { injectContext: inject, reuseLastAssistant: true, voice: voiceModeRef.current })
      } catch { /* offline — regenerate shows its own error bubble */ }
      finally {
        readFileBusyRef.current = false
        if (readFileQueueRef.current.length === 0 && !forceAnswerRef.current) setChatStatus(null)
        setDrainTick(t => t + 1)   // wake all drains for the next queued item
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, drainTick, regenerate, updateScopeDisplay, chatScope])

  // ── readNotebook / listNotebooks queue drain ─────────────────────────────────────
  // Same pattern as readFile: fetch the notebook content (or the tree for the '*' sentinel)
  // and regenerate with it injected as silent context + a status indicator — no chat bubble.
  // A failed/unknown id regenerates with a READ FAILED block + the live directory instead
  // of silently skipping (same invariant as the readFile drain — never a stuck dead-end).
  useEffect(() => {
    if (streaming || anyDrainBusy()) return
    if (notebookReadQueueRef.current.length === 0) return
    if (readFileDepthRef.current >= MAX_READS) { notebookReadQueueRef.current = []; setChatStatus(null); return }
    const scope = chatScope()
    const sid = activeSessionIdRef.current[scope] ?? null
    const itemId = notebookReadQueueRef.current.shift()!
    if (itemId !== '*' && drainedReadIdsRef.current.has(itemId)) { setDrainTick(t => t + 1); return }   // duplicate — skip
    if (itemId !== '*') drainedReadIdsRef.current.add(itemId)
    notebookReadBusyRef.current = true
    readFileDepthRef.current += 1
    ;(async () => {
      try {
        setChatStatus({ kind: 'reading', label: 'Reading the document' })
        let inject: string
        if (itemId === '*') {
          const list = notebooksByNodeRef.current[scope] ?? []
          setChatStatus({ kind: 'reading', label: 'Checking the notebooks' })
          inject = `\n\n[NOTEBOOK INDEX]\nNotebooks in this project (answer ${USER} from this; do not call listNotebooks again):\n${buildNotebooksBlock(list, null)}\n---`
        } else {
          const cachedNb = readContentCacheRef.current.get(itemId)
          let title = cachedNb?.name ?? 'the document'
          let md = cachedNb?.text ?? ''
          if (!cachedNb) {
            try {
              const res = await fetch(`/api/notebooks/${itemId}`, { cache: 'no-store' })
              const data = await res.json()
              if (data && data.notebook) {
                const nb = data.notebook
                title = nb.title
                md = (nb.content ? tiptapToMarkdown(JSON.parse(nb.content)) : '').slice(0, 80000) || '(empty notebook)'
                readContentCacheRef.current.set(itemId, { name: title, text: md })
              }
            } catch { /* not found / offline — falls through to the READ FAILED recovery */ }
          }
          if (md) {
            setChatStatus({ kind: 'reading', label: `Reading ${title}` })
            inject = `\n\n[DOCUMENT — "${title}"]\nThe full content of this document is below — answer ${USER_POSS} question directly from it. Do NOT call readNotebook again for it.\n\n${md}\n---`
          } else {
            // Unknown/stale id or a failed fetch — recover with the live directory so the
            // model can correct the id once, or answer honestly. Never a silent dead-end.
            const list = notebooksByNodeRef.current[scope] ?? []
            inject = `\n\n[DOCUMENT READ FAILED]\nThe document id "${itemId}" could not be read — it may be a guessed or stale id. The live directory of this project:${buildNotebooksBlock(list, null)}\nIf the document ${USER} means is in this directory, call readNotebook ONCE with its exact id; if it lives in another project, its id is in the [DIAGRAM TREE]. Otherwise tell ${USER} plainly that you couldn't find it — do not invent content.\n---`
          }
        }
        await regenerate(scope, sid, { injectContext: inject, reuseLastAssistant: true, voice: voiceModeRef.current })
      } catch { /* offline — regenerate shows its own error bubble */ }
      finally {
        notebookReadBusyRef.current = false
        if (notebookReadQueueRef.current.length === 0 && !forceAnswerRef.current) setChatStatus(null)
        setDrainTick(t => t + 1)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, drainTick, regenerate, updateScopeDisplay, chatScope])

  // ── searchVault queue drain ──────────────────────────────────────────────────────
  // Same pattern as readFile: run the semantic vault search and regenerate with the results
  // injected as silent context + a status indicator — no chat bubble.
  useEffect(() => {
    if (streaming || anyDrainBusy()) return
    if (vaultSearchQueueRef.current.length === 0) return
    if (readFileDepthRef.current >= MAX_READS) { vaultSearchQueueRef.current = []; setChatStatus(null); return }
    const scope = chatScope()
    const sid = activeSessionIdRef.current[scope] ?? null
    const req = vaultSearchQueueRef.current.shift()!
    // Mark this query drained so a re-emitted identical searchVault (a looping model) is caught
    // by the push guard above and forces a completion instead of re-running the same search.
    drainedReadIdsRef.current.add(`vault:${req.query.toLowerCase()}|${req.node_id ?? ''}`)
    vaultSearchBusyRef.current = true
    readFileDepthRef.current += 1
    ;(async () => {
      try {
        setChatStatus({ kind: 'vault', label: `Searching the vault for “${req.query.slice(0, 40)}”` })
        const res = await fetch('/api/vault/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: req.query, node_id: req.node_id, limit: req.limit ?? 8, threshold: 0.5 }),
        })
        const data = await res.json().catch(() => ({ results: [] }))
        const results: VaultResult[] = Array.isArray(data?.results) ? data.results : []
        let inject: string
        if (results.length) {
          const items = results.map(r => {
            const nodeName = nodesRef.current.find(n => n.id === r.node_id)?.name ?? r.node_id
            const excerpt = r.text.split(/\s+/).slice(0, 100).join(' ')
            return `📄 ${r.title} — ${nodeName}\n${excerpt}`
          }).join('\n\n')
          inject = `\n\n[VAULT SEARCH RESULTS — "${req.query}"]\n${results.length} found. Present these to ${USER} clearly; do not call searchVault again for this query:\n\n${items}\n---`
        } else {
          inject = `\n\n[VAULT SEARCH — "${req.query}"]\nNo results above threshold. Tell ${USER} nothing relevant was found — the vault may still be building, or they can add files to Sources. Do not retry.\n---`
        }
        await regenerate(scope, sid, { injectContext: inject, reuseLastAssistant: true, voice: voiceModeRef.current })
      } catch { /* offline — skip and continue draining */ }
      finally {
        vaultSearchBusyRef.current = false
        if (vaultSearchQueueRef.current.length === 0 && !forceAnswerRef.current) setChatStatus(null)
        setDrainTick(t => t + 1)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, drainTick, regenerate, updateScopeDisplay, chatScope])

  // Refresh meta + display buffer from the server's surviving-message list (after a
  // truncate). Returns the active scope so the caller can regenerate.
  const applyTruncation = useCallback((scope: string, messages: SessionMsg[]) => {
    sessionMsgMetaRef.current = messages
    setSessionMsgMeta(messages)
    // Display buffer mirrors selectSession: all non-compressed rows (the server already
    // omits soft-deleted ones), so display index aligns with the meta lookup below.
    const display: Message[] = messages.filter(r => !r.is_compressed).map(r => {
      // Mirror selectSession: re-render persisted research rows as completed circuit-board
      // cards, not a literal [RESEARCH_RESULT]{…} JSON blob.
      const research = r.role === 'assistant' ? parseResearchMessage(r.content) : null
      return research
        ? { role: 'assistant' as const, content: '', kind: 'research' as const, research }
        : { role: r.role, content: r.content }
    })
    setScopeDisplay(scope, display)
  }, [])

  // Edit a past user message → truncate everything after it → regenerate from there.
  const editUserMessage = useCallback(async (displayIndex: number, newText: string) => {
    if (streaming || !newText.trim()) return
    readFileDepthRef.current = 0
    drainedReadIdsRef.current.clear(); readContentCacheRef.current.clear(); forceAnswerRef.current = false
    const scope = activeHandRef.current ?? (activeProjectRef.current ? `project-${activeProjectRef.current}` : activeFolderRef.current)
    const sid = activeSessionIdRef.current[scope] ?? null
    if (sid) {
      const verbatimMeta = sessionMsgMetaRef.current.filter(m => !m.is_compressed)
      const row = verbatimMeta[displayIndex]
      if (!row || row.role !== 'user') return
      try {
        const res = await fetch(`/api/chat/sessions/${sid}/messages/${row.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newText }),
        })
        const data = await res.json()
        if (Array.isArray(data.messages)) applyTruncation(scope, data.messages)
      } catch {
        // Offline: actually perform the local truncation the comment promises (mirror the
        // no-session branch) so a failed PATCH doesn't keep the stale message and then
        // double-reply to the original on regenerate.
        updateScopeDisplay(scope, m => [...m.slice(0, displayIndex), { role: 'user', content: newText }])
      }
    } else {
      updateScopeDisplay(scope, m => [...m.slice(0, displayIndex), { role: 'user', content: newText }])
    }
    regenerate(scope, sid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, regenerate, applyTruncation, updateScopeDisplay])

  // Retry: drop the last assistant turn and regenerate a fresh reply.
  const retryLast = useCallback(async () => {
    if (streaming) return
    readFileDepthRef.current = 0
    drainedReadIdsRef.current.clear(); readContentCacheRef.current.clear(); forceAnswerRef.current = false
    const scope = activeHandRef.current ?? (activeProjectRef.current ? `project-${activeProjectRef.current}` : activeFolderRef.current)
    const sid = activeSessionIdRef.current[scope] ?? null
    if (sid) {
      const verbatimMeta = sessionMsgMetaRef.current.filter(m => !m.is_compressed)
      const lastAssistant = [...verbatimMeta].reverse().find(m => m.role === 'assistant')
      if (lastAssistant) {
        try {
          const res = await fetch(`/api/chat/sessions/${sid}/messages/${lastAssistant.id}`, { method: 'DELETE' })
          const data = await res.json()
          if (Array.isArray(data.messages)) applyTruncation(scope, data.messages)
        } catch { /* offline */ }
      }
    } else {
      updateScopeDisplay(scope, m => {
        const next = [...m]
        for (let i = next.length - 1; i >= 0; i--) { if (next[i].role === 'assistant') { next.splice(i, 1); break } }
        return next
      })
    }
    regenerate(scope, sid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, regenerate, applyTruncation, updateScopeDisplay])

  // Load a session into view: fetch its messages, derive the display buffer (all
  // verbatim turns, full scrollback) and keep the flagged rows for window assembly.
  const selectSession = useCallback(async (scope: string, id: string) => {
    const next = { ...activeSessionIdRef.current, [scope]: id }
    activeSessionIdRef.current = next
    setActiveSessionId(next)
    setChatView('chat')
    setMainDrawerOpen(false)
    try {
      const res = await fetch(`/api/chat/sessions/${id}/messages`, { cache: 'no-store' })
      const data = await res.json()
      const rows: SessionMsg[] = Array.isArray(data.messages) ? data.messages : []
      sessionMsgMetaRef.current = rows
      setSessionMsgMeta(rows)
      // Persisted research rows re-render as completed circuit-board cards (FIX 1).
      const display: Message[] = rows.filter(r => !r.is_compressed).map(r => {
        const research = r.role === 'assistant' ? parseResearchMessage(r.content) : null
        return research
          ? { role: 'assistant' as const, content: '', kind: 'research' as const, research }
          : { role: r.role, content: r.content }
      })
      setScopeDisplay(scope, display)
    } catch { /* server offline */ }
    setTimeout(() => inputRef.current?.focus(), 60)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Begin a fresh conversation in a scope. No DB row is created until the first
  // message is sent (so abandoned "new conversation" clicks leave nothing behind).
  const startNewSession = (scope: string) => {
    const next = { ...activeSessionIdRef.current, [scope]: null }
    activeSessionIdRef.current = next
    setActiveSessionId(next)
    sessionMsgMetaRef.current = []
    setSessionMsgMeta([])
    setScopeDisplay(scope, [])
    setChatView('chat')
    setMainDrawerOpen(false)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  // Main page: load its sessions on mount and resume the most recent one, so a
  // refresh (or another device via Tailscale) continues the last conversation.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/chat/sessions?folder_id=main', { cache: 'no-store' })
        const data = await res.json()
        const list: SessionMeta[] = Array.isArray(data.sessions) ? data.sessions : []
        setSessions(prev => ({ ...prev, main: list }))
        if (list.length) selectSession('main', list[0].id)
      } catch { /* server offline */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectSession])

  // ── Unified tool framework — the flag-gated agent path ──────────────────────────
  // Apply the UI effects a tool loop returns. `ui.navigate/open_*/refresh` map to existing UI
  // setters/loaders; `ui.client_action` (gym/session/research) is proxied through the same action
  // queue the old path uses (reusing dispatchQueuedAction/applySpectreAction handlers).
  const applyToolUi = (
    effects: { navigate?: string; open_document?: { id: string; mode?: string }; open_file?: string; refresh?: string[]; client_action?: { name: string; args: Record<string, unknown> } }[],
    scope: string,
  ) => {
    const projNode = (() => { const n = nodesRef.current.find(x => x.id === scope); return n && n.level === 'hand' && n.parent_id === 'projects' ? scope : null })()
    const ACT: Record<string, string> = { update_workout: 'updateWorkout', log_set: 'logSet', reorder_blocks: 'reorderBlocks', set_rest: 'setRest', open_session: 'openSession', search_sessions: 'searchSessions', deep_research: 'deepResearch' }
    for (const ui of effects || []) {
      if (ui.navigate) navigateToNode(ui.navigate)
      if (ui.open_document?.id) { setOpenNotebookMode(ui.open_document.mode === 'edit' ? 'edit' : 'view'); setOpenNotebookId(ui.open_document.id) }
      if (ui.open_file) setPreviewFileId(ui.open_file)
      for (const p of ui.refresh || []) {
        if (p === 'notebooks' && projNode) loadNotebooks(projNode)
        else if (p === 'calendar') { refreshWeek(); refreshMonth(viewMonthRef.current) }
        else if (p === 'nodes') { loadNodes(); refreshDiagramTree() }
        // 'tasks' reload is NOT project-gated — a Secretary delegation can target a project
        // that isn't on screen, and the dashboard NOW list must catch up regardless.
        else if (p === 'tasks' || p === 'proposals') { loadDashTasks(); if (p === 'proposals') void checkSecretaryProposals() }
      }
      if (ui.client_action?.name) enqueueActionsRef.current([{ action: ACT[ui.client_action.name] ?? ui.client_action.name, ...(ui.client_action.args || {}) }], scope)
    }
  }

  // Route a typed turn through /api/spectre/agent (the unified tool loop). Self-contained: it does
  // its own optimistic render + session persistence, then renders the answer + applies UI effects.
  // Only reached when the flag is ON (default OFF → the old sendMessage path runs unchanged).
  const sendViaAgent = async (text: string, opts: { voice?: boolean; skipMemory?: boolean } = {}) => {
    if (streamingRef.current || !text.trim()) return
    const voice = !!opts.voice
    const skipMemory = !!opts.skipMemory
    // Turn-based voice: a manual interrupt / newer voice turn bumps this, invalidating this turn's
    // remaining TTS enqueues + persist. Typed sends never touch the counter.
    const turnSeq = voice ? ++voiceTurnSeqRef.current : 0
    let spokenIdx = 0   // chars of the answer already queued to TTS (voice)
    stopSpeaking()
    const handId = activeHandRef.current, projId = activeProjectRef.current, folderId = activeFolderRef.current
    const scope = handId ?? (projId ? `project-${projId}` : folderId)
    const usesProjectStore = !handId && !!projId
    const bufKey = usesProjectStore ? `project-${projId}` : scope
    const setMsgs = (updater: Message[] | ((prev: Message[]) => Message[])) => {
      if (usesProjectStore) setProjectMessages(all => { const prev = all[bufKey] || []; return { ...all, [bufKey]: typeof updater === 'function' ? updater(prev) : updater } })
      else setAllMessages(all => { const prev = all[scope] || []; return { ...all, [scope]: typeof updater === 'function' ? updater(prev) : updater } })
    }
    const currentHistory = usesProjectStore ? (projectMessagesRef.current[bufKey] || []) : (allMessagesRef.current[scope] || [])
    setMsgs([...currentHistory, { role: 'user', content: text }])
    setInput('')
    setOrbActive(true)
    setStreaming(true); streamingRef.current = true
    setMsgs(m => [...m, { role: 'assistant', content: '' }])
    setChatStatus({ kind: 'searching', label: 'Thinking…' })

    let sid = activeSessionIdRef.current[scope] ?? null
    try {
      if (!sid) {
        const newTag = activeTagByScopeRef.current[scope] ?? null
        const cres = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: scope, firstMessage: text, tag_id: newTag }) })
        const cdata = await cres.json()
        if (cdata.session?.id) { sid = cdata.session.id; const next = { ...activeSessionIdRef.current, [scope]: sid }; activeSessionIdRef.current = next; setActiveSessionId(next) }
      }
      if (sid) fetch(`/api/chat/sessions/${sid}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user', content: text }) }).catch(() => {})
    } catch { /* offline — the in-memory buffer still works */ }

    const history = currentHistory
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && m.kind !== 'transition')
      .slice(-12).map(m => ({ role: m.role, content: m.content }))
    const projNode = (() => { const n = nodesRef.current.find(x => x.id === scope); return n && n.level === 'hand' && n.parent_id === 'projects' ? scope : null })()
    // Live-awareness context (dashboard/arm data + node primer + tree) and the current time —
    // so Spectre SEES the user's day on this path. Ensure a project Hand's data is loaded first.
    if (projNode) { try { await ensureProjectContextLoaded(scope) } catch { /* best effort */ } }
    // Permanence: if the previous turn navigated the user HERE, this turn's Spectre
    // knows it — who handed them off, what they asked, what was said. Consumed once.
    let handoffBlock = ''
    const hoff = handoffRef.current
    if (hoff && hoff.fromScope !== scope && Date.now() - hoff.at < 5 * 60_000) {
      handoffBlock = `\n\n[HANDOFF — continuity]\nYou JUST navigated ${USER} here from ${hoff.fromName}. There, they said: "${hoff.ask.slice(0, 300)}" and you brought them to this location, replying: "${hoff.said}". This conversation continues that same thread — do not greet them fresh, do not ask why they're here; pick up exactly where you left off and do the thing they came here for.`
      handoffRef.current = null
    }
    const agentContext = composeAgentContext(scope) + handoffBlock
    const nowLine = composeVolatile()
    const setLastAssistant = (content: string) => setMsgs(m => { const c = [...m]; for (let i = c.length - 1; i >= 0; i--) { if (c[i].role === 'assistant') { c[i] = { ...c[i], content }; break } } return c })

    // Voice: expose this turn's fetch so a mic-tap interrupt (handleMicTap) can abort it mid-stream.
    const controller = new AbortController()
    if (voice) spectreStreamAbortRef.current = controller
    try {
      const res = await fetch('/api/spectre/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, modelId: selectedModelRef.current, scope, projectNodeId: projNode, sessionId: sid, history, context: agentContext, now: nowLine, voice, skipMemory }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Agent route unavailable (HTTP ${res.status}).`)
      // NDJSON event stream: text deltas render live (33ms throttle, same as the legacy reader);
      // per-tool status events drive the silent indicator; ui + done arrive after the loop.
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let answer = ''
      let hadText = false
      let statusShowing = true          // the initial "Thinking…" is up
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let uiEffects: any[] | null = null
      let doneErr: string | undefined
      let lastFlush = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let ev: any
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'text' && typeof ev.delta === 'string') {
            answer += ev.delta
            if (!hadText && answer.trim()) hadText = true
            if (statusShowing && hadText) { setChatStatus(null); statusShowing = false }
            const now = Date.now()
            if (now - lastFlush >= 33) { lastFlush = now; setLastAssistant(answer) }
            // Voice: queue complete sentences to TTS as they arrive (agent text is already clean
            // prose — no action JSON to strip). Across the agentic loop's rounds this naturally
            // speaks "let me check…" then, after the tool, "here's what I found". Guarded by turnSeq.
            if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current) {
              if (voiceTimingRef.current && !voiceTimingRef.current.firstToken && answer.trim()) voiceTimingRef.current.firstToken = performance.now()
              const { sentences, newIdx } = extractSentences(answer, spokenIdx)
              sentences.forEach(s => enqueueSentence(s))
              spokenIdx = newIdx
            }
          } else if (ev.type === 'status' && ev.label) {
            setChatStatus({ kind: ev.kind === 'reading' || ev.kind === 'vault' ? ev.kind : 'searching', label: String(ev.label) })
            statusShowing = true
          } else if (ev.type === 'ui' && Array.isArray(ev.effects)) {
            uiEffects = ev.effects
          } else if (ev.type === 'done' && ev.error) {
            doneErr = String(ev.error)
          }
        }
      }
      // A voice interrupt mid-stream bumps turnSeq — a superseded turn must NOT persist, apply UI
      // effects, or speak; the interrupt already reopened the mic.
      const superseded = voice && turnSeq !== voiceTurnSeqRef.current
      if (doneErr) answer = answer ? `${answer}\n\n⚠️ ${doneErr}` : `⚠️ ${doneErr}`
      if (!answer) answer = "I didn't produce a reply."
      setLastAssistant(answer)
      // Handoff capture: a navigate in this turn's effects → the destination's
      // next turn carries the thread. Best-effort; shape-defensive.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((uiEffects ?? []).some((e: any) => e && e.navigate)) {
          const fromName = scope === 'main' ? 'the main dashboard' : (nodesRef.current.find(n => n.id === scope)?.name ?? scope)
          handoffRef.current = { fromScope: scope, fromName, ask: text, said: answer.slice(0, 400), at: Date.now() }
        }
      } catch { /* permanence is best-effort */ }
      if (!superseded && uiEffects?.length) applyToolUi(uiEffects, scope)
      if (!superseded && sid && hadText) fetch(`/api/chat/sessions/${sid}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'assistant', content: answer }) }).catch(() => {})
      // Voice final flush: enqueue any remaining complete sentences + the trailing fragment, then
      // hand off to the TTS completion chain (which reopens the mic once playback drains).
      if (voice && voiceModeRef.current && !superseded) {
        const { sentences, newIdx } = extractSentences(answer, spokenIdx)
        sentences.forEach(s => enqueueSentence(s))
        spokenIdx = newIdx
        const tail = answer.slice(Math.min(spokenIdx, answer.length)).trim()
        if (tail) enqueueSentence(tail)
        finalizeTtsStreamDone()
      }
    } catch (e) {
      // A deliberate interrupt bumped turnSeq (it already reopened the mic) — drop the empty
      // bubble and unwind quietly.
      if (voice && turnSeq !== voiceTurnSeqRef.current) {
        setMsgs(m => { const c = [...m]; const last = c[c.length - 1]; if (last && last.role === 'assistant' && !String(last.content).trim()) c.pop(); return c })
      } else {
        setLastAssistant(`⚠️ ${e instanceof Error ? e.message : 'The tool framework is unreachable.'}`)
        // Voice: the conversation loop must survive an error — reopen the mic after a brief delay.
        if (voice && voiceModeRef.current) { stopSpeaking(); setTimeout(() => { if (voiceModeRef.current) reopenMicAndListen() }, 1200) }
      }
    } finally {
      setChatStatus(null); setStreaming(false); streamingRef.current = false; setOrbActive(false)
    }
  }
  sendViaAgentRef.current = sendViaAgent

  const sendMessage = useCallback(
    async (text: string, opts: { voice?: boolean; hiddenUser?: boolean; skipMemory?: boolean } = {}) => {
      const voice = !!opts.voice
      // Synchronous guard — never defeated by a stale `streaming` closure. If a voice turn lands
      // here (a reply is already streaming), re-arm listening rather than leaving the loop stuck in
      // THINKING with no mic (sendVoiceTurn already set the phase). Narrow: voice opened mid-stream.
      if (streamingRef.current) {
        if (voice && voiceModeRef.current && !opts.hiddenUser) reopenMicAndListen()
        return
      }
      const hiddenUser = !!opts.hiddenUser  // send `text` to the API but don't show it (e.g. greeting)
      const skipMemory = !!opts.skipMemory  // don't persist this turn to Mem0 (e.g. greeting)
      // Unified tool framework is THE path now — no toggle. Typed AND voice both route through the
      // agentic loop (identity + live data + memory + tools + stepwise streaming). Only the hidden
      // greeting and attachment sends still use the legacy path (ported next).
      if (!hiddenUser && !chatAttachmentsRef.current.some(a => !a.error)) {
        sendViaAgentRef.current(text, { voice, skipMemory: opts.skipMemory })
        return
      }
      // Turn-based voice: tag this voice turn. A manual interrupt (or a newer voice turn)
      // bumps the sequence, which invalidates this turn's remaining TTS enqueues so a cut-off
      // response can't keep feeding the audio queue after the user has taken the mic back.
      // Text sends never touch the counter (turnSeq is only read in the voice-gated blocks).
      const turnSeq = voice ? ++voiceTurnSeqRef.current : 0
      // Chat attachments (typed sends only — never voice/greeting). A message may be sent
      // with attachments and no text.
      const atts = (!voice && !hiddenUser) ? chatAttachmentsRef.current.filter(a => !a.error) : []
      if (!text.trim() && atts.length === 0) return
      // Each user-initiated turn gets a fresh readFile budget.
      if (!hiddenUser) { readFileDepthRef.current = 0; drainedReadIdsRef.current.clear(); readContentCacheRef.current.clear(); forceAnswerRef.current = false }
      // Stop any in-progress TTS/queue when a new turn begins
      stopSpeaking()
      userScrolledUpRef.current = false
      lastScrollTopRef.current = 0

      const handId = activeHandRef.current
      const projId = activeProjectRef.current
      const folderId = activeFolderRef.current
      // A node's id IS its scope. Seeded project Hands keep their 'project-*' scope.
      const scope = handId ?? (projId ? `project-${projId}` : folderId)
      // Display buffer for seeded project Hands lives in projectMessages; everything
      // else (Arms + custom Hands) lives in allMessages keyed by scope.
      const usesProjectStore = !handId && !!projId
      // The hidden voice greeting is never persisted (no session row, no Mem0).
      const skipPersist = hiddenUser

      const currentHistory = usesProjectStore
        ? (projectMessagesRef.current[`project-${projId}`] || [])
        : (allMessagesRef.current[scope] || [])

      const setMsgs = (updater: Message[] | ((prev: Message[]) => Message[])) => {
        if (usesProjectStore) {
          const key = `project-${projId}`
          setProjectMessages(all => {
            const prev = all[key] || []
            const next = typeof updater === 'function' ? updater(prev) : updater
            return { ...all, [key]: next }
          })
        } else {
          setAllMessages(all => {
            const prev = all[scope] || []
            const next = typeof updater === 'function' ? updater(prev) : updater
            return { ...all, [scope]: next }
          })
        }
      }

      const userMsg: Message = {
        role: 'user', content: text,
        attachments: atts.length
          ? atts.map(a => ({ filename: a.filename, file_type: a.file_type, size_bytes: a.size_bytes, kind: a.kind, previewUrl: a.previewUrl }))
          : undefined,
      }

      // Optimistic UI: show the user line (unless hidden) + an empty assistant bubble.
      setMsgs(hiddenUser ? currentHistory : [...currentHistory, userMsg])
      // Empty the composer immediately. Don't revoke the object URLs — the message bubble
      // now owns them for its thumbnail.
      if (atts.length) setChatAttachments([])
      setInput('')
      setOrbActive(true)
      setStreaming(true)
      streamingRef.current = true        // synchronous — the guard above reads this, not state
      spectreInterruptRef.current = false // fresh turn — clear any prior interrupt flag
      setMsgs(m => [...m, { role: 'assistant', content: '' }])

      // ── Assemble the instructional primer + live-data block ──────────────────
      // Done AFTER the optimistic render above so the user's message + the empty assistant
      // bubble appear the instant Enter is pressed — the (possibly networked) context
      // assembly below never delays the visible send. (Ambient [VAULT CONTEXT] auto-injection is
      // currently disabled — only fetchOpenDocContext + the explicit searchVault action inject
      // vault material.) Save-intent Layer 2: a deterministic regex gates a small one-turn nudge.
      await ensureProjectContextLoaded(scope)   // ambient directory before composing
      const base = composeStable(scope)

      // ── Persist the user turn ────────────────────────────────────────────────
      // Lazily create the session on its first message (title derived server-side
      // from the text). Append the stored row to the meta cache so the context
      // window picks it up. All best-effort — if the server is offline the chat
      // still works from the in-memory display buffer.
      let sid = activeSessionIdRef.current[scope] ?? null
      let createdTitle: string | null = null
      if (!skipPersist) {
        try {
          if (!sid) {
            // A new chat started while a section filter is active inherits that tag;
            // in "All" mode it stays untagged.
            const newTag = activeTagByScopeRef.current[scope] ?? null
            const cres = await fetch('/api/chat/sessions', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder_id: scope, firstMessage: text, tag_id: newTag }),
            })
            const cdata = await cres.json()
            if (cdata.session?.id) {
              sid = cdata.session.id
              createdTitle = cdata.session.title ?? null
              const nextIds = { ...activeSessionIdRef.current, [scope]: sid }
              activeSessionIdRef.current = nextIds
              setActiveSessionId(nextIds)
            }
          }
          if (sid) {
            const mres = await fetch(`/api/chat/sessions/${sid}/messages`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: 'user', content: text }),
            })
            const mdata = await mres.json()
            if (mdata.message) {
              const nm = [...sessionMsgMetaRef.current, mdata.message as SessionMsg]
              sessionMsgMetaRef.current = nm
              setSessionMsgMeta(nm)
            }
          }
        } catch { /* offline — fall back to the in-memory window below */ }
      }

      // ── Assemble the sliding-window context ──────────────────────────────────
      // Summaries (level-2 pinned first, then level-1, each oldest-first) fold into
      // the primer turn; recent verbatim messages follow as real turns. When nothing
      // is persisted yet (offline / greeting) we fall back to the display history.
      const meta = sessionMsgMetaRef.current
      const summaries = meta
        .filter(m => m.is_compressed && m.in_context)
        .sort((a, b) => (b.compression_level - a.compression_level) || (a.timestamp - b.timestamp))
      const verbatim: Message[] = meta.length
        // Research-result rows reach the model as a one-line note, never the raw JSON snapshot.
        ? meta.filter(m => !m.is_compressed && m.in_context).map(m => ({ role: m.role, content: m.content.startsWith(RESEARCH_MSG_PREFIX) ? researchContextLine(m.content) : m.content }))
        // Offline fallback reads the display buffer — drop ephemeral transition pills AND research
        // cards (kind-tagged, empty content) so they never reach the API.
        : [...currentHistory.filter(m => !m.kind), userMsg]

      const summaryBlock = summaries.length
        ? `\n\n[EARLIER CONVERSATION — COMPRESSED HISTORY]\n${summaries.map(s => `- ${s.content}`).join('\n')}`
        : ''
      const msgCount = meta.length ? verbatim.length : currentHistory.length + 1
      const sessTitle = createdTitle
        ?? sessionsRef.current[scope]?.find(s => s.id === sid)?.title
        ?? 'new conversation'
      // Per-turn VOLATILE context — injected into the current user turn (API-only) below, NOT
      // the primer, so the primer stays a byte-stable cacheable prefix. Timestamp + session
      // counter + open-doc retrieval + save-intent nudge all change every turn.
      const sessionContextText = skipPersist ? '' :
        `[SESSION CONTEXT]\nActive conversation: "${sessTitle}"${sid ? ` (id ${sid})` : ''}. Messages so far: ${msgCount}.` +
        (summaries.length ? ` Earlier history is compressed into ${summaries.length} summar${summaries.length === 1 ? 'y' : 'ies'} (deepest level ${summaries[0].compression_level}) — treat those summaries as established context.` : '')
      const openDocBlock = hiddenUser ? '' : await fetchOpenDocContext(text)
      const turnContext = [
        composeVolatile(),
        // Training live-data rides the volatile turn (not the cached prefix) — see composeStable.
        scope === 'training' ? buildLiveBlock(scope, weekEventsRef.current, ouraDataRef.current, projectsRef.current, workoutsRef.current, exercisesRef.current, viewDateRef.current, openBlockRef.current) : '',
        sessionContextText,
        openDocBlock,
        (!hiddenUser && detectSaveIntent(text)) ? SAVE_INTENT_BLOCK : '',
      ].filter(Boolean).join('\n\n').trim()

      const primerFinal = (base + summaryBlock).trim()
      // The hidden voice greeting is a standalone prompt that is deliberately never
      // persisted, so it is absent from `verbatim` whenever the active scope already has
      // history (meta.length > 0 — the common case, e.g. main auto-resumes its last
      // session). In that state the greeting turn was being dropped, leaving a request
      // that ends on an assistant turn or, in compressed/empty-primer edge cases, an
      // empty/invalid messages array. Claude rejects that with a 400, which the spectre
      // route reports as the generic "Claude is unavailable" 502 — surfacing in voice mode
      // as a misleading "Claude is down" message even though Claude (and text chat) are
      // fine. Send the greeting as its own trailing user turn so the request is always
      // valid and non-empty.
      const apiTurns: Message[] = hiddenUser ? [userMsg] : verbatim
      // content is `unknown` so the current user turn can carry image content blocks; the
      // route forwards `messages` verbatim to Claude (string or block array both valid).
      const apiMessages: { role: 'user' | 'assistant'; content: unknown }[] = primerFinal
        ? [{ role: 'user', content: primerFinal }, { role: 'assistant', content: 'Understood.' }, ...apiTurns]
        : (apiTurns.length ? apiTurns : [userMsg])

      // ── Attachments → file text (PDF/text extraction) + image content blocks ─────
      // Display/persist keep the user's typed text + attachment metadata; the file text
      // and images are injected only into the live API turn so Spectre can reference them.
      if (atts.length) {
        let apiFileText = ''
        const imageBlocks: Record<string, unknown>[] = []
        for (const a of atts) {
          const fileId = a.uploadPromise ? await a.uploadPromise : a.fileId
          if (a.kind === 'image') {
            const b64 = a.base64 ?? (a.base64Promise ? await a.base64Promise : undefined)
            if (b64) imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data: b64 } })
            else apiFileText += `File attached: ${a.filename} — (image could not be read)\n\n`
          } else if ((a.kind === 'pdf' || a.kind === 'text') && fileId) {
            try {
              const r = await fetch('/api/files/extract-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: fileId }) })
              const d = await r.json()
              apiFileText += d?.text ? `File: ${a.filename}\n\n${d.text}\n\n` : `File attached: ${a.filename} — (couldn't read its text)\n\n`
            } catch { apiFileText += `File attached: ${a.filename} — (couldn't read its text)\n\n` }
          } else {
            apiFileText += `File attached: ${a.filename} — ask me to read it if relevant\n\n`
          }
        }
        // Replace the trailing user turn's content with the augmented text (+ images).
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === 'user') {
            const typed = String(apiMessages[i].content ?? '')
            const combined = `${apiFileText}${typed || (imageBlocks.length ? '(see attached image)' : '')}`.trim()
            apiMessages[i] = imageBlocks.length
              ? { role: 'user', content: [{ type: 'text', text: combined }, ...imageBlocks] }
              : { role: 'user', content: combined }
            break
          }
        }
      }

      // Inject the per-turn volatile context as a prefix on the CURRENT user turn (API-only;
      // display + persistence keep the user's literal text). This keeps the big primer above
      // byte-stable so the model's prompt cache is reused every turn (~3s → ~1s first token).
      if (turnContext) {
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === 'user') {
            const c = apiMessages[i].content
            const prefix = `${turnContext}\n\n---\n\n`
            apiMessages[i] = typeof c === 'string'
              ? { role: 'user', content: prefix + c }
              : Array.isArray(c)
                ? { role: 'user', content: [{ type: 'text', text: prefix }, ...(c as unknown[])] }
                : { role: 'user', content: prefix + String(c ?? '') }
            break
          }
        }
      }

      // Think Mode is Claude-only (its thinking params abort llama-server) and is skipped for hidden
      // turns (the greeting must stay fast). Show the "Thinking" indicator until first token: always
      // for LOCAL (gpt-oss always pauses before streaming → looks frozen otherwise), Claude only on
      // Think Mode. Hidden turns get neither.
      const isLocal = backendFor(selectedModelRef.current) === 'local'
      // Voice ALWAYS prioritizes latency — never enable Claude extended thinking on a spoken turn
      // (it adds seconds), regardless of the REASONING bar. (LOCAL is floored to LOW in reasoningEffort.)
      const think = !hiddenUser && !isLocal && !voice && (effortModeRef.current === 'high' || thinkModeRef.current)
      setSearching(false)
      setDeepThinking(!hiddenUser && (isLocal || think))

      // Hoisted so the catch can tell a mid-stream cutoff (partial text already shown) from a
      // clean failure (nothing arrived) and preserve whatever streamed in.
      let accumulated = ''
      try {
        // FIX 2 — postSpectre logs the real status + retries once (2s) on a transient
        // failure (503 / network drop / timeout), speaking a brief notice first in voice
        // mode. A non-transient failure (credits/auth) throws the server's verbatim reason.
        const res = await postSpectre({ messages: apiMessages, model: backendFor(selectedModelRef.current), modelId: selectedModelRef.current, voice, save: !skipMemory, skipMemory, think, effort: effortModeRef.current, userText: text }, voice)
        if (!res.body) throw new Error('No stream')
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let spokenIdx = 0   // chars of cleaned text already queued to TTS (voice mode)
        let lastFlush = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          accumulated += dec.decode(value)
          // PERF: coalesce render updates to ~30/sec. Tokens arrive far faster than that, and
          // re-rendering (+ re-stripping the whole buffer) on every chunk is O(n²) — the main
          // cause of long-reply lag. The final, complete state is always flushed after the loop,
          // so throttling only drops intermediate frames, never content.
          const now = Date.now()
          if (now - lastFlush < 33) continue
          lastFlush = now
          // Strip the web-search sentinel (may straddle chunks — detect on the full buffer).
          const markerless = accumulated.split(SEARCH_MARKER).join('')
          const displayText = stripJsonForDisplay(markerless)
          if (displayText.trim() !== '') {
            setSearching(false)
            setDeepThinking(false)
            setChatStatus(null)
          } else if (accumulated.includes(SEARCH_MARKER)) {
            setSearching(true)
            setDeepThinking(false)
          }
          setMsgs(m => {
            const copy = [...m]
            copy[copy.length - 1] = { ...copy[copy.length - 1], content: displayText }
            return copy
          })
          // Voice mode: queue complete sentences for TTS as they arrive so the first
          // audio starts within a second or two rather than after the whole response.
          // Skip once this turn has been superseded by a manual interrupt (turnSeq stale).
          if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current) {
            if (voiceTimingRef.current && !voiceTimingRef.current.firstToken && displayText.trim()) voiceTimingRef.current.firstToken = performance.now()
            const { sentences, newIdx } = extractSentences(displayText, spokenIdx)
            sentences.forEach(s => enqueueSentence(s))
            spokenIdx = newIdx
          }
        }

        // Final voice flush — the throttle may have skipped the last window, so enqueue any
        // remaining complete sentences (TTS would otherwise miss the tail of a short reply).
        // CRITICAL: advance spokenIdx here. The completion block below computes the tail as
        // fc.slice(spokenIdx); if this flush enqueues sentences without moving spokenIdx, the tail
        // re-enqueues those exact sentences and the reply is SPOKEN TWICE (the "Online. Online."
        // double-greeting). With spokenIdx advanced, the tail is only the trailing fragment.
        if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current) {
          const finalDisplay = stripJsonForDisplay(accumulated.split(SEARCH_MARKER).join(''))
          const { sentences, newIdx } = extractSentences(finalDisplay, spokenIdx)
          sentences.forEach(s => enqueueSentence(s))
          spokenIdx = newIdx
        }

        setSearching(false)
        setDeepThinking(false)
        // Drop the web-search sentinel before parsing/displaying the final response.
        const finalAccumulated = accumulated.split(SEARCH_MARKER).join('')
        // Parse all actions and update the appropriate UI panels
        const { cleanText, actions } = extractAllSpectreActions(finalAccumulated)
        // A voice interrupt mid-stream bumps turnSeq — a superseded turn must NOT run actions,
        // persist a cut-off reply, or retitle (data integrity: no stray calendar/doc writes from
        // a turn the user cancelled).
        const superseded = voice && turnSeq !== voiceTurnSeqRef.current
        if (!superseded) enqueueActionsRef.current(actions, scope)
        // A read/search follows: show a silent status indicator (not a filler bubble) and
        // skip persisting this intermediate — the drain's regenerate produces the real answer.
        const drain = drainStatusFor(actions)
        if (drain) setChatStatus(drain)
        // Local models sometimes output only JSON with no prose — derive a one-line
        // confirmation so the bubble never appears empty (skipped for pure-drain turns).
        const finalText = drain ? cleanText : (cleanText || describeActions(actions))
        // Save-intent Layer 3: substantial reply with no save action → ephemeral 💾 chip
        // (skipped for the hidden greeting + pure-drain turns).
        const saveOffer = (hiddenUser || drain) ? null : buildSaveOffer(cleanText, actions)
        setMsgs(m => {
          const copy = [...m]
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: finalText, ...(saveOffer ? { saveOffer } : {}) }
          return copy
        })

        // ── Persist the assistant turn + recursively compress if needed ─────────
        // Store the CLEAN prose (no action JSON / search markers) so replayed
        // context stays signal. Then, if the active context is approaching the
        // model's window, fold the oldest turns into summaries in the background.
        if (!superseded && !drain && !skipPersist && sid && finalText.trim()) {
          try {
            const ares = await fetch(`/api/chat/sessions/${sid}/messages`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: 'assistant', content: finalText }),
            })
            const adata = await ares.json()
            if (adata.message) {
              const nm = [...sessionMsgMetaRef.current, adata.message as SessionMsg]
              sessionMsgMetaRef.current = nm
              setSessionMsgMeta(nm)
            }
            const cid = sid
            if (adata.needsCompression && cid && !compressingRef.current) {
              compressingRef.current = true
              ;(async () => {
                try {
                  await fetch(`/api/chat/sessions/${cid}/compress`, { method: 'POST' })
                  const r = await fetch(`/api/chat/sessions/${cid}/messages`, { cache: 'no-store' })
                  const d = await r.json()
                  if (Array.isArray(d.messages)) {
                    sessionMsgMetaRef.current = d.messages
                    setSessionMsgMeta(d.messages)
                  }
                  loadSessions(scope)
                } catch { /* offline */ } finally { compressingRef.current = false }
              })()
            }
            loadSessions(scope)   // refresh list ordering + preview

            // Smart-rename on the first exchange only. Haiku generates a specific
            // 3-6 word title from the actual content rather than the raw opening
            // words. Fire-and-forget: any failure silently keeps the derived title.
            if (createdTitle !== null && sid && finalText.trim()) {
              ;(async () => {
                try {
                  const rres = await fetch(`/api/chat/sessions/${sid}/retitle`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userMessage: text, assistantResponse: finalText.slice(0, 200) }),
                  })
                  if (rres.ok) loadSessions(scope)  // pull the updated title into the list
                } catch { /* keep derived title */ }
              })()
            }
          } catch { /* offline — in-memory chat already shows the reply */ }
        }
        // Voice mode: flush any remaining text after the last sentence boundary, then
        // mark the queue done. pumpTTS will call onSpeakingComplete once the last
        // audio item plays (or immediately if nothing was enqueued). Skipped when this turn
        // was interrupted (turnSeq stale) — the interrupt already reopened the mic, so we
        // must NOT flush a tail or re-run onSpeakingComplete here. ALSO skipped for a drain
        // (readFile/searchVault/readNotebook): the drain's regenerate produces and SPEAKS the
        // real answer and reopens the mic — completing here would prematurely re-arm the mic
        // and leave the actual answer silent (the S1(f) bug). Stay in THINKING until the drain.
        if (voice && voiceModeRef.current && turnSeq === voiceTurnSeqRef.current && !drain) {
          const fc = stripJsonForDisplay(finalAccumulated)
          let tail = fc.slice(Math.min(spokenIdx, fc.length)).trim()
          if (!fc.trim() && !cleanText) tail = describeActions(actions)  // only-JSON response
          if (tail) {
            console.log('[TTS] flushing tail:', tail.slice(0, 80))
            enqueueSentence(tail)
          }
          finalizeTtsStreamDone()   // branches streaming vs buffered; completes the spoken turn
        }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transient = (err as any)?.transient === true   // postSpectre exhausted its retry
        setChatStatus(null)   // an error ends any read/search in progress — clear the indicator
        // Deliberate interrupt (handleMicTap during THINKING aborted the stream + bumped turnSeq):
        // it already stopped audio and reopened the mic. Drop the empty/partial bubble and unwind
        // cleanly — no error text, no extra mic reopen, no persist.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any)?.interrupted === true || (voice && turnSeq !== voiceTurnSeqRef.current)) {
          setMsgs(m => { const c = [...m]; const last = c[c.length - 1]; if (last && last.role === 'assistant' && !String(last.content).trim()) c.pop(); return c })
          return
        }
        const raw = err instanceof Error ? err.message : String(err)
        const isOffline = err instanceof TypeError || raw === 'offline' || raw === 'No stream' || raw === 'Failed to fetch'
        // A mid-stream cutoff — the long-response "BodyStreamBuffer was aborted" class of failure,
        // or any abort/stream interruption after the body began arriving. The user must NEVER see
        // that raw error: preserve whatever already streamed in and, in Spectre's own voice, say it
        // ran long so the user can ask to continue. (Distinct from `transient`/`isOffline`, which never
        // delivered a body.)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const streamCutoff = !transient && !isOffline && (
          /bodystreambuffer|aborted|the operation was aborted|network error|err_incomplete|stream (was )?(closed|interrupted)/i.test(raw) ||
          (err as any)?.name === 'AbortError'
        )
        let errorText: string
        if (streamCutoff) {
          const partial = stripJsonForDisplay(accumulated.split(SEARCH_MARKER).join('')).trim()
          const note = 'That response ran too long and got cut off — ask me to continue and I’ll pick up where I left off, or break it into parts.'
          errorText = partial ? `${partial}\n\n_⚠️ ${note}_` : note
          console.warn('[Spectre] stream cut off mid-response — handled gracefully:', raw)
        } else {
          // Transient → a specific "tap to retry" placeholder (kind:'error' renders the button).
          // Otherwise a non-network message is the server's actionable reason — show it verbatim.
          errorText = transient
            ? 'Spectre is temporarily unreachable — tap to retry'
            : isOffline
              ? 'Spectre is temporarily offline. Restart the dev server to reconnect.'
              : raw
          // In voice mode the spectre route's generic "Claude is unavailable… switch to AI
          // Model → LOCAL" body is misleading: that AI-Model toggle was removed, and a voice
          // failure here is the spoken turn itself, not Claude (text chat shares the same
          // model and works). Show an accurate, voice-relevant message instead of echoing
          // the stale route copy. (Text chat keeps the verbatim server reason above.)
          if (voice && voiceModeRef.current && !isOffline && !transient) {
            errorText = 'That voice turn didn’t go through — the mic is open, try again. (If audio is silent, check the voice provider in settings ⚙.)'
          }
        }
        setMsgs(m => {
          const copy = [...m]
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: errorText, kind: transient ? 'error' : undefined }
          return copy
        })
        // Voice mode: a failed turn should still reopen the mic — the conversation loop
        // must survive errors. Brief delay to avoid hot-looping on persistent failures.
        // reopenMicAndListen (NOT startListening) because the mic tracks are stopped after
        // SPEAKING — startListening needs a live stream and would silently no-op on a closed mic.
        if (voice && voiceModeRef.current) {
          stopSpeaking()
          setTimeout(() => { if (voiceModeRef.current) reopenMicAndListen() }, 1200)
        }
      } finally {
        setStreaming(false)
        streamingRef.current = false
        setOrbActive(false)
        setSearching(false)
        setDeepThinking(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streaming]
  )

  // ── Sentence-streamed TTS queue ───────────────────────────────────────────
  // In voice mode, audio is the primary output. Sentences are fetched concurrently
  // from Cartesia but played strictly in order so playback is seamless.

  // Single reusable <audio> element — created lazily, reused for every sentence so
  // that one gesture-unlock (in unlockAudio) covers all later programmatic playback.
  const getTtsAudio = () => {
    if (!ttsAudioRef.current) ttsAudioRef.current = new Audio()
    return ttsAudioRef.current
  }

  // Unlock audio inside a user gesture (mobile Safari). Two things must happen here,
  // synchronously within the click, or iOS will block them later:
  //   1. Create + resume the AudioContext — iOS starts it suspended, and a suspended
  //      context makes the VAD analyser read pure silence (mic detection would fail).
  //   2. Play a silent clip on the reusable <audio> element so subsequent programmatic
  //      .play() calls (the greeting and every sentence) are allowed to autoplay.
  const unlockAudio = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!audioCtxRef.current && Ctx) audioCtxRef.current = new Ctx()
    audioCtxRef.current?.resume?.().catch(() => {})
    if (!audioUnlockedRef.current) {
      const a = getTtsAudio()
      try {
        a.muted = true
        a.src = silentWavDataUri()
        const p = a.play()
        const done = () => { a.pause(); a.muted = false; audioUnlockedRef.current = true }
        if (p && typeof p.then === 'function') p.then(done).catch(() => { a.muted = false })
        else done()
      } catch { /* ignore */ }
    }
  }

  // Turn-based voice: the instant the first TTS packet plays (SPEAKING begins) the mic is
  // PHYSICALLY CLOSED — tracks stopped (not just muted) so the hardware mic shuts off, the
  // VAD/analyser loop is cancelled, and the passive recorder is discarded. It stays closed
  // for the whole SPEAKING state (incl. the gaps between sentence packets) and is reopened
  // with a fresh getUserMedia only when playback ends (reopenMicAndListen). Idempotent — the
  // repeat pumpTTS calls per packet are no-ops once the mic is already closed.
  const closeMicForPlayback = () => {
    if (!micStreamRef.current && !isMicOpenRef.current) return
    isMicOpenRef.current = false
    ttsHardMuteRef.current = true
    if (micCooldownTidRef.current) { clearTimeout(micCooldownTidRef.current); micCooldownTidRef.current = null }
    // Discard any passive listening recorder.
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      cancelNextRef.current = true
      try { recorderRef.current.stop() } catch { /* ignore */ }
    }
    recorderRef.current = null
    // Stop the VAD loop + drop the analyser — NO analyser/energy/language gate runs in SPEAKING.
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    analyserRef.current = null
    // Physically stop the mic tracks so the hardware mic closes (keep the AudioContext alive
    // for the reopen — closing it can leave iOS suspended).
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
  }

  // Reopen the mic after SPEAKING (tracks were stopped, so this needs a fresh getUserMedia
  // via acquireMic) and resume the hands-free listening loop. Used by both the natural
  // end-of-queue cooldown and the manual button interrupt.
  const reopenMicAndListen = async () => {
    if (!voiceModeRef.current) return
    ttsHardMuteRef.current = false   // release the gate so startListening proceeds
    try {
      await acquireMic()             // fresh getUserMedia + analyser + restart vadTick
    } catch {
      setVoicePhase('idle')          // mic failed to reopen — don't hang in SPEAKING
      return
    }
    if (!voiceModeRef.current) return
    isMicOpenRef.current = true
    startListening()
  }

  // These operate entirely on refs, so they're plain functions (no memoization needed).
  // Full teardown for barge-in / failover / turn-end: cancel the in-flight TTS request,
  // empty both queues, and stop the current audio.
  const stopSpeaking = () => {
    // A new turn / interrupt supersedes playback — clear the hard-mute gate + cooldown timer.
    // (The mic itself is reopened by the caller via reopenMicAndListen when needed.)
    if (micCooldownTidRef.current) { clearTimeout(micCooldownTidRef.current); micCooldownTidRef.current = null }
    ttsHardMuteRef.current = false
    // 1. REQUEST queue — drop everything pending and abort whatever's in flight.
    ttsRequestQueueRef.current = []
    ttsRequestActiveRef.current = false
    if (ttsCurrentControllerRef.current) {
      try { ttsCurrentControllerRef.current.abort() } catch { /* ignore */ }
      ttsCurrentControllerRef.current = null
    }
    // 2. PLAYBACK queue — abort per-item fetches and revoke any object URLs.
    ttsItemsRef.current.forEach(it => {
      it.aborted = true
      try { it.controller.abort() } catch { /* ignore */ }
      if (it.url) URL.revokeObjectURL(it.url)
    })
    ttsItemsRef.current = []
    ttsCursorRef.current = 0
    ttsPlayingRef.current = false
    ttsStreamDoneRef.current = false
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null
      currentAudioRef.current.onerror = null
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }
    // 3. Streaming (Web Audio) path — stop + drop every scheduled buffer source and reset the
    // gapless cursor so the next turn schedules from `now`, not stale future time.
    scheduledSourcesRef.current.forEach(s => { try { s.onended = null; s.stop() } catch { /* already stopped */ } })
    scheduledSourcesRef.current = []
    audioCursorRef.current = 0
    stopBargeRecorder()   // playback is ending — drop any in-flight interruption capture
    setTtsPlaying(false)
  }

  // Called when both queues drain after the text stream is fully done.
  const onSpeakingComplete = () => {
    // Latency probe — one line per spoken turn: end-of-speech → first audio (the number the user
    // feels), broken into the STT+LLM gap and the first-token→first-audio (TTS) gap.
    const tm = voiceTimingRef.current
    if (tm && tm.t0 && tm.firstAudio) {
      const toFirstToken = tm.firstToken ? Math.round(tm.firstToken - tm.t0) : null
      const toFirstAudio = Math.round(tm.firstAudio - tm.t0)
      const ttsGap = tm.firstToken ? Math.round(tm.firstAudio - tm.firstToken) : null
      console.log(`[VOICE LATENCY] end-of-speech → first audio: ${toFirstAudio}ms` +
        (toFirstToken !== null ? ` (STT+LLM→first token ${toFirstToken}ms, TTS first-token→audio ${ttsGap}ms)` : ''))
    }
    voiceTimingRef.current = null
    ttsItemsRef.current = []
    ttsCursorRef.current = 0
    ttsStreamDoneRef.current = false
    ttsPlayingRef.current = false
    ttsRequestQueueRef.current = []
    ttsRequestActiveRef.current = false
    ttsCurrentControllerRef.current = null
    scheduledSourcesRef.current = []
    audioCursorRef.current = 0
    setTtsPlaying(false)
    if (voiceModeRef.current) {
      // SPEAKING → LISTENING: the playback queue is fully drained. The mic has been closed
      // since SPEAKING began; wait the 350ms cooldown (mic stays closed — orb shows IDLE),
      // then reopen it with a fresh getUserMedia and resume listening.
      stopBargeRecorder()
      setVoicePhase('idle')
      if (micCooldownTidRef.current) clearTimeout(micCooldownTidRef.current)
      micCooldownTidRef.current = setTimeout(() => {
        micCooldownTidRef.current = null
        reopenMicAndListen()
      }, MIC_REOPEN_COOLDOWN_MS)
    } else {
      stopBargeRecorder()
      ttsHardMuteRef.current = false
      setVoicePhase('idle')
    }
  }

  // ── Streaming TTS (Cartesia SSE → Web Audio) ──────────────────────────────────
  // Used only when the opt-in toggle is on, an AudioContext exists, and we're on Cartesia (the
  // streaming route is Cartesia-only; LOCAL/Chatterbox keeps the buffered path). First audio lands
  // at ~265ms (vs ~975ms buffered). Plays raw pcm_s16le via the SHARED audio cursor so consecutive
  // sentences are gapless; the buffer declares Cartesia's exact 44.1kHz so there's no pitch shift.
  const ttsStreamingOn = () => ttsStreamingRef.current && !!audioCtxRef.current && ttsModeRef.current !== 'local'

  // Completes the turn once the text stream is done AND every sentence has been received AND all
  // scheduled audio has finished playing — the streaming analogue of pumpTTS's drain check.
  const maybeStreamingComplete = () => {
    if (!ttsStreamDoneRef.current) return
    if (ttsRequestActiveRef.current || ttsRequestQueueRef.current.length > 0) return
    if (scheduledSourcesRef.current.length > 0) return
    onSpeakingComplete()
  }

  // Fetch one sentence's PCM stream and schedule it gaplessly on the shared cursor. Resolves when
  // the whole sentence has been RECEIVED (so the next sentence can start fetching while this one
  // is still playing out). Throws (with .status on an HTTP error) so the caller can fail over.
  const streamSentenceWebAudio = async (text: string, controller: AbortController): Promise<void> => {
    const ctx = audioCtxRef.current
    if (!ctx) throw new Error('no AudioContext')
    ctx.resume?.().catch(() => {})
    const res = await fetch('/api/tts/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: controller.signal,
    })
    if (!res.ok || !res.body) throw Object.assign(new Error(`stream tts ${res.status}`), { status: res.status })
    const sampleRate = Number(res.headers.get('X-Sample-Rate')) || 44100
    const reader = res.body.getReader()
    let leftover: Uint8Array | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done || controller.signal.aborted) break
      // Combine any odd trailing byte from the previous chunk; process whole 16-bit LE samples.
      let bytes: Uint8Array = value
      if (leftover) { const merged = new Uint8Array(leftover.length + value.length); merged.set(leftover); merged.set(value, leftover.length); bytes = merged; leftover = null }
      const usable = bytes.length - (bytes.length % 2)
      if (usable < bytes.length) leftover = bytes.slice(usable)
      if (usable === 0) continue
      const sampleCount = usable / 2
      const dv = new DataView(bytes.buffer, bytes.byteOffset, usable)
      const f32 = new Float32Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) f32[i] = dv.getInt16(i * 2, true) / 32768
      const audioBuf = ctx.createBuffer(1, sampleCount, sampleRate)
      audioBuf.copyToChannel(f32, 0)
      const src = ctx.createBufferSource()
      src.buffer = audioBuf
      src.connect(ctx.destination)
      // Contiguous with the previous buffer (gapless); +20ms lookahead only if we've underrun.
      // (If playback falls behind the network, audioCursorRef < currentTime and a small silent gap
      // is inserted rather than overlapping — a quality blemish, never an overlap.)
      const startAt = Math.max(ctx.currentTime + 0.02, audioCursorRef.current)
      // Skip a single buffer that fails to start (bad ctx state) rather than abandoning the rest of
      // the sentence — the resolve path's maybeStreamingComplete() is still the completion backstop.
      try { src.start(startAt) } catch { continue }
      audioCursorRef.current = startAt + audioBuf.duration
      scheduledSourcesRef.current.push(src)
      src.onended = () => {
        const arr = scheduledSourcesRef.current
        const idx = arr.indexOf(src); if (idx >= 0) arr.splice(idx, 1)
        maybeStreamingComplete()
      }
      // First audio of the turn → enter SPEAKING + close the mic (mirrors the blob pumpTTS).
      if (!ttsPlayingRef.current && voiceModeRef.current) {
        ttsPlayingRef.current = true
        setTtsPlaying(true)
        setVoicePhase('speaking')
        if (!BARGE_IN_ENABLED) closeMicForPlayback()
        if (voiceTimingRef.current && !voiceTimingRef.current.firstAudio) voiceTimingRef.current.firstAudio = performance.now()
      }
    }
  }

  // Mark the text stream complete and kick the right drain (streaming vs buffered) — shared by
  // sendMessage and regenerate so both paths complete a spoken turn identically.
  const finalizeTtsStreamDone = () => {
    ttsStreamDoneRef.current = true
    if (ttsStreamModeRef.current) {
      // Streaming: completion fires from the last buffer's onended (maybeStreamingComplete). If
      // nothing was ever scheduled (empty reply), complete now.
      if (!ttsRequestActiveRef.current && ttsRequestQueueRef.current.length === 0 && scheduledSourcesRef.current.length === 0) onSpeakingComplete()
      else { pumpTtsRequests(); maybeStreamingComplete() }
    } else if (ttsItemsRef.current.length === 0 && ttsRequestQueueRef.current.length === 0 && !ttsRequestActiveRef.current) {
      onSpeakingComplete()
    } else { pumpTtsRequests(); pumpTTS() }
  }

  // Advances the PLAYBACK queue: plays the item at the cursor once its audio is ready.
  const pumpTTS = () => {
    if (ttsPlayingRef.current) return
    const item = ttsItemsRef.current[ttsCursorRef.current]
    if (!item) {
      // Nothing ready to play. Finish only when the stream is done AND no more audio is
      // coming (request queue empty + nothing in flight). Otherwise wait — the request
      // pump re-calls pumpTTS as each blob arrives.
      if (ttsStreamDoneRef.current && ttsRequestQueueRef.current.length === 0 && !ttsRequestActiveRef.current) onSpeakingComplete()
      return
    }
    if (item.aborted) { ttsCursorRef.current++; pumpTTS(); return }
    if (!item.url) return  // still fetching — the request pump will re-pump when ready
    ttsPlayingRef.current = true
    setTtsPlaying(true)
    if (voiceModeRef.current) {
      setVoicePhase('speaking')
      // Turn-based: hard-close the mic for the whole SPEAKING state. Skipped only if barge-in
      // is re-enabled (it needs the mic open to listen) — so BARGE_IN_ENABLED is the single
      // toggle. reopenMicAndListen → acquireMic is idempotent, so the reopen path is unchanged.
      if (!BARGE_IN_ENABLED) closeMicForPlayback()
    }
    const audio = getTtsAudio()
    audio.muted = false
    audio.src = item.url
    currentAudioRef.current = audio
    // Latency probe: first audio of this turn actually reaching the speaker.
    if (voiceTimingRef.current && !voiceTimingRef.current.firstAudio) voiceTimingRef.current.firstAudio = performance.now()
    let advanced = false
    const advance = () => {
      if (advanced) return
      advanced = true
      audio.onended = null
      audio.onerror = null
      if (item.url) { URL.revokeObjectURL(item.url); item.url = null }
      currentAudioRef.current = null
      ttsPlayingRef.current = false
      ttsCursorRef.current++
      pumpTTS()
    }
    audio.onended = advance
    audio.onerror = advance
    audio.play().catch(advance)
  }

  // Transient notification, auto-dismissed. Survives exiting voice mode.
  const showToast = (msg: string, ms = 6500) => {
    setToast(msg)
    if (toastTidRef.current) clearTimeout(toastTidRef.current)
    toastTidRef.current = setTimeout(() => setToast(null), ms)
  }

  const sys = (path: string, body?: unknown) =>
    fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
      : { cache: 'no-store' })

  // Cartesia → local-TTS voice failover. Fires only from within active voice
  // mode when a Cartesia TTS call returns 402/429 (credits gone). The local
  // stack (Chatterbox :8004) is always-on, so no container orchestration or
  // VRAM shuffling — verify the local engine is listening, flip the toggle,
  // resume.
  const runVoiceFailover = async () => {
    if (failoverActiveRef.current) return
    failoverActiveRef.current = true
    try {
      stopSpeaking()                       // abort the dead Cartesia queue
      setVoicePhase('reconfiguring')

      // Is the local TTS engine (Chatterbox) reachable? 403 = not
      // authorized to orchestrate (e.g. public Funnel) — fail fast.
      let healthy = false
      try {
        const r = await fetch('/api/system/docker-health', { cache: 'no-store' })
        if (r.status !== 403) healthy = !!(await r.json()).healthy
      } catch { /* unreachable → unhealthy */ }

      if (!healthy) { await failVoice(); return }

      setTtsMode('local'); ttsModeRef.current = 'local'
      sys('/api/system/log', {
        event: 'Cartesia 402/429 → failover to local TTS (Chatterbox). TTS → LOCAL.',
      }).catch(() => {})
      showToast('Voice reconfigured — running locally. Cartesia credits exhausted.', 7000)
      if (voiceModeRef.current) {
        setVoicePhase('idle')
        startListening()                   // mic reactivates; new sentences route to local TTS
      }
    } finally {
      failoverActiveRef.current = false
    }
  }

  // Failure path: local voice couldn't come online — exit to text mode.
  const failVoice = async () => {
    showToast('Voice unavailable — Cartesia credits exhausted and no local TTS engine is running. Top up credits or start the local stack (docker compose up -d).', 10_000)
    sys('/api/system/log', { event: 'Cartesia 402/429 failover FAILED — no local TTS engine reachable (or not authorized). Returned to text mode.' }).catch(() => {})
    exitVoiceMode()
  }

  // Queues a sentence for TTS: strips markdown/thinking tokens, then appends to the
  // REQUEST queue. The request pump sends it (and its peers) one at a time.
  const enqueueSentence = (text: string) => {
    const spoken = stripMarkdown(stripThinkingTokens(text)).trim()
    if (!spoken) return
    // Lock the streaming-vs-buffered decision for the WHOLE turn on its first sentence (when nothing
    // is queued/active/playing/scheduled), so a mid-reply toggle can't split the turn across paths.
    if (ttsRequestQueueRef.current.length === 0 && !ttsRequestActiveRef.current && !ttsPlayingRef.current && scheduledSourcesRef.current.length === 0) {
      ttsStreamModeRef.current = ttsStreamingOn()
    }
    ttsRequestQueueRef.current.push(spoken)
    pumpTtsRequests()
  }

  // Drains the REQUEST queue strictly sequentially: send one sentence, wait for its audio,
  // then send the next. Never fires concurrent TTS requests (Chatterbox quality degrades).
  // Each resolved blob lands in the PLAYBACK queue and kicks pumpTTS, so playback proceeds
  // in parallel with fetching the following sentence.
  const pumpTtsRequests = () => {
    if (ttsRequestActiveRef.current) return
    const spoken = ttsRequestQueueRef.current.shift()
    if (spoken === undefined) return
    ttsRequestActiveRef.current = true
    const controller = new AbortController()
    ttsCurrentControllerRef.current = controller

    // ── Streaming path (opt-in, Cartesia only) ──────────────────────────────────
    // Fetch + schedule this sentence's PCM via Web Audio. Resolves once the sentence is fully
    // RECEIVED, so the next sentence starts fetching while this one plays out (gapless cursor).
    // Reads the per-turn snapshot (NOT the live gate) so the whole turn stays on one path.
    if (ttsStreamModeRef.current) {
      streamSentenceWebAudio(spoken, controller)
        .then(() => {
          if (ttsCurrentControllerRef.current !== controller) return
          ttsRequestActiveRef.current = false
          ttsCurrentControllerRef.current = null
          pumpTtsRequests()          // next sentence schedules right after this one
          maybeStreamingComplete()   // in case this was the last and audio already drained
        })
        .catch(err => {
          // Aborted by interrupt/failover — queues already cleared; just release the lock.
          if (controller.signal.aborted) {
            if (ttsCurrentControllerRef.current === controller) { ttsRequestActiveRef.current = false; ttsCurrentControllerRef.current = null }
            return
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const status = (err as any)?.status
          if ((status === 402 || status === 429) && voiceModeRef.current && ttsModeRef.current !== 'local' && !failoverActiveRef.current) {
            console.warn('[TTS stream] Cartesia credits exhausted (', status, ') — starting voice failover')
            runVoiceFailover()   // tears down everything via stopSpeaking; the next turn uses the blob/local path
            return
          }
          // Any other failure: skip this sentence and continue (same Cartesia backend the blob
          // path uses, so a hard outage would fail there too — here we don't lose the whole turn).
          console.warn('[TTS stream] sentence failed — skipping:', err?.message ?? String(err))
          if (ttsCurrentControllerRef.current === controller) { ttsRequestActiveRef.current = false; ttsCurrentControllerRef.current = null }
          pumpTtsRequests()
          maybeStreamingComplete()
        })
      return
    }

    // ── Buffered path (default) ─────────────────────────────────────────────────
    const item: TtsItem = { url: null, aborted: false, controller }
    ttsItemsRef.current.push(item)
    // Advance to the next request + (re)pump playback — but only if this request wasn't
    // superseded by a barge-in / new turn (which swaps the current controller).
    const finish = () => {
      if (ttsCurrentControllerRef.current !== controller) return
      ttsRequestActiveRef.current = false
      ttsCurrentControllerRef.current = null
      pumpTtsRequests()
      pumpTTS()
    }
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: spoken,
        provider: ttsModeRef.current === 'local' ? 'local' : 'cartesia',
      }),
      signal: controller.signal,
    })
      .then(async res => {
        if (item.aborted) { finish(); return }
        if (!res.ok) {
          // Cartesia credit exhaustion (402/429) during active voice mode →
          // orchestrate the failover to local Chatterbox. Outside voice mode, or
          // when already on Chatterbox, fall through to the silent skip below.
          const creditExhausted = res.status === 402 || res.status === 429
          if (creditExhausted && voiceModeRef.current && ttsModeRef.current !== 'local' && !failoverActiveRef.current) {
            console.warn('[TTS] Cartesia credits exhausted (', res.status, ') — starting voice failover')
            item.aborted = true
            runVoiceFailover()   // tears down both queues via stopSpeaking — do not finish()
            return
          }
          // Mark aborted so pumpTTS skips this slot — critical to prevent queue deadlock.
          console.warn('[TTS] fetch failed:', res.status, '— skipping:', spoken.slice(0, 60))
          item.aborted = true
          finish()
          return
        }
        const blob = await res.blob()
        if (item.aborted) { finish(); return }
        item.url = URL.createObjectURL(blob)
        finish()
      })
      .catch(err => {
        // Aborted by barge-in/failover: queues already cleared — just release the lock.
        if (controller.signal.aborted || item.aborted) {
          if (ttsCurrentControllerRef.current === controller) {
            ttsRequestActiveRef.current = false
            ttsCurrentControllerRef.current = null
          }
          return
        }
        console.warn('[TTS] fetch error — skipping chunk:', err?.message ?? String(err))
        item.aborted = true
        finish()
      })
  }

  // ── Deep research: confirmation gate ──────────────────────────────────────────────
  // The ONLY entry point from the button and the voice/chat deepResearch action. Research can never
  // fire without an explicit "Start Research" click — this just stages the pending request + cost
  // estimate into the modal. Blocked (with a transient pill) if a run is already live in this scope.
  // A transition pill via direct buffer append (pushTransition is declared later — referencing it
  // here would hit the TDZ when this callback's deps array evaluates during render).
  const researchPill = useCallback((scope: string, text: string) => {
    updateScopeDisplay(scope, m => [...m, { role: 'assistant', content: text, kind: 'transition' }])
  }, [updateScopeDisplay])
  // Snapshot the triggering chat session's recent history for the research planner (session context
  // isolation). Reads the scope's DISPLAY buffer — i.e. the open session's messages, nothing else:
  // no Mem0, no vault, no other sessions. Drops transition pills / research cards / error bubbles
  // and empty streaming placeholders; `content` is already text-only (attachments live separately
  // on the message). Capped at the last 20 turns to control planner token usage.
  const researchHistory = useCallback((scope: string): ResearchHistoryMsg[] => {
    const buf = scope.startsWith('project-')
      ? (projectMessagesRef.current[scope] || [])
      : (allMessagesRef.current[scope] || [])
    return buf
      .filter(m => !m.kind && m.content.trim())
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }))
  }, [])
  const requestResearch = useCallback((query: string, scopeArg?: string, plan?: SpectrePlan) => {
    const q = query.trim()
    if (!q) return
    const scope = scopeArg ?? chatScope()
    if (researchRunningRef.current.has(scope)) { researchPill(scope, '→ Research already running here'); return }
    // Capture session id + history NOW, while the triggering conversation is the active one. The
    // effort tier is chosen in the confirm modal (default Quick — the original behavior).
    setResearchConfirm({
      query: q, model: selectedModelRef.current, scope, plan,
      sessionId: activeSessionIdRef.current[scope] ?? null,
      history: researchHistory(scope),
      mode: 'quick',
    })
  }, [chatScope, researchPill, researchHistory])

  // Signal the server to stop a running research run for `scope` (POST /api/research/abort). The
  // pipeline winds down to a PARTIAL synthesis and the existing SSE reader receives complete/fallback,
  // so STOP always yields output — it never kills the run silently.
  const abortResearch = useCallback((scope: string) => {
    updateScopeDisplay(scope, m => {
      const c = [...m]
      for (let i = c.length - 1; i >= 0; i--) {
        const r = c[i].research
        if (c[i].kind === 'research' && r && !r.done) { c[i] = { ...c[i], research: { ...r, aborting: true, status: 'Stopping — saving findings so far…' } }; break }
      }
      return c
    })
    void fetch('/api/research/abort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: scope, signal: 'stop' }),
    }).catch(() => { /* best-effort — the run also self-stops on client disconnect */ })
  }, [updateScopeDisplay])

  // Wind Down — the GRACEFUL exit (distinct from STOP): the current agent round finishes, no new
  // agents spawn, and the run goes straight to a FULL synthesis. This is how you exit Exhaustive mode
  // once you've seen enough. Marks the card winding-down; the server keeps streaming to completion.
  const windDownResearch = useCallback((scope: string) => {
    updateScopeDisplay(scope, m => {
      const c = [...m]
      for (let i = c.length - 1; i >= 0; i--) {
        const r = c[i].research
        if (c[i].kind === 'research' && r && !r.done) { c[i] = { ...c[i], research: { ...r, windingDown: true, status: 'Winding down — finishing current agents, then synthesizing…' } }; break }
      }
      return c
    })
    void fetch('/api/research/abort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: scope, signal: 'winddown' }),
    }).catch(() => { /* best-effort */ })
  }, [updateScopeDisplay])

  // ── Deep research launcher ──────────────────────────────────────────────────────
  // Fires /api/research (SSE), drops a live progress card into the scope's chat buffer, and updates
  // that card as events stream in. The card persists in the buffer as a record once complete. The
  // report is written server-side to a notebook (with disk/chat fallbacks); the card surfaces it.
  const startResearch = useCallback(async (query: string, scopeArg?: string, plan?: SpectrePlan, sessionId?: string | null, history?: ResearchHistoryMsg[], mode: ResearchModeUI = 'quick') => {
    const scope = scopeArg ?? chatScope()
    const model = selectedModelRef.current
    // Session context (isolation fix): prefer the snapshot taken at request time (passed through the
    // confirm modal); fall back to a live read for any caller that didn't snapshot.
    const chatSessionId = sessionId !== undefined ? sessionId : (activeSessionIdRef.current[scope] ?? null)
    const conversationHistory = history ?? researchHistory(scope)
    if (researchRunningRef.current.has(scope)) { researchPill(scope, '→ Research already running here'); return }
    researchRunningRef.current.add(scope) // client lock (FIX 2)
    const initial: ResearchCardState = {
      model, status: 'Starting research…', done: false, nodeId: scope,
      step: 'plan', sources: [], startedAt: Date.now(), cap: 110000,
      estCost: estimateResearchCost(model), mode,
    }
    updateScopeDisplay(scope, m => [...m, { role: 'assistant', content: '', kind: 'research', research: initial }])
    // Patch the most-recent research card in this scope's buffer via a functional updater.
    // `cardMirror` applies the same updaters outside React state so the final card can be
    // persisted to the session (FIX 1) without racing async state updates.
    let cardMirror: ResearchCardState = initial
    const patchCard = (updater: (prev: ResearchCardState) => ResearchCardState) => {
      cardMirror = updater(cardMirror)
      updateScopeDisplay(scope, m => {
        const c = [...m]
        for (let i = c.length - 1; i >= 0; i--) {
          const r = c[i].research
          if (c[i].kind === 'research' && r) { c[i] = { ...c[i], research: updater(r) }; break }
        }
        return c
      })
    }
    try {
      // `sessionId: scope` is the pre-existing lock/abort key (abortResearch sends the same value) —
      // unchanged. `chatSessionId` + `conversationHistory` are the triggering session's identity and
      // its last ≤20 text messages, which ground the server-side planner in the actual conversation.
      const res = await fetch('/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query, nodeId: scope, model, sessionId: scope, mode,
          chatSessionId, conversationHistory,
          ...(plan ? { plan } : {}),
        }),
      })
      if (res.status === 429) {
        patchCard(r => ({ ...r, done: true, finishedAt: Date.now(), error: 'Research is already running for this session.', status: 'Already running' }))
        return
      }
      if (!res.ok || !res.body) throw new Error('Research failed to start')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data:'))
          if (!line) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let ev: any
          try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
          switch (ev.type) {
            case 'status': patchCard(r => ({ ...r, status: String(ev.message ?? '') })); break
            case 'step': patchCard(r => ({ ...r, step: ev.step as ResearchStep })); break
            case 'tokens': patchCard(r => ({ ...r, tokens: Number(ev.used ?? 0), cap: Number(ev.cap ?? r.cap ?? 0) })); break
            // Live token + cost meter — server emits this after EVERY API call (see /api/research).
            case 'token_update': patchCard(r => ({ ...r, tokens: Number(ev.total ?? r.tokens ?? 0), cap: Number(ev.cap ?? r.cap ?? 0), cost: typeof ev.cost === 'number' ? ev.cost : r.cost })); break
            case 'searching': patchCard(r => ({ ...r, status: `Searching: ${ev.query}` })); break
            case 'source': patchCard(r => {
              const src: ResearchSource = { url: String(ev.url ?? ''), title: String(ev.title ?? ev.url ?? ''), domain: String(ev.domain ?? '') }
              if (!src.url || r.sources.some(s => s.url === src.url)) return r
              return { ...r, sources: [...r.sources, src] }
            }); break
            case 'synthesizing': patchCard(r => ({ ...r, step: 'synthesize', status: String(ev.message ?? 'Synthesizing…') })); break
            // ── DAG events (intelligent orchestrator + circuit board) ──
            case 'dag_plan': patchCard(r => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const planAgents: any[] = Array.isArray(ev.plan?.agents) ? ev.plan.agents : []
              const agents: DagAgentNode[] = planAgents.map(a => ({
                id: Number(a.id),
                name: String(a.name ?? `Agent ${a.id}`),
                directive: String(a.directive ?? ''),
                queries: Array.isArray(a.queries) ? a.queries.map(String) : [],
                dependencies: Array.isArray(a.dependencies) ? a.dependencies.map(Number) : [],
                receives_from: Array.isArray(a.receives_from) ? a.receives_from.map(Number) : [],
                state: 'waiting', sources: [], searches: [],
              }))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const levels: number[][] = Array.isArray(ev.levels) ? ev.levels.map((l: any) => Array.isArray(l) ? l.map(Number) : []) : []
              return { ...r, dag: { reasoning: String(ev.plan?.reasoning ?? ''), synthesisFocus: String(ev.plan?.synthesis_focus ?? ''), agents, levels, synthesis: 'waiting', traveling: [], resolved: [] } }
            }); break
            case 'agent_started': patchCard(r => updateDagAgent(r, ev.agentId, a => ({ ...a, state: 'running' }))); break
            case 'agent_searching': patchCard(r => updateDagAgent(r, ev.agentId, a => {
              const q = String(ev.query ?? '')
              return q && !a.searches.includes(q) ? { ...a, searches: [...a.searches, q] } : a
            })); break
            case 'agent_reading': patchCard(r => updateDagAgent(r, ev.agentId, a => {
              const src = { title: String(ev.source ?? ''), url: String(ev.url ?? ''), favicon: String(ev.favicon ?? '') }
              if (!src.title || a.sources.some(s => s.url === src.url && s.title === src.title)) return a
              return { ...a, sources: [...a.sources, src] }
            })); break
            case 'agent_complete': patchCard(r => updateDagAgent(r, ev.agentId, a => ({ ...a, state: 'complete', summaryPreview: String(ev.summaryPreview ?? '') }))); break
            case 'dependency_resolved': {
              const key = `${ev.fromAgentId}-${ev.toAgentId}`
              patchCard(r => r.dag ? { ...r, dag: { ...r.dag, traveling: r.dag.traveling.includes(key) ? r.dag.traveling : [...r.dag.traveling, key] } } : r)
              // After the 1.5s traveling pulse, settle the edge into its solid "complete" state.
              setTimeout(() => patchCard(r => r.dag ? { ...r, dag: { ...r.dag, traveling: r.dag.traveling.filter(k => k !== key), resolved: r.dag.resolved.includes(key) ? r.dag.resolved : [...r.dag.resolved, key] } } : r), 1500)
              break
            }
            case 'synthesis_started': patchCard(r => r.dag ? { ...r, dag: { ...r.dag, synthesis: 'running' } } : r); break
            case 'synthesis_complete': patchCard(r => r.dag ? { ...r, dag: { ...r.dag, synthesis: 'complete' } } : r); break
            case 'budget_warning': patchCard(r => ({ ...r, status: String(ev.message ?? 'Approaching token limit') })); break
            // Effort tier + whether Playwright full-content is active for this run.
            case 'mode': patchCard(r => ({ ...r, mode: (ev.mode as ResearchModeUI) ?? r.mode, playwright: !!ev.playwright })); break
            // Exhaustive continuation: a new round of gap-filling agents was planned — append them to the DAG.
            case 'dag_round': patchCard(r => {
              if (!r.dag) return r
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const newAgents: DagAgentNode[] = (Array.isArray(ev.agents) ? ev.agents : []).map((a: any) => ({
                id: Number(a.id), name: String(a.name ?? `Agent ${a.id}`), directive: String(a.directive ?? ''),
                queries: Array.isArray(a.queries) ? a.queries.map(String) : [], dependencies: [], receives_from: [],
                state: 'waiting' as DagNodeState, sources: [], searches: [],
              }))
              if (!newAgents.length) return r
              return { ...r, dag: { ...r.dag, agents: [...r.dag.agents, ...newAgents], levels: [...r.dag.levels, newAgents.map(a => a.id)] } }
            }); break
            // Live knowledge-saturation reading (drives the converging indicator; Exhaustive auto-winddown).
            case 'saturation': patchCard(r => ({ ...r, saturation: { round: Number(ev.round ?? 0), novelty: Number(ev.novelty ?? 0), saturation: Number(ev.saturation ?? 0), consecutiveLow: Number(ev.consecutiveLow ?? 0), threshold: Number(ev.threshold ?? 0.15), needed: Number(ev.needed ?? 3) } })); break
            case 'complete': patchCard(r => ({ ...r, done: true, step: 'save', finishedAt: Date.now(), partial: !!ev.partial, tokens: typeof ev.tokens === 'number' ? ev.tokens : r.tokens, cost: typeof ev.cost === 'number' ? ev.cost : r.cost, status: ev.partial ? 'Research stopped — partial report saved' : 'Research complete', notebookId: String(ev.notebookId ?? ''), notebookTitle: String(ev.notebookTitle ?? 'Research report') })); break
            // Notebook creation failed server-side — the full report came back so output is never lost.
            // Drop it into chat as an assistant message AND mark the card done with a note.
            case 'fallback': {
              const report = String(ev.report ?? '')
              const title = String(ev.title ?? 'Research report')
              if (report) updateScopeDisplay(scope, m => [...m, { role: 'assistant', content: `**${title}**\n\n_(Notebook save failed${ev.savedToDisk ? ' — also saved to the vault on disk' : ''}; full report below.)_\n\n${report}` }])
              patchCard(r => ({ ...r, done: true, finishedAt: Date.now(), partial: !!ev.partial, status: ev.savedToDisk ? 'Saved to disk — report posted in chat' : 'Report posted in chat' }))
              break
            }
            case 'error': patchCard(r => ({ ...r, done: true, finishedAt: Date.now(), error: String(ev.message ?? 'Research failed'), status: 'Research failed' })); break
          }
        }
      }
      // ── FIX 1: persist the completed card to the session (skip pure failures-to-start) ──
      // Saved as a bookmarked assistant row so the sliding-window compression never folds it; on
      // session load it re-renders as the static completed circuit board. Also refresh the tree
      // index + the node's notebooks so the Open Notebook button resolves immediately (FIX 2B).
      if (cardMirror.done && !cardMirror.error) {
        void refreshDiagramTree()
        if (cardMirror.notebookId) void loadNotebooks(cardMirror.nodeId)
        const sid = sessionId ?? activeSessionIdRef.current[scope] ?? null
        if (sid) {
          try {
            const pres = await fetch(`/api/chat/sessions/${sid}/messages`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: 'assistant', content: serializeResearchCard(cardMirror), is_bookmarked: true }),
            })
            const pdata = await pres.json()
            // Keep the meta cache in sync only if this session is still the active one here.
            if (pdata.message && activeSessionIdRef.current[scope] === sid) {
              const nm = [...sessionMsgMetaRef.current, pdata.message as SessionMsg]
              sessionMsgMetaRef.current = nm
              setSessionMsgMeta(nm)
            }
          } catch { /* offline — the card still lives in the display buffer */ }
        }
      }
    } catch (e) {
      patchCard(r => ({ ...r, done: true, finishedAt: Date.now(), status: 'Research failed', error: e instanceof Error ? e.message : 'Research failed' }))
    } finally {
      researchRunningRef.current.delete(scope) // release client lock
    }
  }, [chatScope, updateScopeDisplay, researchPill, researchHistory, refreshDiagramTree, loadNotebooks])

  // A failed Docu-scape write must never cost the content: drop the markdown into the
  // chat as a visible assistant message (persisted when a session is active) so the user can
  // recover it. Companion to the "→ ⚠ …failed" transition pill, which explains why.
  const preserveLostContent = (scope: string, title: string, md: string) => {
    if (!md.trim()) return
    const recovery = `⚠️ **Save failed — preserving the content${title ? ` for "${title}"` : ''} here so it isn't lost:**\n\n${md}`
    updateScopeDisplay(scope, m => [...m, { role: 'assistant', content: recovery }])
    const sid = activeSessionIdRef.current[scope] ?? null
    if (sid) {
      void fetch(`/api/chat/sessions/${sid}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'assistant', content: recovery }),
      }).catch(() => { /* offline — the display buffer still has it */ })
    }
  }

  // ── Proactive save chip (save-intent Layer 3 — zero tokens) ─────────────────────
  // Destination inference for an unprompted save: the current project Hand, else the
  // most recently visited one, else null (the chip expands to a one-click picker).
  const inferSaveTargetId = (): string | null => {
    const isPH = (id: string) => {
      const n = nodesRef.current.find(x => x.id === id)
      return !!n && n.level === 'hand' && n.parent_id === 'projects'
    }
    const cur = chatScope()
    if (isPH(cur)) return cur
    for (const s of [...navHistoryRef.current].reverse()) if (isPH(s)) return s
    return null
  }

  // Decide whether a finished assistant reply earns a save chip: substantial content
  // and no save action already emitted this turn. Pure display state — never persisted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildSaveOffer = (md: string, actions: Record<string, any>[]): SaveOffer | null => {
    if (!isSubstantialContent(md)) return null
    const alreadySaved = actions.some(a =>
      a.action === 'createDocument' || a.action === 'writeToNotebook' || (a.action === 'createNotebook' && a.content))
    if (alreadySaved) return null
    const targetId = inferSaveTargetId() ?? undefined
    const targetName = targetId ? nodesRef.current.find(n => n.id === targetId)?.name : undefined
    return { title: inferDocTitle(md), markdown: md, targetId, targetName }
  }

  // Chip click: save through the SAME verified createDocument pipeline (dedupe, retry,
  // "→ Saved" pill, auto-open, content recovery all come for free). With no inferable
  // destination, the chip expands into a project picker instead of guessing.
  const handleSaveOffer = (msg: Message, chosenId?: string) => {
    const offer = msg.saveOffer
    if (!offer) return
    const scope = chatScope()
    const target = chosenId ?? offer.targetId
    if (!target) {
      const targets = nodesRef.current
        .filter(n => n.level === 'hand' && n.parent_id === 'projects')
        .map(n => ({ id: n.id, name: n.name }))
      updateScopeDisplay(scope, m => m.map(x => x === msg ? { ...x, saveOffer: { ...offer, targets } } : x))
      return
    }
    updateScopeDisplay(scope, m => m.map(x => x === msg ? { ...x, saveOffer: undefined } : x))
    enqueueActionsRef.current([{ action: 'createDocument', title: offer.title, content: offer.markdown, node_id: target }], scope)
  }
  const dismissSaveOffer = (msg: Message) => {
    updateScopeDisplay(chatScope(), m => m.map(x => x === msg ? { ...x, saveOffer: undefined } : x))
  }

  // Applies a parsed Spectre action to the corresponding local state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applySpectreAction = useCallback((action: Record<string, any>) => {
    switch (action.action) {

      // Spectre asked to read a Sources file — queue it; the queue drains after this
      // stream completes (GET its content → feed back as a follow-up turn).
      // EVERY queue push below also bumps drainTick: the action sequencing queue dispatches
      // with 350ms gaps, so a read that isn't first in the batch lands AFTER `streaming` has
      // already flipped false — without the bump the drain effects would never re-run and the
      // turn would dead-end on the status indicator (the 2026-06-11 "Opening it now." bug).
      case 'readFile': {
        const id = action.id ? String(action.id) : ''
        if (!id) break
        // Files already drained this chain aren't re-fetched (a re-request would re-inject the
        // same content + trigger another regenerate — the triple-answer bug). But a re-request
        // means the model looped instead of answering, so flag a forced completion from cache.
        if (drainedReadIdsRef.current.has(id)) forceAnswerRef.current = true
        else readFileQueueRef.current.push(id)
        setDrainTick(t => t + 1)
        break
      }

      // Spectre asked to search the knowledge vault — queue it; the queue drains after this
      // stream (semantic search → inject results as a follow-up turn → regenerate).
      case 'searchVault': {
        const query = action.query ? String(action.query) : ''
        if (query) {
          const node_id = action.node_id ? String(action.node_id) : undefined
          // Same loop-guard as readFile/readNotebook: a re-emitted identical search means the
          // model looped instead of answering — force a completion from what it already has,
          // rather than re-running the same Qdrant query until the MAX_READS budget is spent.
          const key = `vault:${query.toLowerCase()}|${node_id ?? ''}`
          if (drainedReadIdsRef.current.has(key)) forceAnswerRef.current = true
          else vaultSearchQueueRef.current.push({ query, node_id, limit: Number.isFinite(action.limit) ? Number(action.limit) : undefined })
          setDrainTick(t => t + 1)
        }
        break
      }

      // ── Docu-scape actions (project Hand notebooks) ─────────────────────────────
      // Read a notebook's content / list the whole tree — queued, drained after the
      // stream like readFile (sharing the per-turn read budget).
      case 'readNotebook': {
        const id = action.id ? String(action.id) : ''
        // No id → inject the directory instead of silently dropping the read, so the
        // model can correct itself (or answer) rather than leaving the turn hanging.
        if (!id) { notebookReadQueueRef.current.push('*'); setDrainTick(t => t + 1); break }
        // Same duplicate guard as readFile — one read per item per chain; a re-request forces
        // a completion from cache rather than dead-ending.
        if (drainedReadIdsRef.current.has(id)) forceAnswerRef.current = true
        else notebookReadQueueRef.current.push(id)
        setDrainTick(t => t + 1)
        break
      }
      case 'listNotebooks': {
        notebookReadQueueRef.current.push('*')   // sentinel → inject the full tree
        setDrainTick(t => t + 1)
        break
      }
      // ── Document creation — the verified write pipeline ─────────────────────────
      // `createDocument` is the canonical "save content" action (always a content page);
      // `createNotebook` remains for folder containers + as a legacy alias. Hard rules:
      //   · content always wins — a "folder with content" is coerced to a Document, so
      //     markdown can never be silently dropped into an empty container;
      //   · the target node must have a Notebooks panel (project Hand), else fail loudly;
      //   · the write is awaited + retried once, the outcome is reported as a pill, and
      //     a failed save dumps the markdown into the chat — content is NEVER lost.
      case 'createDocument':
      case 'createNotebook': {
        const scope = chatScope()
        const title = (String(action.title ?? '').trim() || 'Untitled').slice(0, 120)
        const md = action.content != null ? String(action.content) : ''
        const type: 'folder' | 'notebook' =
          action.action === 'createNotebook' && action.type === 'folder' && !md.trim() ? 'folder' : 'notebook'
        const target = action.node_id ? String(action.node_id) : scope
        ;(async () => {
          const targetNode = nodesRef.current.find(n => n.id === target)
          const targetName = targetNode?.name ?? target
          const targetIsProjectHand = targetNode?.level === 'hand' && targetNode?.parent_id === 'projects'
          if (!targetIsProjectHand) {
            pushTransition(scope, `→ ⚠ Couldn't save "${title}" — ${targetNode ? `"${targetName}" has no Notebooks panel (documents live in projects)` : `unknown location "${target}"`}`)
            preserveLostContent(scope, title, md)
            return
          }
          let content = ''
          if (md.trim()) {
            try { content = JSON.stringify(markdownToTiptap(md)) }
            catch {
              // Converter choked on exotic markdown — save as plain paragraphs over failing.
              content = JSON.stringify({
                type: 'doc',
                content: md.split(/\n+/).filter(p => p.trim()).map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
              })
            }
          }
          // parent_id must be an existing folder in the target node; anything else → top level.
          const rawParent = action.parent_id ? String(action.parent_id) : ''
          const parentOk = !!rawParent && (notebooksByNodeRef.current[target] ?? []).some(n => n.id === rawParent && n.type === 'folder')
          const opts = { title, type, parent_id: parentOk ? rawParent : '', content, created_by: 'spectre' }
          let nb = await createNotebookRemote(target, opts)
          if (!nb) nb = await createNotebookRemote(target, opts)   // one retry — transient/network
          if (!nb) {
            pushTransition(scope, `→ ⚠ Save failed — "${title}" was not created in ${targetName}`)
            preserveLostContent(scope, title, md)
            return
          }
          pushTransition(scope, type === 'folder'
            ? `→ Created Notebook "${nb.title}" in ${targetName}`
            : `→ Saved "${nb.title}" to ${targetName} · Notebooks`)
          // Show the document immediately when the user is looking at that project's workspace.
          if (type === 'notebook' && chatScope() === target) {
            setOpenNotebookMode('view')
            setOpenNotebookId(nb.id)
          }
        })()
        break
      }
      // Append/replace an EXISTING document's content. If it's open in the editor, write
      // live; otherwise fetch→merge→PATCH the stored content. Verified end-to-end: a
      // missing/wrong id or a failed PATCH surfaces as a "→ ⚠" pill with the content
      // preserved in chat, instead of vanishing into a swallowed catch.
      case 'writeToNotebook': {
        const id = action.id ? String(action.id) : ''
        const scope = chatScope()
        const mode = action.mode === 'replace' ? 'replace' : 'append'
        const md = String(action.content ?? '')
        const fail = (why: string) => {
          pushTransition(scope, `→ ⚠ Write failed — ${why}`)
          preserveLostContent(scope, '', md)
        }
        if (!id) { fail('no document id given (use listNotebooks to find it)'); break }
        if (openEditorApiRef.current && openEditorApiRef.current.id === id) {
          openEditorApiRef.current.insertMarkdown(md, mode)   // live editor write (autosaves)
          pushTransition(scope, `→ ${mode === 'replace' ? 'Rewrote' : 'Added to'} the open document`)
          break
        }
        ;(async () => {
          let title = ''
          try {
            // Optimistic concurrency: read the row (with its updated_at), merge, then PATCH
            // guarded on that timestamp. If a racing autosave / Spectre write landed in
            // between, the server 409s — re-read + re-merge once (picking up the other write)
            // so neither side is silently clobbered, then fall back to preserving content.
            for (let attempt = 0; attempt < 2; attempt++) {
              const res = await fetch(`/api/notebooks/${id}`, { cache: 'no-store' })
              const data = res.ok ? await res.json() : null
              if (!data?.notebook || data.notebook.type !== 'notebook') {
                fail(`document ${id} not found — it may have been moved or deleted`)
                return
              }
              title = data.notebook.title
              const existing = data.notebook.content ? tiptapToMarkdown(JSON.parse(data.notebook.content)) : ''
              const nextMd = mode === 'append' ? `${existing}${existing ? '\n\n' : ''}${md}` : md
              const json = JSON.stringify(markdownToTiptap(nextMd))
              const patch = await fetch(`/api/notebooks/${id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: json, expectedUpdatedAt: data.notebook.updated_at }),
              })
              if (patch.ok) {
                const owner = itemIndexRef.current.notebooks[id] ?? scope
                await loadNotebooks(owner)
                pushTransition(scope, `→ ${mode === 'replace' ? 'Rewrote' : 'Added to'} "${title}"`)
                return
              }
              if (patch.status !== 409) { fail(`saving to "${title}" did not go through`); return }
              // 409: the document changed under us — loop to re-read + re-merge once.
            }
            fail(`"${title}" kept changing while saving`)
          } catch {
            fail('server unreachable')
          }
        })()
        break
      }

      case 'updateProgress': {
        const matchedId = fuzzyMatchProjectId(String(action.project ?? ''))
        if (matchedId) {
          syncProject(matchedId, { progress: Math.min(100, Math.max(0, Math.round(Number(action.value)))) })
        }
        break
      }

      case 'calendarSync': {
        const op = String(action.op ?? '')
        const event = action.event as Record<string, unknown> | undefined
        const eventId = action.eventId ? String(action.eventId) : undefined
        const body =
          op === 'delete' ? { op, eventId }
          : op === 'update' ? { op, eventId, event }
          : { op, event }
        // Write to Google Calendar, then re-pull so the UI reflects GCal truth.
        ;(async () => {
          try {
            const res = await fetch('/api/calendar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
            if (!res.ok) { console.warn('[GCal] calendarSync failed:', res.status); return }
          } catch (e) {
            console.warn('[GCal] calendarSync error:', e); return
          }
          refreshWeek()
          if (activeFolderRef.current === 'schedule') refreshMonth(viewMonthRef.current)
        })()
        break
      }

      case 'updateProject': {
        const matchedId = fuzzyMatchProjectId(String(action.project ?? ''))
        if (matchedId) {
          const field = String(action.field ?? '')
          const value = action.value
          if (field === 'progress') syncProject(matchedId, { progress: Math.min(100, Math.max(0, Math.round(Number(value)))) })
          else if (field === 'phase') syncProject(matchedId, { phase: String(value) })
          else if (field === 'description') syncProject(matchedId, { description: String(value) })
        }
        break
      }

      case 'updateNode': {
        const nodeId = String(action.id ?? '')
        if (nodeId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const patch: Record<string, any> = {}
          if (action.progress !== undefined) patch.progress = Math.min(100, Math.max(0, Math.round(Number(action.progress))))
          if (action.phase !== undefined) patch.phase = String(action.phase)
          if (action.description !== undefined) patch.description = String(action.description)
          if (action.name !== undefined) patch.name = String(action.name)
          setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, ...patch } : n))
          // Mirror into the legacy `projects` store for the 3 seeded project Hands so the
          // ProjectDetail panel + dashboard primer reflect the change without navigation.
          const legacyId = NODE_TO_LEGACY_ID[nodeId]
          if (legacyId) setProjects(prev => prev.map(p => p.id === legacyId ? { ...p, ...patch } : p))
          ;(async () => {
            try {
              await fetch(`/api/nodes/${nodeId}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
              })
            } catch { /* offline */ }
          })()
          // A name change alters the tree text Spectre reads (progress/phase don't appear).
          if (patch.name !== undefined) refreshDiagramTree()
        }
        break
      }

      // ── Gym arm actions ────────────────────────────────────────────────
      // All take an optional `date`; default to the day on screen. `updateTraining`
      // is the legacy alias and maps onto updateWorkout for the viewed day.
      case 'updateWorkout':
      case 'updateTraining': {
        const raw = action.action === 'updateTraining' ? action.training : action.workout
        if (raw && typeof raw === 'object') {
          const date = String(action.date ?? isoDate(viewDateRef.current))
          const w = normalizeWorkout(date, raw as Record<string, unknown>)
          mutateWorkouts(prev => ({ ...prev, [date]: w }), true)
        }
        break
      }

      case 'logSet': {
        const date = String(action.date ?? isoDate(viewDateRef.current))
        const exName = String(action.exercise ?? '').toLowerCase()
        const setIdx = Math.round(Number(action.set ?? 1)) - 1
        if (exName && setIdx >= 0) {
          mutateWorkouts(prev => {
            const w = prev[date]
            if (!w) return prev
            const blocks = w.blocks.map(b => {
              if (b.exercise.toLowerCase() !== exName) return b
              if (setIdx >= b.sets.length) return b
              const sets = b.sets.map((s, i) => i !== setIdx ? s : {
                ...s,
                actualWeight: action.weight != null ? String(action.weight) : s.actualWeight,
                actualReps: action.reps != null ? String(action.reps) : s.actualReps,
                done: true,
              })
              return { ...b, sets }
            })
            return { ...prev, [date]: { ...w, blocks } }
          }, true)
        }
        break
      }

      case 'reorderBlocks': {
        const date = String(action.date ?? isoDate(viewDateRef.current))
        const order: string[] = Array.isArray(action.order)
          ? action.order.map((x: unknown) => String(x).toLowerCase())
          : []
        if (order.length) {
          mutateWorkouts(prev => {
            const w = prev[date]
            if (!w) return prev
            const remaining = [...w.blocks]
            const reordered: WorkoutBlock[] = []
            for (const name of order) {
              const idx = remaining.findIndex(b => b.exercise.toLowerCase() === name)
              if (idx >= 0) reordered.push(remaining.splice(idx, 1)[0])
            }
            reordered.push(...remaining) // any not named keep their order at the end
            return { ...prev, [date]: { ...w, blocks: reordered } }
          }, true)
        }
        break
      }

      case 'setRest': {
        const date = String(action.date ?? isoDate(viewDateRef.current))
        const exName = String(action.exercise ?? '').toLowerCase()
        const restSeconds = parseRestSeconds(String(action.rest ?? ''))
        if (exName) {
          mutateWorkouts(prev => {
            const w = prev[date]
            if (!w) return prev
            const blocks = w.blocks.map(b =>
              b.exercise.toLowerCase() === exName ? { ...b, restSeconds } : b
            )
            return { ...prev, [date]: { ...w, blocks } }
          }, true)
        }
        break
      }

    }
  }, [refreshWeek, refreshMonth, mutateWorkouts, refreshDiagramTree])

  // `keepVoice` is set by Spectre-driven navigation (navigateToNode) so the voice session
  // survives a context switch — a manual card click (keepVoice omitted) still tears it down.
  const handleFolderClick = (folderId: string, keepVoice = false) => {
    if (voiceModeRef.current && !keepVoice) exitVoiceMode()
    clearChatAttachments()
    setActiveFolder(folderId)
    setActiveProject(null)
    setActiveHand(null)
    setEditingPrimer(false)
    setChatOpen(true)
    setChatView('sessions')          // land on the session list (intermediate layer)
    loadSessions(folderId)
    // The Projects arm has no session layer at its top level — it opens the landing
    // (full-width cards). Refresh each Hand's activity summary on open.
    if (folderId === 'projects') loadProjectSummaries()
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  const handleProjectClick = (projId: string) => {
    clearChatAttachments()
    setActiveProject(projId)
    setActiveHand(null)
    setChatView('sessions')
    setOpenNotebookId(null); setNotebookFocus(false); setNotebookFolder(''); setPreviewFileId(null)
    loadSessions(`project-${projId}`)
    loadFiles(`project-${projId}`)
    loadTags(`project-${projId}`)
    loadNotebooks(`project-${projId}`)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  // Navigate into a Hand (the intermediate session layer of a child node). Seeded
  // project Hands ('project-*') route through activeProject (their display buffer lives
  // in projectMessages); custom Hands open via activeHand. Both Project Hands render the
  // same workspace (chat + SOURCES + NOTEBOOKS) — see the Projects render branch.
  const handleHandClick = (hand: NodeMeta, keepVoice = false) => {
    if (voiceModeRef.current && !keepVoice) exitVoiceMode()
    clearChatAttachments()
    setEditingPrimer(false)
    // Always open the split view and activate the parent arm — safe to call even when
    // already in the right context (idempotent). This makes handleHandClick work from
    // the main dashboard widget where chatOpen and activeFolder are not yet set.
    setChatOpen(true)
    if (hand.id.startsWith('project-')) {
      setActiveFolder('projects')
      handleProjectClick(hand.id.replace('project-', ''))
      return
    }
    if (hand.parent_id) setActiveFolder(hand.parent_id)
    setActiveHand(hand.id)
    setChatView('sessions')
    setOpenNotebookId(null); setNotebookFocus(false); setNotebookFolder(''); setPreviewFileId(null)
    loadSessions(hand.id)
    if (hand.parent_id === 'projects') { loadFiles(hand.id); loadTags(hand.id); loadNotebooks(hand.id) }
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  // ── Spectre-driven navigation + action sequencing ────────────────────────────────
  // Open a usable chat at `scope` after navigation so the destination is never an empty
  // panel: 'recent' resumes the newest session (or starts fresh if none exist), 'new'
  // always starts fresh. `openDrawer` is for CORE (its chat lives in a slide-in drawer).
  const autoOpenSession = async (scope: string, opts: { mode?: 'recent' | 'new'; openDrawer?: boolean } = {}) => {
    const mode = opts.mode ?? 'recent'
    if (mode === 'new') {
      startNewSession(scope)
      if (opts.openDrawer) setMainDrawerOpen(true)
      return
    }
    try {
      const res = await fetch(`/api/chat/sessions?folder_id=${encodeURIComponent(scope)}`, { cache: 'no-store' })
      const data = await res.json()
      const list: SessionMeta[] = Array.isArray(data.sessions) ? data.sessions : []
      setSessions(prev => ({ ...prev, [scope]: list }))
      if (list.length) selectSession(scope, list[0].id)   // newest first (updated_at DESC)
      else startNewSession(scope)                          // lazy: no DB row until first msg
    } catch {
      startNewSession(scope)
    }
    if (opts.openDrawer) setMainDrawerOpen(true)
  }

  // navigateToNode replicates a card click (arms → handleFolderClick, hands →
  // handleHandClick, 'main' → CORE), but with keepVoice so a voice session survives and
  // an auto-opened session so the destination always lands on a real chat (Fix 1).
  const navigateToNode = (nodeId: string, opts: { keepVoice?: boolean; skipAutoOpen?: boolean } = {}) => {
    const keepVoice = !!opts.keepVoice
    const skipAutoOpen = !!opts.skipAutoOpen
    // Record where we came from for "go back" (deduped, newest last, last 5).
    const from = chatScope()
    if (from && from !== nodeId) navHistoryRef.current = [...navHistoryRef.current.filter(s => s !== from), from].slice(-5)
    // Voice continuity (Fix 2): a Spectre-driven nav while voice is live reflects the
    // still-running session as the destination's mini-orb active state (no new session).
    if (keepVoice && voiceModeRef.current && nodeId !== 'main') { setMiniVoice(true); miniVoiceRef.current = true }
    if (nodeId === 'main') {
      setActiveProject(null); setActiveHand(null); setActiveFolder('main'); setChatOpen(false)
      if (!skipAutoOpen) void autoOpenSession('main', { openDrawer: true })
      return
    }
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (!node) return
    if (node.level === 'arm') handleFolderClick(nodeId, keepVoice)
    else handleHandClick(node, keepVoice)
    // The Projects ARM shows its landing (cards), not a chat panel — don't force a session.
    if (!skipAutoOpen && nodeId !== 'projects') void autoOpenSession(nodeId)
  }

  // ── FIX 3: URL ↔ navigation sync ────────────────────────────────────────────────
  // The active Arm/Hand is mirrored to ?node=<id> (CORE = bare /) via the native History API —
  // Next's app router officially supports pushState/replaceState for shallow URL updates
  // (router.push would round-trip the RSC payload on every arm click). On load, ?node= is
  // restored once the node list arrives; back/forward (popstate) navigates through the same
  // navigateToNode path Spectre's voice nav uses. So a refresh stays on the current node,
  // deep links open straight into a project, and browser history traverses arms/hands.
  const navigateToNodeRef = useRef(navigateToNode)
  navigateToNodeRef.current = navigateToNode
  const urlSyncReadyRef = useRef(false)              // gate pushes until the deep link is handled
  const pendingDeepLinkRef = useRef<string | null>(null)
  useEffect(() => {
    pendingDeepLinkRef.current = new URLSearchParams(window.location.search).get('node')
    if (!pendingDeepLinkRef.current) urlSyncReadyRef.current = true
  }, [])
  // Restore the deep link once nodes are loaded (the id must resolve to a real Arm/Hand).
  useEffect(() => {
    const id = pendingDeepLinkRef.current
    if (!id || !nodes.length) return
    pendingDeepLinkRef.current = null
    if (nodes.some(n => n.id === id)) navigateToNodeRef.current(id)
    urlSyncReadyRef.current = true
  }, [nodes])
  // Mirror navigation state into the URL — one history entry per arm/hand visit. The equality
  // guard makes popstate-driven navigation loop-free (URL already matches the restored state).
  const currentUrlNodeId = activeHand ?? (activeProject ? `project-${activeProject}` : activeFolder)
  useEffect(() => {
    if (!urlSyncReadyRef.current) return
    const inUrl = new URLSearchParams(window.location.search).get('node') ?? 'main'
    if (inUrl === currentUrlNodeId) return
    const url = currentUrlNodeId === 'main'
      ? window.location.pathname
      : `${window.location.pathname}?node=${encodeURIComponent(currentUrlNodeId)}`
    window.history.pushState({ node: currentUrlNodeId }, '', url)
  }, [currentUrlNodeId])
  // Browser back/forward: navigate to whatever node the (now-current) URL points at.
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get('node') ?? 'main'
      navigateToNodeRef.current(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Look up a notebook / file's display meta by id across every loaded scope (for pills).
  const findNotebookMeta = (id: string): NotebookMeta | null => {
    for (const list of Object.values(notebooksByNodeRef.current)) {
      const n = list.find(x => x.id === id); if (n) return n
    }
    return null
  }
  const findFileMeta = (id: string): SourceFile | null => {
    for (const list of Object.values(sourceFilesRef.current)) {
      const f = list.find(x => x.id === id); if (f) return f
    }
    return null
  }

  // Append an ephemeral transition pill to a scope's display buffer (never persisted).
  // Inserted just before the trailing assistant bubble so it reads between the user's message
  // and Spectre's reply.
  const pushTransition = (scope: string, text: string) => {
    updateScopeDisplay(scope, m => {
      const pill: Message = { role: 'assistant', content: text, kind: 'transition' }
      const c = [...m]
      if (c.length && c[c.length - 1].role === 'assistant' && c[c.length - 1].kind !== 'transition') {
        c.splice(c.length - 1, 0, pill)
      } else {
        c.push(pill)
      }
      return c
    })
  }

  // Execute a single queued action. The UI-control actions (navigateTo, openNotebook,
  // openFile, openSession, searchSessions) are handled here (they need navigation + view
  // state); everything else falls through to applySpectreAction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatchQueuedAction = (action: Record<string, any>, scope: string) => {
    switch (action.action) {
      case 'navigateTo': {
        const id = String(action.node_id ?? '')
        if (!id) break
        const name = String(action.node_name ?? nodesRef.current.find(n => n.id === id)?.name ?? id)
        pushTransition(scope, `→ Navigating to ${name}`)
        if (voiceModeRef.current) enqueueSentence(`Opening ${name}.`)
        // _skipAutoOpen is set by enqueueActions when a session-opening action follows
        // this nav (it will open its own session — avoid the recent-then-clear flash).
        navigateToNode(id, { keepVoice: true, skipAutoOpen: !!action._skipAutoOpen })
        break
      }
      // Explicit session control. node_id defaults to the current scope (a preceding
      // navigateTo, injected or explicit, has already settled it).
      case 'openSession': {
        const node = action.node_id ? String(action.node_id) : chatScope()
        const mode = action.mode === 'new' ? 'new' : action.mode === 'specific' ? 'specific' : 'recent'
        if (mode === 'specific' && action.session_id) {
          selectSession(node, String(action.session_id))
          pushTransition(scope, '→ Opened conversation')
        } else if (mode === 'new') {
          startNewSession(node)
          pushTransition(scope, '→ Started a new conversation')
        } else {
          void autoOpenSession(node, { mode: 'recent' })
          pushTransition(scope, '→ Opened your most recent conversation')
        }
        break
      }
      // Find a conversation by title (then message content), open the best match. Falls
      // back to the most recent chat when nothing matches.
      case 'searchSessions': {
        const node = action.node_id ? String(action.node_id) : chatScope()
        const query = String(action.query ?? '').trim()
        const openResult = action.open_result !== false
        if (!query) break
        const nodeName = nodesRef.current.find(n => n.id === node)?.name ?? (node === 'main' ? 'Core' : node)
        void (async () => {
          try {
            const res = await fetch(`/api/chat/sessions/search?node_id=${encodeURIComponent(node)}&q=${encodeURIComponent(query)}`, { cache: 'no-store' })
            const data = await res.json()
            const results: SessionMeta[] = Array.isArray(data.sessions) ? data.sessions : []
            if (results.length) {
              if (openResult) selectSession(node, results[0].id)
              const extra = results.length > 1 ? ` (${results.length} found — most recent)` : ''
              pushTransition(scope, `→ Opened "${results[0].title}"${extra}`)
            } else {
              if (openResult) void autoOpenSession(node, { mode: 'recent' })
              pushTransition(scope, `→ No match for "${query}" in ${nodeName} — opened your most recent chat`)
            }
          } catch { /* offline — leave the panel as-is */ }
        })()
        break
      }
      case 'openNotebook': {
        const id = String(action.id ?? '')
        if (!id) break
        // Validate against what actually exists (loaded scopes + the /api/tree index) —
        // a guessed/hallucinated id used to open a broken editor with an "→ Opened
        // 'document'" pill, which read as success while delivering nothing.
        const meta = findNotebookMeta(id)
        if (!meta && !itemIndexRef.current.notebooks[id]) {
          pushTransition(scope, `→ ⚠ Couldn't find that document — pick one from the project's directory`)
          break
        }
        const mode = action.mode === 'edit' ? 'edit' : 'view'
        const title = meta?.title ?? 'document'
        setOpenNotebookMode(mode)
        setNotebookFocus(false)
        setOpenNotebookId(id)
        pushTransition(scope, `→ Opened "${title}"${mode === 'edit' ? ' for editing' : ''}`)
        // Prefetch the content into openNotebookContentRef so the NEXT turn's
        // [OPEN DOCUMENT] primer block works immediately — without this, it depended on
        // the editor mounting and reporting content, so a follow-up question right after
        // a Spectre-driven open ("and?") found nothing. The live editor overwrites this
        // with fresher (unsaved) state via onEditorContent as soon as it mounts.
        void (async () => {
          try {
            const res = await fetch(`/api/notebooks/${id}`, { cache: 'no-store' })
            const data = res.ok ? await res.json() : null
            if (data?.notebook?.type === 'notebook' && openNotebookIdRef.current === id && openNotebookContentRef.current?.id !== id) {
              const md = data.notebook.content ? tiptapToMarkdown(JSON.parse(data.notebook.content)) : ''
              openNotebookContentRef.current = { id, title: data.notebook.title ?? title, markdown: md }
            }
          } catch { /* offline — the editor's onEditorContent still fills it on mount */ }
        })()
        break
      }
      case 'openFile': {
        const id = String(action.id ?? '')
        if (!id) break
        const fileMeta = findFileMeta(id)
        if (!fileMeta && !itemIndexRef.current.files[id]) {
          pushTransition(scope, `→ ⚠ Couldn't find that file — pick one from the project's Sources`)
          break
        }
        setPreviewFileId(id)
        pushTransition(scope, `→ Showing ${fileMeta?.filename ?? 'file'}`)
        break
      }
      // Voice/chat-triggered deep research — Spectre detected explicit research intent. NEVER fires
      // automatically: always routes through the confirmation gate (FIX 5) so a conversational
      // deepResearch action can't burn credits without an explicit "Start Research" click.
      case 'deepResearch': {
        const q = String(action.query ?? '').trim()
        if (!q) break
        // Spectre may attach a context-aware plan. When valid → pre-flight plan review; otherwise the
        // simple confirm modal (the cold orchestrator plans server-side).
        const plan = parseSpectrePlan(action.plan)
        pushTransition(scope, plan ? `→ Research plan ready — review to launch` : `→ Deep research ready — confirm to start`)
        requestResearch(q, scope, plan)
        break
      }
      default:
        applySpectreAction(action)
    }
  }

  // Drains the action queue one item at a time, with a settle delay between steps so
  // React re-renders (navigation, view state) before the next action fires.
  const ACTION_GAP_MS = 350
  const runActionQueueStep = () => {
    if (actionQueueBusyRef.current) return
    const item = actionQueueRef.current.shift()
    if (!item) return
    actionQueueBusyRef.current = true
    // A synchronous throw in dispatch must NOT leave the busy flag stuck — that would wedge
    // the entire queue (every later action silently no-ops for the rest of the session).
    // Always release the flag and advance, even on error.
    try {
      dispatchQueuedAction(item.action, item.scope)
    } catch (e) {
      console.error('[actionQueue] dispatch failed:', e)
    } finally {
      setTimeout(() => {
        actionQueueBusyRef.current = false
        runActionQueueStep()
      }, ACTION_GAP_MS)
    }
  }

  // Entry point from the streaming paths: expand implicit navigation (open an item that
  // lives elsewhere → prepend a navigateTo so it always resolves), then enqueue + drain.
  // `cursor` tracks the active node as nav actions are added, so implicit-navigate
  // compares against where we'll actually be when each action fires.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enqueueActions = (actions: Record<string, any>[], scope: string) => {
    if (!actions.length) return
    // A session-opening action manages its own chat session at its target node, so a
    // navigateTo right before it must NOT auto-open the recent session (would flash).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opensOwnSession = (a: Record<string, any>) =>
      a.action === 'openSession' || (a.action === 'searchSessions' && a.open_result !== false)
    let cursor = chatScope()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expanded: { action: Record<string, any>; scope: string }[] = []
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]
      if (a.action === 'navigateTo') {
        const target = String(a.node_id ?? '')
        const skip = !!actions[i + 1] && opensOwnSession(actions[i + 1])
        expanded.push({ action: { ...a, _skipAutoOpen: skip }, scope })
        if (target) cursor = target
        continue
      }
      // Resolve the node this action targets (item owner, or explicit node_id).
      let target: string | undefined
      if (a.action === 'openNotebook') target = itemIndexRef.current.notebooks[String(a.id ?? '')]
      else if (a.action === 'openFile') target = itemIndexRef.current.files[String(a.id ?? '')]
      else if (a.action === 'openSession' || a.action === 'searchSessions') target = a.node_id ? String(a.node_id) : undefined
      if (target && target !== cursor) {
        const ownerName = nodesRef.current.find(n => n.id === target)?.name ?? target
        // Session openers open their own session at the target; item openers want the
        // recent chat AND the item, so their injected nav keeps auto-open on.
        expanded.push({ action: { action: 'navigateTo', node_id: target, node_name: ownerName, _skipAutoOpen: opensOwnSession(a) }, scope })
        cursor = target
      }
      expanded.push({ action: a, scope })
    }
    actionQueueRef.current.push(...expanded)
    runActionQueueStep()
  }
  enqueueActionsRef.current = enqueueActions

  // Display label for an Arm scope (known arms keep their tracked caps; custom arms
  // use their node name).
  const armLabel = (id: string) => FOLDER_LABELS[id as FolderId] ?? (nodeById(id)?.name.toUpperCase() ?? '')

  // ── Voice mode lifecycle ──────────────────────────────────────────────────

  const acquireMic = async () => {
    if (micStreamRef.current) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    // getUserMedia can resolve AFTER exitVoiceMode tore the mic down (the S4 "doesn't stop" race):
    // an in-flight reopenMicAndListen would otherwise re-arm a LIVE mic post-exit. If voice mode is
    // no longer active, stop the freshly-granted tracks and bail instead of leaving a hot mic.
    if (!voiceModeRef.current) { stream.getTracks().forEach(t => t.stop()); return }
    micStreamRef.current = stream
    // Reuse the context unlockAudio created in the gesture; create one only if missing.
    if (!audioCtxRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      audioCtxRef.current = new Ctx()
    }
    const ctx = audioCtxRef.current!
    ctx.resume?.().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    analyserRef.current = analyser
    isMicOpenRef.current = true
    if (rafRef.current == null) vadTick()
  }

  const teardownMic = () => {
    isMicOpenRef.current = false
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      cancelNextRef.current = true
      try { recorderRef.current.stop() } catch { /* ignore */ }
    }
    recorderRef.current = null
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    analyserRef.current = null
  }

  const rmsLevel = (): number => {
    const a = analyserRef.current
    if (!a) return 0
    const buf = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  // Single rAF loop — behaviour depends on the current voice phase.
  const vadTick = () => {
    rafRef.current = requestAnimationFrame(vadTick)
    const phase = voicePhaseRef.current
    if (phase !== 'listening' && phase !== 'speaking') return
    const level = rmsLevel()
    const now = performance.now()

    if (phase === 'listening') {
      if (level > SPEECH_THRESHOLD) {
        speechStartedRef.current = true
        silenceStartRef.current = null
      } else if (level < SILENCE_THRESHOLD && speechStartedRef.current) {
        if (silenceStartRef.current == null) silenceStartRef.current = now
        else if (now - silenceStartRef.current > SILENCE_MS) finishRecording()
      }
      // Only the "never spoke" timeout abandons the turn. There is deliberately no
      // upper bound on how long the user may talk once they've started — the turn
      // ends on sustained silence, never on a length cap.
      if (!speechStartedRef.current && now - recordStartRef.current > NO_SPEECH_MS) {
        cancelRecording(); setVoicePhase('idle')
      }
    } else if (phase === 'speaking') {
      // Barge-in is DISABLED (voice is turn-based; the mic is physically closed in SPEAKING
      // so this branch normally never even runs). Gated off behind the single flag — flip
      // BARGE_IN_ENABLED to true to restore the analyser-driven interruption capture.
      if (!BARGE_IN_ENABLED) return
      // Language-gated barge-in. While a capture is being transcribed, do nothing.
      if (bargeProbingRef.current) return
      if (level > BARGE_SPEECH_THRESHOLD) {
        if (!bargeSpeechStartedRef.current) {
          // Speech-like energy just started — begin capturing it for transcription.
          bargeSpeechStartedRef.current = true
          bargeSpeechStartTimeRef.current = now
          startBargeRecorder()
        }
        bargeSilenceStartRef.current = null
        // Cap a runaway capture so we transcribe even if the user never pauses.
        if (now - bargeSpeechStartTimeRef.current > BARGE_MAX_PROBE_MS) evaluateBargeIn()
      } else if (bargeSpeechStartedRef.current) {
        // Brief pause after the interruption → finalize and transcribe the capture.
        if (bargeSilenceStartRef.current == null) bargeSilenceStartRef.current = now
        else if (now - bargeSilenceStartRef.current > BARGE_END_SILENCE_MS) evaluateBargeIn()
      }
    }
  }

  // ── Language-gated barge-in helpers ───────────────────────────────────────
  // Capture a possible interruption with a dedicated recorder (separate from the
  // listening recorder, which is idle while Spectre speaks). The capture is started
  // at speech onset so it holds mostly the user's words, not the whole reply.
  const startBargeRecorder = () => {
    const stream = micStreamRef.current
    if (!stream || !voiceModeRef.current) return
    if (bargeRecorderRef.current && bargeRecorderRef.current.state !== 'inactive') return
    bargeChunksRef.current = []
    const mime = pickMime()
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    bargeRecorderRef.current = rec
    rec.ondataavailable = e => { if (e.data.size) bargeChunksRef.current.push(e.data) }
    rec.onstop = () => { handleBargeProbe() }
    rec.start(250)
  }

  // Stop & discard any in-flight barge capture without transcribing (used when the
  // speaking phase ends normally or voice mode tears down).
  const stopBargeRecorder = () => {
    bargeProbingRef.current = false
    bargeSpeechStartedRef.current = false
    bargeSilenceStartRef.current = null
    const rec = bargeRecorderRef.current
    bargeRecorderRef.current = null
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null               // discard — do not transcribe
      try { rec.stop() } catch { /* ignore */ }
    }
    bargeChunksRef.current = []
  }

  // Finalize the current capture and hand it to the transcriber for the language gate.
  const evaluateBargeIn = () => {
    if (bargeProbingRef.current) return
    const dur = performance.now() - bargeSpeechStartTimeRef.current
    bargeSpeechStartedRef.current = false
    bargeSilenceStartRef.current = null
    const rec = bargeRecorderRef.current
    if (!rec || rec.state === 'inactive') return
    if (dur < BARGE_MIN_MS) { stopBargeRecorder(); return }  // too brief — ignore, keep speaking
    bargeProbingRef.current = true
    try { rec.stop() } catch { bargeProbingRef.current = false }  // onstop → handleBargeProbe
  }

  // Transcribe the capture; cut Spectre off and treat it as the user's turn ONLY if
  // it's decipherable speech. Otherwise it was noise — Spectre keeps talking.
  const handleBargeProbe = async () => {
    const chunks = bargeChunksRef.current
    bargeChunksRef.current = []
    bargeRecorderRef.current = null
    const stillSpeaking = voiceModeRef.current && voicePhaseRef.current === 'speaking'
    if (!stillSpeaking || chunks.length === 0) { bargeProbingRef.current = false; return }
    const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' })
    try {
      const form = new FormData()
      form.append('file', blob, 'audio.webm')
      const res = await fetch('/api/stt', { method: 'POST', body: form })
      bargeProbingRef.current = false
      if (!res.ok) return
      const { text } = await res.json()
      const transcript = String(text ?? '').trim()
      if (isDecipherableSpeech(transcript) && !isHallucinatedTranscript(transcript) && voiceModeRef.current && voicePhaseRef.current === 'speaking') {
        // Real interruption — stop playback and process what the user said as the turn.
        stopSpeaking()
        sendVoiceTurn(transcript)
      }
      // Otherwise: noise/unintelligible — do nothing, Spectre keeps speaking. The next
      // speech onset (vadTick) starts a fresh capture.
    } catch {
      bargeProbingRef.current = false
    }
  }

  const startListening = () => {
    const stream = micStreamRef.current
    if (!voiceModeRef.current || !stream) return
    // Never reopen passive listening while TTS is playing / in its cooldown. The reopen path
    // (reopenMicAndListen) clears this flag first; this only blocks stray callers (error
    // retry timeout, etc.) from sneaking the mic open mid-SPEAKING.
    if (ttsHardMuteRef.current) return
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return
    isMicOpenRef.current = true
    stopBargeRecorder()            // leaving the speaking phase — drop any barge capture
    speechStartedRef.current = false
    silenceStartRef.current = null
    cancelNextRef.current = false
    recordedChunksRef.current = []
    recordStartRef.current = performance.now()
    const mime = pickMime()
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorderRef.current = rec
    rec.ondataavailable = e => { if (e.data.size) recordedChunksRef.current.push(e.data) }
    rec.onstop = () => { handleRecordingStop() }
    // Timeslice 250ms so the webm blob assembles AS the user speaks — the encoded audio is ready
    // to upload the instant the turn ends, instead of being assembled in one shot afterward.
    rec.start(250)
    setVoicePhase('listening')
  }

  const finishRecording = () => {
    cancelNextRef.current = false
    // Latency probe: t0 = end of the user's speech. The [VOICE LATENCY] line logged in
    // onSpeakingComplete reports STT→first-token→first-audio deltas off this mark.
    voiceTimingRef.current = { t0: performance.now(), firstToken: 0, firstAudio: 0 }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch { /* ignore */ }
    }
  }

  const cancelRecording = () => {
    cancelNextRef.current = true
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch { /* ignore */ }
    } else {
      recorderRef.current = null
    }
  }

  const handleRecordingStop = async () => {
    const chunks = recordedChunksRef.current
    recordedChunksRef.current = []
    recorderRef.current = null
    const discard = cancelNextRef.current || !speechStartedRef.current || chunks.length === 0
    cancelNextRef.current = false
    if (discard) return

    const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' })
    setVoicePhase('transcribing')
    try {
      const form = new FormData()
      form.append('file', blob, 'audio.webm')
      const res = await fetch('/api/stt', { method: 'POST', body: form })
      if (!res.ok) { setVoicePhase('idle'); return }
      const { text } = await res.json()
      const transcript = String(text ?? '').trim()
      if (!transcript) {
        // Nothing recognised — reopen the mic for another try (still hands-free).
        if (voiceModeRef.current) startListening(); else setVoicePhase('idle')
        return
      }
      // FIX 1 (secondary defense) — discard short Whisper hallucinations ("okay", "thank
      // you", …) that slip past the hard mute, so they never fire a turn or reach Mem0.
      if (isHallucinatedTranscript(transcript)) {
        console.warn('[Voice] discarded hallucinated transcript:', JSON.stringify(transcript))
        if (voiceModeRef.current) startListening(); else setVoicePhase('idle')
        return
      }
      sendVoiceTurn(transcript)
    } catch {
      setVoicePhase('idle')
    }
  }

  const sendVoiceTurn = (transcript: string) => {
    setVoicePhase('thinking')
    sendMessage(transcript, { voice: true })
  }

  // `mini` launches the picture-in-picture variant (corner orb in a folder/project
  // panel) instead of the full dashboard takeover. Both share this exact pipeline;
  // the greeting and every later turn pick up the active folder/project primer
  // automatically (sendMessage reads activeFolderRef/activeProjectRef), so Spectre
  // always knows which arm it's operating in.
  const enterVoiceMode = async (mini = false) => {
    // Re-entrancy guard: callers gate on the `voiceMode` STATE, which lags the ref by a render, so
    // a same-tick double-fire (double-tap / a bubbled click) could otherwise enter — and greet —
    // twice. The ref is set synchronously below, so the second call bails here.
    if (voiceModeRef.current) return
    setMiniVoice(mini)
    miniVoiceRef.current = mini
    setVoiceMode(true)
    voiceModeRef.current = true
    unlockAudio()               // must run inside the click gesture (mobile Safari autoplay)
    // S5 — context-aware greeting. Decide BEFORE acquiring the mic whether this scope already has
    // an ongoing conversation: a FRESH scope gets the cold "Online." check-in; switching to
    // voice MID-CHAT must NOT blurt the cold greeting — Spectre already has the full history in
    // context, so it knows it's continuing. (Reads the same refs sendMessage reads.)
    const scope = activeHandRef.current ?? (activeProjectRef.current ? `project-${activeProjectRef.current}` : activeFolderRef.current)
    const buf = (!activeHandRef.current && activeProjectRef.current)
      ? (projectMessagesRef.current[`project-${activeProjectRef.current}`] || [])
      : (allMessagesRef.current[scope] || [])
    const hasHistory = buf.some(m => !m.kind && String(m.content || '').trim())
      || sessionMsgMetaRef.current.some(m => !m.is_compressed && (m.role === 'user' || m.role === 'assistant'))
    setVoicePhase('thinking')   // tentative — overwritten below once the mic is up
    try {
      await acquireMic()
    } catch {
      alert('Microphone access is required for voice mode.')
      exitVoiceMode()
      return
    }
    if (!voiceModeRef.current) return  // user bailed during the permission prompt
    // Skip the cold greeting when continuing an existing chat — OR when a typed reply is still
    // streaming (sending the greeting would early-return on the streaming guard and strand us in
    // THINKING: the S3 "doesn't start" failure). Either way, just open the mic and listen; the
    // next spoken turn carries the full history. A fresh, idle scope gets the spoken check-in,
    // and when its audio ends onSpeakingComplete auto-opens the mic — hands-free from the click.
    if (hasHistory || streamingRef.current) {
      setVoicePhase('idle')
      isMicOpenRef.current = true
      startListening()
    } else {
      setVoicePhase('thinking')
      sendMessage(VOICE_GREETING_PROMPT, { voice: true, hiddenUser: true, skipMemory: true })
    }
  }

  const exitVoiceMode = () => {
    stopSpeaking()
    cancelRecording()
    stopBargeRecorder()
    teardownMic()
    setVoiceMode(false)
    voiceModeRef.current = false
    setMiniVoice(false)
    miniVoiceRef.current = false
    setVoicePhase('idle')
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  const handleOrbClick = () => {
    if (!voiceMode) enterVoiceMode(false)
    else exitVoiceMode()
  }

  // Mini orb in a folder/project panel header. Toggles the PiP voice session.
  // stopPropagation so the click never bubbles to a parent panel/navigation handler
  // (the same event-propagation fix the main orb's controls use).
  const handleMiniOrbClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (voiceMode) { exitVoiceMode(); return }
    // Starting voice from the session list begins a fresh conversation in this scope.
    if (chatView === 'sessions') {
      const scope = activeHandRef.current ?? (activeProjectRef.current ? `project-${activeProjectRef.current}` : activeFolderRef.current)
      startNewSession(scope)
    }
    enterVoiceMode(true)
  }

  // Escape ends any active voice session (full or mini).
  useEffect(() => {
    if (!voiceMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitVoiceMode() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode])

  // A mini (PiP) session lives inside a folder/project panel — if the user navigates
  // back to the dashboard, end it so it can't leak into the full-takeover UI.
  useEffect(() => {
    if (miniVoiceRef.current && (!chatOpen || activeFolder === 'main')) exitVoiceMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, activeFolder])

  // Mic button inside voice mode — manual control of the turn-based loop. During SPEAKING
  // it is the ONLY way to interrupt Spectre: bump the turn sequence (so the in-flight
  // stream's remaining TTS enqueues / tail flush become no-ops — "clear streamBuffer"),
  // stop the audio + clear the playback queue + abort in-flight TTS fetches (stopSpeaking),
  // then reopen the mic (tracks were stopped) and return to LISTENING.
  const handleMicTap = () => {
    const p = voicePhaseRef.current
    // IDLE: open the mic and listen. If the mic is currently closed (post-speaking cooldown,
    // or a failed reopen), re-acquire it first so a tap is never a dead no-op.
    if (p === 'idle') { if (micStreamRef.current) startListening(); else reopenMicAndListen() }
    else if (p === 'listening') finishRecording()
    else if (p === 'speaking') {
      voiceTurnSeqRef.current++
      stopSpeaking()
      reopenMicAndListen()
    }
    else if (p === 'thinking') {
      // S2 — interrupt while Spectre is GENERATING (nothing is playing yet, so zero echo risk).
      // Bump turnSeq (invalidates this turn's actions/persist/TTS enqueues), flag + abort the
      // in-flight /api/spectre stream so generation actually stops (the body is now abortable via
      // spectreStreamAbortRef), then reopen the mic for a fresh turn. The aborted fetch's catch
      // sees the interrupt flag / stale turnSeq and unwinds silently.
      voiceTurnSeqRef.current++
      spectreInterruptRef.current = true
      try { spectreStreamAbortRef.current?.abort() } catch { /* ignore */ }
      stopSpeaking()
      reopenMicAndListen()
    }
    // transcribing: STT in flight (sub-second) — busy, ignore.
  }

  // One-shot recorder for the text input bar mic (fills the textarea, no loop).
  const recordOneShot = async () => {
    if (isListening) { oneShotRecRef.current?.stop(); return }
    if (isTranscribing) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      oneShotStreamRef.current = stream
      oneShotChunksRef.current = []
      const mime = pickMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      oneShotRecRef.current = rec
      rec.ondataavailable = e => { if (e.data.size) oneShotChunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        oneShotStreamRef.current = null
        setIsListening(false)
        const chunks = oneShotChunksRef.current
        if (!chunks.length) return
        const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' })
        setIsTranscribing(true)
        try {
          const form = new FormData()
          form.append('file', blob, 'audio.webm')
          const res = await fetch('/api/stt', { method: 'POST', body: form })
          if (res.ok) {
            const { text } = await res.json()
            const t = String(text ?? '').trim()
            if (t) setInput(prev => (prev ? prev + ' ' : '') + t)
          }
        } catch { /* ignore */ }
        finally { setIsTranscribing(false) }
      }
      rec.start()
      setIsListening(true)
    } catch {
      alert('Microphone access denied.')
    }
  }

  if (!mounted) return null

  const panelStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: PANEL,
    border: `0.5px solid ${cfg.border}`,
    borderRadius: '12px',
    backdropFilter: 'blur(12px)',
    ...extra,
  })

  // Generic segmented toggle used inside the settings dropdown. Matches the dark /
  // electric-blue aesthetic; `disabled` greys it out (e.g. Think Mode in LOCAL mode).
  const segmented = (
    opts: { value: string; label: string }[],
    current: string,
    onPick: (v: string) => void,
    disabled = false,
  ) => (
    <div style={{
      display: 'flex',
      borderRadius: '6px',
      border: `0.5px solid ${cfg.border}`,
      overflow: 'hidden',
      opacity: disabled ? 0.4 : 1,
    }}>
      {opts.map((o, i) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onPick(o.value)}
          style={{
            flex: 1,
            padding: '5px 12px',
            fontSize: '10px',
            letterSpacing: '0.1em',
            fontWeight: 700,
            border: 'none',
            borderRight: i < opts.length - 1 ? `0.5px solid ${cfg.border}` : 'none',
            background: current === o.value ? cfg.dim : 'transparent',
            color: current === o.value ? accentHex : 'rgba(255,255,255,0.3)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  // One labelled row in the settings dropdown.
  const settingsRow = (label: string, control: React.ReactNode, note?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>{label}</span>
      {control}
      {note && <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.02em' }}>{note}</span>}
    </div>
  )

  // Shared input bar. All controls (AI model, voice provider, think mode) live in a
  // settings dropdown opened by the gear button — the bar itself stays unobstructed.

  // Submit handler shared by the SEND button, Enter key, and form submit. When a research mode is
  // armed, the input fires /api/research instead of normal Spectre chat, then disarms.
  const submitInput = () => {
    if (researchArmedRef.current) {
      const t = input.trim()
      if (!t) return
      setInput('')
      setResearchArmed(false)
      requestResearch(t) // → confirmation gate, not a direct fire
      return
    }
    sendMessage(input)
  }

  const chatInputBar = (
    <div
      ref={settingsRef}
      onDragOver={e => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setChatDragActive(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setChatDragActive(false) }}
      onDrop={e => { e.preventDefault(); setChatDragActive(false); const fs = Array.from(e.dataTransfer.files || []); if (fs.length) handleChatFiles(fs) }}
      style={{
        position: 'relative', flexShrink: 0, borderRadius: '12px',
        outline: chatDragActive ? '2px solid #0EA5E9' : '2px solid transparent',
        outlineOffset: '2px',
        background: chatDragActive ? 'rgba(14,165,233,0.04)' : 'transparent',
        transition: 'outline-color 0.15s, background 0.15s',
      }}
    >
      {/* Hidden file picker — opened by the paperclip button. */}
      <input
        ref={chatFileInputRef}
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.docx,image/*"
        style={{ display: 'none' }}
        onChange={e => { const fs = Array.from(e.target.files || []); if (fs.length) handleChatFiles(fs); e.target.value = '' }}
      />
      {/* Attachment preview row — staged files/images above the input. */}
      {chatAttachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          {chatAttachments.map(a => (
            <AttachmentChip key={a.localId} att={a} cfg={cfg} onRemove={() => removeChatAttachment(a.localId)} />
          ))}
        </div>
      )}
      {settingsOpen && (
        <div
          className="animate-fadeIn"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 40,
            minWidth: '236px',
            display: 'flex',
            flexDirection: 'column',
            gap: '13px',
            boxShadow: '0 10px 34px rgba(0,0,0,0.55)',
            ...panelStyle({ padding: '14px 16px' }),
          }}
        >
          <span style={{ fontSize: '9px', letterSpacing: '0.2em', color: accentHex, fontWeight: 700 }}>SETTINGS</span>
          {settingsRow('MODEL', segmented(
            [{ value: 'claude-haiku-4-5-20251001', label: 'HAIKU' }, { value: 'claude-sonnet-4-6', label: 'SONNET' }, { value: 'claude-opus-4-6', label: 'OPUS' }, { value: 'local-gpt-oss', label: 'LOCAL' }],
            selectedModel, v => setSelectedModel(v as ModelId),
          ), selectedModel === 'claude-opus-4-6'
            ? 'Opus — most capable, deep work'
            : selectedModel === 'claude-haiku-4-5-20251001'
              ? 'Haiku — fastest, cheapest, casual chat'
              : selectedModel === 'local-gpt-oss'
                ? 'GPT-OSS 20B — local, private, zero cost'
                : 'Sonnet — balanced, daily driver')}
          {settingsRow('VOICE', segmented(
            [{ value: 'local', label: 'LOCAL' }, { value: 'cloud', label: 'CLOUD' }],
            ttsMode, v => setTtsMode(v as TtsMode),
          ), ttsMode === 'local' ? 'Chatterbox (local, cloned voice)' : 'Cartesia (cloud)')}
          {/* Streaming TTS (Cartesia SSE → Web Audio) — first audio ~265ms vs ~975ms buffered.
              Opt-in: only meaningful on CLOUD/Cartesia; verify it sounds smooth before relying on it. */}
          {ttsMode === 'cloud' && settingsRow('STREAM TTS', segmented(
            [{ value: 'off', label: 'OFF' }, { value: 'on', label: 'ON' }],
            ttsStreaming ? 'on' : 'off', v => setTtsStreaming(v === 'on'),
          ), ttsStreaming ? 'Streaming — first audio ~3× faster (beta)' : 'Buffered — full sentence before playback')}
          {/* NOTIFICATIONS (Web Push) — enable on this device, then a test push. On iPhone the
              app must be installed to the home screen first (iOS requirement). */}
          {settingsRow('NOTIFICATIONS',
            notifPerm === 'unsupported'
              ? <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>Not supported here</span>
              : (
                <div style={{ display: 'flex', gap: '6px' }}>
                  {notifPerm === 'granted' ? (
                    <button onClick={handleTestNotif} disabled={notifBusy}
                      style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', color: accentHex, background: `${accentHex}18`, border: `0.5px solid ${accentHex}55`, borderRadius: '7px', padding: '5px 12px', cursor: notifBusy ? 'default' : 'pointer' }}>{notifBusy ? '…' : 'SEND TEST'}</button>
                  ) : (
                    <button onClick={handleEnableNotifs} disabled={notifBusy || notifPerm === 'denied'}
                      style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', color: notifPerm === 'denied' ? 'rgba(255,255,255,0.3)' : accentHex, background: notifPerm === 'denied' ? 'transparent' : `${accentHex}18`, border: `0.5px solid ${notifPerm === 'denied' ? cfg.border : `${accentHex}55`}`, borderRadius: '7px', padding: '5px 12px', cursor: (notifBusy || notifPerm === 'denied') ? 'default' : 'pointer' }}>{notifBusy ? '…' : 'ENABLE'}</button>
                  )}
                </div>
              ),
            notifMsg ?? (notifPerm === 'granted' ? 'On — Spectre can reach this device' : notifPerm === 'denied' ? 'Blocked in browser settings' : 'Push reminders to your phone'))}
          {/* REASONING bar — gpt-oss reasoning_effort (LOCAL) and, at HIGH, Claude extended thinking.
              LOW is the default so everyday chats stay fast; raise it for harder problems. */}
          {settingsRow('REASONING', segmented(
            [{ value: 'low', label: 'LOW' }, { value: 'medium', label: 'MED' }, { value: 'high', label: 'HIGH' }],
            effortMode, v => setEffortMode(v as 'low' | 'medium' | 'high'),
          ), effortMode === 'low' ? 'Fast — minimal reasoning (default)' : effortMode === 'medium' ? 'Balanced reasoning' : 'Deep reasoning before replying')}
        </div>
      )}
      {/* Research-armed indicator — shown once the beaker arms research with an empty input. The next
          submitted line becomes the research topic (→ confirmation gate). One self-scaling mode now. */}
      {researchArmed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <span style={{
            fontSize: '9px', letterSpacing: '0.14em', fontWeight: 700, color: accentHex,
            padding: '3px 9px', borderRadius: '5px', border: `0.5px solid ${accentHex}`, background: cfg.dim,
          }}>
            DEEP RESEARCH · {researchModelLabel(selectedModel, true)}
          </span>
          <button
            type="button"
            onClick={() => setResearchArmed(false)}
            style={{ fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.4)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            ✕ EXIT
          </button>
        </div>
      )}
      {/* "+" add menu — attach / deep research / (main) conversations. */}
      {plusOpen && (
        <div className="animate-fadeIn" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 40, minWidth: '210px', display: 'flex', flexDirection: 'column', gap: '2px', boxShadow: '0 10px 34px rgba(0,0,0,0.55)', ...panelStyle({ padding: '7px' }) }}>
          {[
            { icon: '📎', label: 'Attach file', on: () => chatFileInputRef.current?.click() },
            { icon: '🔬', label: researchArmed ? 'Disarm research' : 'Deep research', on: () => { if (researchArmed) { setResearchArmed(false); return } const t = input.trim(); if (t) { setInput(''); requestResearch(t) } else setResearchArmed(true) } },
            ...(activeProject === null && activeFolder === 'main' ? [{ icon: '💬', label: 'Conversations', on: () => { loadSessions('main'); setMainDrawerOpen(o => !o) } }] : []),
          ].map(item => (
            <button key={item.label} type="button" onClick={() => { item.on(); setPlusOpen(false) }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 11px', borderRadius: '7px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.82)', fontSize: '12px', letterSpacing: '0.02em', fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
              <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>{item.icon}</span>{item.label}
            </button>
          ))}
        </div>
      )}
    <form
      onSubmit={e => { e.preventDefault(); submitInput() }}
      style={{ display: 'flex', flexDirection: 'column', gap: '9px', ...panelStyle({ padding: '11px 12px 9px' }) }}
    >
      {/* Full-width text field (Claude-app style) — secondary actions live in the + menu / model pill below. */}
      <textarea
        ref={inputRef}
        value={input}
        rows={1}
        onChange={e => setInput(e.target.value)}
        onPaste={e => {
          const items = e.clipboardData?.items
          if (!items) return
          const imgs: File[] = []
          for (const it of Array.from(items)) {
            if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) imgs.push(f) }
          }
          if (imgs.length) { e.preventDefault(); handleChatFiles(imgs) }
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submitInput()
          }
          if (e.key === 'Escape' && researchArmed) setResearchArmed(false)
        }}
        placeholder={researchArmed ? 'What should Spectre research?' : streaming ? 'Spectre is responding…' : 'Message Spectre…'}
        disabled={streaming}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: '#fff',
          fontSize: '15px',
          letterSpacing: '0.01em',
          fontFamily: 'inherit',
          resize: 'none',
          overflowY: 'auto',
          lineHeight: '1.5',
          padding: '2px 2px 0',
          minHeight: '24px',
          maxHeight: '160px',
        }}
      />
      {/* Bottom controls — + menu, model pill, voice dictation, send. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <button type="button" onClick={() => { setPlusOpen(o => !o); setSettingsOpen(false) }} title="Add" aria-label="Add"
          style={{ width: '34px', height: '34px', borderRadius: '9px', border: `0.5px solid ${plusOpen ? accentHex : cfg.border}`, background: plusOpen ? cfg.dim : 'transparent', color: plusOpen ? accentHex : 'rgba(255,255,255,0.5)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '21px', lineHeight: 1, transition: 'all 0.2s', fontFamily: 'inherit' }}>+</button>
        {(() => {
          const m = selectedModel === 'claude-haiku-4-5-20251001' ? { label: 'HAIKU', c: '#1D9E75' }
            : selectedModel === 'claude-opus-4-6' ? { label: 'OPUS', c: '#7F77DD' }
            : selectedModel === 'local-gpt-oss' ? { label: 'LOCAL', c: '#378ADD' }
            : { label: 'SONNET', c: '#EF9F27' }
          return (
            <button type="button" onClick={() => { setSettingsOpen(o => !o); setPlusOpen(false) }} title="Model & settings" aria-label="Model and settings"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '34px', padding: '0 11px', borderRadius: '9px', border: `0.5px solid ${settingsOpen ? accentHex : cfg.border}`, background: settingsOpen ? cfg.dim : 'transparent', color: 'rgba(255,255,255,0.62)', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit', fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700, transition: 'all 0.2s' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: m.c, boxShadow: `0 0 6px ${m.c}B3`, flexShrink: 0 }} />
              {m.label}
            </button>
          )
        })()}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={recordOneShot} title={isTranscribing ? 'Transcribing…' : 'Voice input'} aria-label="Voice input"
          style={{ width: '34px', height: '34px', borderRadius: '9px', border: `0.5px solid ${isListening || isTranscribing ? accentHex : cfg.border}`, background: isListening || isTranscribing ? cfg.dim : 'transparent', color: isListening || isTranscribing ? accentHex : 'rgba(255,255,255,0.5)', cursor: isTranscribing ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '15px', transition: 'all 0.2s', animation: isListening ? 'pulse-active 1s ease-in-out infinite' : 'none' }}>
          {isListening ? '⏹' : isTranscribing
            ? <span style={{ width: '13px', height: '13px', borderRadius: '50%', border: `2px solid ${accentHex}`, borderTopColor: 'transparent', display: 'inline-block', animation: 'spin-slow 0.7s linear infinite' }} />
            : '🎙'}
        </button>
        {(() => {
          const canSend = (input.trim().length > 0 || chatAttachments.length > 0) && !streaming
          return (
            <button type="submit" disabled={!canSend} aria-label="Send"
              style={{ width: '34px', height: '34px', borderRadius: '50%', border: 'none', background: canSend ? accentHex : 'rgba(255,255,255,0.08)', color: canSend ? '#03030A' : 'rgba(255,255,255,0.35)', cursor: canSend ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '18px', fontWeight: 700, transition: 'all 0.2s', paddingBottom: '2px' }}>
              ↑
            </button>
          )
        })()}
      </div>
    </form>
    </div>
  )

  // Open a research report's notebook from its completed progress card (FIX 2A): routed through the
  // SAME action sequencing queue Spectre's voice navigation uses — explicit navigateTo (with its
  // 350ms settle gap) then openNotebook(view). The card stores the owning node id, so this works
  // from any scope and after a full reload (no dependency on transient component state).
  const openResearchNotebook = (nodeId: string, notebookId: string) => {
    const here = chatScope()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: Record<string, any>[] = []
    if (nodeId && nodeId !== here) {
      const name = nodesRef.current.find(n => n.id === nodeId)?.name ?? nodeId
      actions.push({ action: 'navigateTo', node_id: nodeId, node_name: name })
    }
    actions.push({ action: 'openNotebook', id: notebookId, mode: 'view' })
    enqueueActionsRef.current(actions, here)
  }
  // FIX 2B — the Open Notebook button is clickable only once the notebook is resolvable: present in
  // the loaded Docu-scape state OR known to the diagram tree index (refreshed after completion and
  // on every mount/navigation). Until then the button shows a loading state, never a broken link.
  const isResearchNotebookReady = (notebookId: string): boolean =>
    !!itemIndexRef.current.notebooks[notebookId] || !!findNotebookMeta(notebookId)

  // Shared messages list
  const messagesList = (compact: boolean) => (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        paddingRight: '4px',
        minHeight: 0,
        ...(compact ? {} : { maxHeight: 'calc(100vh - 300px)' }),
      }}
    >
      {messages.length === 0 && (
        <div style={{
          textAlign: 'center',
          color: 'rgba(255,255,255,0.2)',
          fontSize: '13px',
          marginTop: compact ? '32px' : '48px',
          letterSpacing: '0.03em',
        }}>
          Spectre is online. What do you need?
        </div>
      )}
      {messages.map((msg, i) => (
        <ChatMessage
          key={i}
          msg={msg}
          isLast={i === messages.length - 1}
          streaming={streaming}
          searching={searching}
          deepThinking={deepThinking}
          cfg={cfg}
          accentHex={accentHex}
          canEdit={msg.role === 'user'}
          canRetry={msg.role === 'assistant' && i === messages.length - 1}
          onEdit={msg.role === 'user' ? (newText => editUserMessage(i, newText)) : undefined}
          onRetry={msg.role === 'assistant' && i === messages.length - 1 ? retryLast : undefined}
          onResearchOpen={openResearchNotebook}
          onResearchStop={abortResearch}
          onResearchWindDown={windDownResearch}
          researchNotebookReady={isResearchNotebookReady}
          onSaveOffer={handleSaveOffer}
          onSaveOfferDismiss={dismissSaveOffer}
        />
      ))}
      {/* Silent status indicator — file reads / vault searches / web search / thinking show
          as ONE subtle line at the bottom of the thread (never a chat bubble), and clear the
          moment the answer streams in. */}
      {(() => {
        const s = isTranscribing
          ? { icon: '🎙', label: 'Transcribing' }
          : chatStatus
          ? { icon: chatStatus.kind === 'vault' ? '📚' : '📄', label: chatStatus.label }
          : (streaming && searching) ? { icon: '🔍', label: 'Searching the web' }
          : (streaming && deepThinking) ? { icon: '🧠', label: 'Thinking' }
          : null
        if (!s) return null
        return (
          <div className="animate-fadeIn" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '1px 2px', fontSize: 11, letterSpacing: '0.03em', color: 'rgba(255,255,255,0.42)' }}>
            <span style={{ animation: 'pulse-active 1.4s ease-in-out infinite' }}>{s.icon}</span>
            <span>{s.label}…</span>
          </div>
        )
      })()}
      <div ref={chatEndRef} />
    </div>
  )

  // Left chat panel (shared across folder, Hand, and project split views)
  // Minimal Spectre chat for focus mode (20% column): recent turns + an input bar only —
  // no session list, no Sources. Shares the scope's display buffer + sendMessage.
  const focusChatPanel = (scope: string) => {
    const buf = scope.startsWith('project-') ? (projectMessages[scope] || []) : (allMessages[scope] || [])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '12px 14px', flexShrink: 0, borderBottom: `0.5px solid ${cfg.border}` }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: accentHex }} />
          <span style={{ fontSize: 10, letterSpacing: '0.2em', fontWeight: 700, color: 'rgba(255,255,255,0.5)' }}>SPECTRE</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px' }}>
          {buf.length === 0 && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.6 }}>Ask Spectre about this document while you write.</span>}
          {buf.map((m, i) => m.kind === 'transition' ? (
            <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', letterSpacing: '0.02em', paddingLeft: 8 }}>{m.content}</div>
          ) : (
            <div key={i} className="msg-bubble" style={{
              fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              color: m.role === 'user' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.88)',
              borderLeft: m.role === 'assistant' ? `2px solid ${accentHex}55` : '2px solid transparent', paddingLeft: 8,
            }}>{stripJsonForDisplay(m.content)}</div>
          ))}
        </div>
        <form
          onSubmit={e => { e.preventDefault(); if (input.trim() && !streaming) sendMessage(input) }}
          style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexShrink: 0, margin: 10, ...panelStyle({ padding: '9px 12px' }) }}
        >
          <textarea
            value={input} rows={1}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.trim() && !streaming) sendMessage(input) } }}
            placeholder="Message Spectre…"
            disabled={streaming}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: 12, fontFamily: 'inherit', resize: 'none', overflowY: 'auto', lineHeight: 1.5, padding: 0, minHeight: 20, maxHeight: 90 }}
          />
          <button type="submit" disabled={!input.trim() || streaming}
            style={{ padding: '4px 9px', borderRadius: 5, border: `0.5px solid ${accentHex}`, background: 'transparent', color: accentHex, fontSize: 9, letterSpacing: '0.14em', fontWeight: 700, cursor: !input.trim() || streaming ? 'not-allowed' : 'pointer', opacity: !input.trim() || streaming ? 0.3 : 0.7, fontFamily: 'inherit', flexShrink: 0 }}>SEND</button>
        </form>
      </div>
    )
  }

  const splitChatPanel = (label: string) => {
    const scope = activeHand ?? (activeProject ? `project-${activeProject}` : activeFolder)
    const sid = activeSessionId[scope] ?? null
    const sessTitle = sessions[scope]?.find(s => s.id === sid)?.title ?? ''
    const hasSummary = sessionMsgMeta.some(m => m.is_compressed)
    const scopeNode = nodeById(scope)
    // HANDS belong only to Project-template Arms. Specialized Arms (schedule/body/
    // training) and custom non-project Arms get a plain session list (search + new +
    // list) — their conversations directly drive the right-panel widget.
    const isProjectArm = scopeNode?.level === 'arm' && scopeNode?.template === 'project'
    const scopeHands = isProjectArm ? handsOf(scope) : []
    // A Project Hand (leaf under the Projects arm) gets the restructured session layer:
    // a prominent "new chat" zone above the scrollable previous-conversation list.
    const isProjectHand = scopeNode?.level === 'hand' && scopeNode?.parent_id === 'projects'
    return (
    <div
      className={`split-chat${voiceMode || miniVoice ? ' voice-shimmer' : ''}`}
      style={{
        ...panelStyle(),
        // Voice mode collapses the chat to 25% (hands-busy layout — the work owns
        // the screen while the conversation is spoken); otherwise the user's dragged ratio.
        flex: `0 0 ${voiceMode || miniVoice ? 25 : chatPct}%`,
        transition: dividerDragging ? 'none' : 'flex-basis 0.55s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px',
        minHeight: 0,
        overflow: 'hidden',
        gap: '12px',
      }}
    >
      {/* The panel's own Spectre orb doubles as the mini (PiP) voice trigger. Tapping
          it expands the orb in place (~28→64px), starts a hands-free voice session
          with this folder/project's context, and shows Spectre's emotional state.
          Tap again (or Esc) to end. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        <button
          onClick={handleMiniOrbClick}
          title={miniVoice ? 'End voice — click or press Esc' : 'Talk to Spectre here'}
          style={{
            position: 'relative',
            width: miniVoice ? '64px' : '28px',
            height: miniVoice ? '64px' : '28px',
            flexShrink: 0,
            border: 'none', background: 'transparent', padding: 0,
            cursor: 'pointer',
            transition: 'width 0.45s cubic-bezier(0.4,0,0.2,1), height 0.45s cubic-bezier(0.4,0,0.2,1)',
            filter: miniVoice ? `drop-shadow(0 3px 14px ${accentHex}66)` : 'none',
          }}
        >
          <SpectreOrb
            cfg={cfg}
            active={miniVoice ? false : orbActive}
            listening={miniVoice ? false : isListening}
            mode={mode}
            size={miniVoice ? 64 : 28}
            voiceMode={miniVoice}
            voicePhase={miniVoice ? voicePhase : undefined}
          />
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
          <span style={{ fontSize: '10px', letterSpacing: '0.2em', color: accentHex, fontWeight: 600 }}>
            {label}
          </span>
          {miniVoice && (
            <span style={{
              fontSize: '8.5px', letterSpacing: '0.18em', fontWeight: 600,
              color: voicePhase === 'reconfiguring' ? '#F59E0B' : accentHex, opacity: 0.7,
            }}>
              {voicePhaseLabel(voicePhase)}
            </span>
          )}
        </div>
        {/* Right-side actions: edit primer (sessions view) / export conversation (chat view). */}
        {!miniVoice && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
            {chatView === 'sessions' && scopeNode && (
              <button
                onClick={() => setEditingPrimer(v => !v)}
                title="Edit Spectre primer"
                aria-label="Edit Spectre primer"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', color: editingPrimer ? accentHex : 'rgba(255,255,255,0.4)' }}
              >
                <IconSettings size={16} stroke={1.6} />
              </button>
            )}
            {chatView === 'chat' && sid && (
              <button
                onClick={() => exportSession(scope, sid)}
                title="Export conversation"
                aria-label="Export conversation"
                className="header-export"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', color: 'rgba(255,255,255,0.4)' }}
              >
                <IconDownload size={16} stroke={1.6} />
              </button>
            )}
          </div>
        )}
      </div>

      {chatView === 'sessions' ? (
        <>
          {editingPrimer && scopeNode && (
            <PrimerEditor
              node={scopeNode}
              accentHex={accentHex}
              cfg={cfg}
              onSave={primer => { saveNodePrimer(scopeNode.id, primer); setEditingPrimer(false) }}
              onClose={() => setEditingPrimer(false)}
            />
          )}
          {/* Project Hand: a prominent "new chat" zone above the previous-chats list
              (the orb header above already provides voice + the Hand label). */}
          {isProjectHand && !editingPrimer && (
            <button
              onClick={() => startNewSession(scope)}
              className="session-new"
              style={{
                width: '100%', textAlign: 'left', padding: '14px 14px', borderRadius: '10px',
                border: `0.5px solid ${cfg.border}`, borderLeft: `2px solid ${accentHex}`,
                background: cfg.dim, color: accentHex, display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '11px', letterSpacing: '0.16em', fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0, transition: 'background 0.15s',
              }}
            >
              <IconPlus size={15} stroke={1.8} /> START NEW CONVERSATION
            </button>
          )}
          {/* SECTIONS — tag-based filtering (project Hands only). */}
          {isProjectHand && !editingPrimer && (
            <SectionsBar
              tags={tagsByNode[scope] ?? []}
              activeTagId={activeTagByScope[scope] ?? null}
              onSelect={tagId => setActiveTag(scope, tagId)}
              onAddTag={name => { void createTagRemote(scope, name) }}
              onDeleteTag={id => { void deleteTagRemote(scope, id) }}
              accentHex={accentHex}
              cfg={cfg}
            />
          )}
          {isProjectHand && (
            <span style={{ fontSize: '8.5px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.35)', fontWeight: 700, padding: '0 2px', flexShrink: 0 }}>
              PREVIOUS CHATS
            </span>
          )}
          <SessionList
            sessions={sessions[scope] ?? []}
            activeId={sid}
            onSelect={id => selectSession(scope, id)}
            onNew={() => startNewSession(scope)}
            accentHex={accentHex}
            cfg={cfg}
            searchScope={scope}
            tagsEnabled={isProjectHand}
            tags={tagsByNode[scope] ?? []}
            activeTagId={activeTagByScope[scope] ?? null}
            onSetSessionTag={isProjectHand ? ((sessionId, tagId) => { void setSessionTagRemote(scope, sessionId, tagId) }) : undefined}
            hands={scopeHands}
            onHandClick={handleHandClick}
            onNewHand={isProjectArm ? () => { setCreatingHandParent(scope); setCreatingHand(true) } : undefined}
            onDeleteHand={hand => setConfirmDelete({ id: hand.id, name: hand.name, level: 'hand' })}
            hideNewButton={isProjectHand}
          />
        </>
      ) : (
        <>
          {/* Back to the session list + the active conversation's title. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
            <button
              onClick={() => { setChatView('sessions'); loadSessions(scope) }}
              style={{
                ...breadcrumbLinkStyle, alignSelf: 'flex-start',
                display: 'flex', alignItems: 'center', gap: '6px',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
            >
              ‹ {label} CHATS
            </button>
            {sessTitle && (
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sessTitle}
              </span>
            )}
          </div>
          {hasSummary && (
            <div style={{ fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.3)', textAlign: 'center', flexShrink: 0 }}>
              ↑ earlier messages compressed
            </div>
          )}
          {messagesList(true)}
          {chatInputBar}
        </>
      )}
    </div>
    )
  }

  // The inner content of an Arm's bento tile. Seeded Arms keep their exact bespoke
  // widget (keyed by node id); user-created Arms render a generic icon+name tile.
  const renderArmWidgetBody = (node: NodeMeta): React.ReactNode => {
    switch (node.id) {
      case 'schedule':
        return (
          <>
            <WidgetLabel accent={accentHex}>WHAT&apos;S NEXT</WidgetLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              {(() => {
                if (!gcalConnected) {
                  return (
                    <button
                      onClick={(e) => { e.stopPropagation(); window.location.href = '/api/auth/google' }}
                      style={{ fontSize: '11px', letterSpacing: '0.04em', color: accentHex, background: `${accentHex}14`, border: `0.5px solid ${accentHex}55`, borderRadius: '8px', padding: '9px 12px', cursor: 'pointer', textAlign: 'left' }}
                    >
                      Connect Google Calendar
                    </button>
                  )
                }
                const now = new Date()
                const upcoming = weekEvents.filter(e => evDate(e.end).getTime() > now.getTime()).slice(0, 4)
                if (upcoming.length === 0) {
                  return <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.04em', paddingTop: '2px' }}>Nothing upcoming</div>
                }
                return upcoming.map((e, i) => {
                  const d = evDate(e.start)
                  const isToday = sameDay(d, now)
                  const timeLabel = e.allDay ? 'All day' : isToday ? fmt12fromDate(d) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${fmt12fromDate(d)}`
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '10px', fontVariantNumeric: 'tabular-nums', minWidth: '72px', color: i === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.22)' }}>{timeLabel}</span>
                      <span style={{ fontSize: '12px', flex: 1, color: i === 0 ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.5)', fontWeight: i === 0 ? 500 : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                      <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: e.color ?? accentHex, flexShrink: 0, opacity: i === 0 ? 0.85 : 0.4 }} />
                    </div>
                  )
                })
              })()}
            </div>
          </>
        )

      case 'body':
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <WidgetLabel accent={accentHex}>BODY STATS</WidgetLabel>
              {ouraConnected && (ouraData || ouraError) && (
                <span style={{ fontSize: '8px', letterSpacing: '0.06em', color: ouraError || ouraData?.fromYesterday ? '#F59E0B' : 'rgba(255,255,255,0.28)', paddingBottom: '8px' }}>
                  {ouraError ? 'SYNC FAILED' : ouraData?.fromYesterday ? 'YESTERDAY' : ouraData ? ouraSyncedLabel(ouraData).toUpperCase() : ''}
                </span>
              )}
            </div>
            {!ouraConnected ? (
              <button
                onClick={(e) => { e.stopPropagation(); window.location.href = '/api/oura/auth' }}
                style={{ fontSize: '11px', letterSpacing: '0.04em', color: accentHex, background: `${accentHex}14`, border: `0.5px solid ${accentHex}55`, borderRadius: '8px', padding: '9px 12px', cursor: 'pointer', textAlign: 'left', width: '100%' }}
              >
                {ouraError === 'auth_expired' ? 'Reconnect Oura Ring' : 'Connect Oura Ring'}
              </button>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                {ouraCards(ouraData).map((stat, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em' }}>{stat.label.toUpperCase()}</span>
                      <span style={{ fontSize: '14px', color: accentHex, fontWeight: 700, lineHeight: 1 }}>
                        {stat.value ?? '--'}<span style={{ fontSize: '9px', marginLeft: '2px', opacity: 0.65 }}>{stat.value != null ? stat.unit : ''}</span>
                      </span>
                    </div>
                    {stat.bar && (
                      <div style={{ height: '2px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px' }}>
                        <div style={{ height: '100%', width: `${stat.value ?? 0}%`, background: accentHex, borderRadius: '2px', transition: 'width 0.8s ease' }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )

      case 'projects': {
        // Live compressed mirror of the Projects landing: one row per non-archived
        // project Hand (icon · name · truncated AI summary). Rows navigate straight to
        // their Hand; the footer link opens the full Projects arm.
        const projectHands = handsOf('projects')
        return (
          <>
            <WidgetLabel accent={accentHex}>ACTIVE PROJECTS</WidgetLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
              {projectHands.length === 0 && (
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.03em' }}>No projects yet — open to add one.</div>
              )}
              {projectHands.map(hand => {
                const raw = projectSummaries[hand.id] ?? hand.summary ?? ''
                const clean = stripMarkdown(raw)
                const summary = clean.length > 60 ? clean.slice(0, 60).trimEnd() + '…' : clean
                return (
                  <div
                    key={hand.id}
                    onClick={e => { e.stopPropagation(); handleHandClick(hand) }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.15s' }}
                  >
                    <div style={{ width: '26px', height: '26px', borderRadius: '7px', background: `${accentHex}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: accentHex }}>
                      <Ti name={hand.icon} size={15} color={accentHex} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hand.name}</div>
                      {summary && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
            <button
              onClick={e => { e.stopPropagation(); handleFolderClick('projects') }}
              style={{ marginTop: '4px', alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', color: accentHex, fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700, fontFamily: 'inherit', padding: '2px 0' }}
            >
              VIEW ALL →
            </button>
          </>
        )
      }

      case 'training':
        return (
          <>
            <WidgetLabel accent={accentHex}>TODAY&apos;S TRAINING</WidgetLabel>
            {(() => {
              const w = workouts[isoDate(new Date())]
              if (!w || w.blocks.length === 0) {
                return <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.03em', lineHeight: 1.5 }}>No workout yet — open to plan one with Spectre.</div>
              }
              const done = w.blocks.every(b => b.sets.every(s => s.done))
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.88)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                    <span style={{ fontSize: '10px', color: done ? '#10B981' : accentHex, letterSpacing: '0.06em', flexShrink: 0 }}>{done ? 'DONE' : `${w.blocks.length} LIFTS`}</span>
                  </div>
                  {w.focus && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.06em' }}>{w.focus}</div>}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {w.blocks.slice(0, 4).map((b) => (
                      <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: accentHex, flexShrink: 0, opacity: 0.7 }} />
                        <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.exercise}</span>
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{b.sets.length}×{b.sets[0]?.plannedReps || '—'}</span>
                      </div>
                    ))}
                    {w.blocks.length > 4 && <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', paddingLeft: '12px' }}>+{w.blocks.length - 4} more</span>}
                  </div>
                </div>
              )
            })()}
          </>
        )

      default: {
        // Generic tile for user-created Arms.
        const hands = handsOf(node.id)
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <Ti name={node.icon} size={20} color={accentHex} />
              <span style={{ fontSize: '11px', letterSpacing: '0.18em', color: accentHex, fontWeight: 700 }}>{node.name.toUpperCase()}</span>
            </div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.04em', lineHeight: 1.5 }}>
              {TEMPLATE_CHOICES.find(t => t.value === node.template)?.label ?? 'Custom'} arm
              {hands.length > 0 ? ` · ${hands.length} hand${hands.length === 1 ? '' : 's'}` : ''}
            </div>
          </>
        )
      }
    }
  }

  // dnd-kit drag end → reorder the flat Arms array, persist each changed position.
  const onArmDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = arms.map(a => a.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const reordered = [...arms]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    // Optimistic local order.
    const byId = new Map(reordered.map((n, i) => [n.id, i]))
    setNodes(prev => prev.map(n => byId.has(n.id) ? { ...n, position: byId.get(n.id)! } : n))
    persistArmOrder(reordered)
  }


  return (
    <div style={{
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden',
      background: '#03030A',
    }}>
      {/* Grid background */}
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `linear-gradient(${cfg.dim} 1px, transparent 1px), linear-gradient(90deg, ${cfg.dim} 1px, transparent 1px)`,
        backgroundSize: '48px 48px',
        pointerEvents: 'none',
        zIndex: 0,
        transition: 'background-image 0.6s ease',
      }} />

      {/* Header */}
      <header className="app-header" style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'rgba(3,3,10,0.45)',
        backdropFilter: 'blur(16px)',
        flexShrink: 0,
      }}>
        {/* Left — wordmark + version */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <span className="header-title" style={{ fontSize: '11px', letterSpacing: '0.22em', color: accentHex, fontWeight: 700 }}>
            THE DIAGRAM
          </span>
          <span style={{ fontSize: '9px', letterSpacing: '0.12em', color: accentHex, background: `${accentHex}1f`, border: `0.5px solid ${accentHex}55`, borderRadius: '5px', padding: '2px 6px', fontWeight: 700 }}>
            V4
          </span>
        </div>

        {/* Body + Training live in the top bar ONLY on the CORE dashboard. The instant you open
            an Arm/Hand/Project (chatOpen) they drop out, so that band becomes free space for the
            page you navigated into — a big vertical win on iPhone. Wordmark + bell + clock stay. */}
        {!chatOpen && (<>
        <button
          onClick={() => handleFolderClick('body')}
          title="Body — open"
          style={{ display: 'flex', alignItems: 'center', gap: '16px', background: 'transparent', border: 'none', borderRadius: '12px', padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.18s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <IconHeartbeat size={16} color={DOMAIN.body} stroke={1.6} />
            <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: DOMAIN.body, fontWeight: 700, textShadow: `0 0 8px ${DOMAIN.body}55` }}>BODY</span>
          </div>
          {ouraConnected ? (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px' }}>
              {ouraCards(ouraData).map((c, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '8px', letterSpacing: '0.07em', color: 'rgba(255,255,255,0.38)', whiteSpace: 'nowrap' }}>{c.label.toUpperCase()}</span>
                  <span style={{ fontSize: '15px', color: 'rgba(255,255,255,0.92)', fontWeight: 600, lineHeight: 1 }}>{c.value ?? '--'}<span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', marginLeft: '2px' }}>{c.value != null ? c.unit : ''}</span></span>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: '12px', color: DOMAIN.body }}>Connect Oura Ring</span>
          )}
        </button>

        {/* Today's training — wide band panel (live workouts). Click opens the gym arm. */}
        <button
          onClick={() => handleFolderClick('training')}
          title="Today's training — open"
          style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'transparent', border: 'none', borderRadius: '12px', padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.18s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <IconBarbell size={16} color={DOMAIN.training} stroke={1.6} />
            <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: DOMAIN.training, fontWeight: 700, textShadow: `0 0 8px ${DOMAIN.training}55` }}>TRAINING</span>
          </div>
          {(() => {
            const w = workouts[isoDate(new Date())]
            if (!w || w.blocks.length === 0) {
              return <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>No workout today — <span style={{ color: DOMAIN.training }}>plan one</span></span>
            }
            const done = w.blocks.every(b => b.sets.every(s => s.done))
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.92)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                <span style={{ fontSize: '10px', color: done ? '#10B981' : DOMAIN.training, letterSpacing: '0.06em', flexShrink: 0 }}>{done ? 'DONE' : `${w.blocks.length} LIFTS`}</span>
              </div>
            )
          })()}
        </button>
        {/* Word of the day — vocab, rotates 2x/day (morning + night). */}
        {(() => {
          const w = scribeWord.word ? scribeWord : { word: 'Perspicacious', def: 'having keen insight; discerning', pron: 'per-spih-KAY-shus' }
          return (
            <div title={`Word of the day — ${w.word} ${w.pron ? `(${w.pron})` : ''}: ${w.def}`} style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, maxWidth: '280px', padding: '3px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '8px', letterSpacing: '0.16em', color: DOMAIN.scribe, fontWeight: 700, textShadow: `0 0 8px ${DOMAIN.scribe}55` }}>WORD</span>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.92)', fontWeight: 600 }}>{w.word}</span>
                {w.pron && <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>{w.pron}</span>}
              </div>
              <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.def}</span>
            </div>
          )
        })()}
        </>)}

        {/* Right — notifications + clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          {/* The bell is PURE NOTIFICATIONS now — the Librarian moved to its
              own control next to MAP on each project. Click: dropdown of the Inbox stream. */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={() => {
                setBellOpen(o => !o)
                if (!bellOpen && inboxData.unread) {
                  void fetch('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'read' }) }).catch(() => {})
                  setInboxData(d => ({ unread: 0, events: d.events.map(e => ({ ...e, read_at: e.read_at ?? Date.now() })) }))
                }
              }}
              title="Notifications"
              aria-label="Notifications"
              className="topbar-glance"
              style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', background: 'transparent', border: `0.5px solid ${inboxData.unread ? '#C69A3C88' : cfg.border}`, borderRadius: '9px', cursor: 'pointer', transition: 'all 0.18s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = `${accentHex}55` }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = inboxData.unread ? '#C69A3C88' : cfg.border }}
            >
              <IconBell size={16} color={inboxData.unread ? '#E8C77D' : 'rgba(255,255,255,0.5)'} stroke={1.6} />
              {inboxData.unread > 0 && (
                <span style={{ position: 'absolute', top: '-4px', right: '-4px', minWidth: '15px', height: '15px', padding: '0 3px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#C69A3C', color: '#1a1205', fontSize: '9px', fontWeight: 700, borderRadius: '8px', lineHeight: 1 }}>{inboxData.unread}</span>
              )}
            </button>
            {bellOpen && (
              <>
                <div onClick={() => setBellOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 74 }} />
                <div className="animate-fadeIn" style={{ position: 'absolute', top: '38px', right: 0, zIndex: 75, width: '310px', maxHeight: '340px', overflowY: 'auto', background: 'rgba(8,10,22,0.97)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '10px 12px', boxShadow: '0 10px 36px rgba(0,0,0,0.55)', backdropFilter: 'blur(12px)' }}>
                  <div style={{ fontSize: '9px', letterSpacing: '0.22em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '6px' }}>NOTIFICATIONS</div>
                  {inboxData.events.length === 0 && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', padding: '4px 0' }}>Quiet.</div>}
                  {inboxData.events.map((e, i) => (
                    <div key={e.id} style={{ padding: '6px 0', borderTop: i ? `0.5px solid ${cfg.border}` : undefined }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px' }}>
                        <span style={{ color: DOMAIN.inbox, fontSize: '8.5px', textTransform: 'uppercase', letterSpacing: '0.1em', flexShrink: 0 }}>{e.kind}</span>
                        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginLeft: 'auto', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{new Date(e.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', lineHeight: 1.45, marginTop: '2px' }}>{e.body || e.title}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            aria-label="Wind-down"
            title="Wind-down"
            className="topbar-glance"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '9px', cursor: 'pointer', transition: 'all 0.18s', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = '#C9A96A66' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = cfg.border }}
            onClick={() => { setWindDownOffer(null); setWindDownOpen(true) }}
          >
            <IconMoon size={16} color="rgba(255,255,255,0.5)" stroke={1.6} />
          </button>
          <span className="header-clock" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums', minWidth: '62px', textAlign: 'right' }}>
            {clock}
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="app-main" style={{ flex: 1, position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

        {chatOpen && activeFolder === 'projects' && activeProject === null && activeHand === null ? (

          /* ── PROJECTS LANDING (no left panel — full-width cards) ─────────── */
          <div className="animate-slideUp folder-view-wrapper" style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            padding: '16px 24px', gap: '12px', minHeight: 0, overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => { setChatOpen(false); setActiveFolder('main') }}
                style={breadcrumbLinkStyle}
                onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
                onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
              >
                THE DIAGRAM
              </button>
              <span style={breadcrumbSepStyle}>›</span>
              <span style={{ fontSize: '10px', letterSpacing: '0.18em', color: accentHex, fontWeight: 600 }}>
                PROJECTS
              </span>
            </div>
            <div className="split-detail" style={{ ...panelStyle(), flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px' }}>
              <ProjectsLanding
                hands={handsOf('projects')}
                summaries={projectSummaries}
                spent={projectSpent}
                accentHex={DOMAIN.projects}
                cfg={cfg}
                onHandClick={handleHandClick}
                onAddProject={() => { setCreatingHandParent('projects'); setCreatingHand(true) }}
                onDeleteHand={hand => setConfirmDelete({ id: hand.id, name: hand.name, level: 'hand' })}
                onRenameHand={hand => setRenamingNode({ id: hand.id, name: hand.name, level: 'hand' })}
              />
            </div>
          </div>

        ) : chatOpen && activeFolder === 'projects' ? (

          /* ── PROJECT HAND WORKSPACE (chat · SOURCES · NOTEBOOKS) ─────────── */
          (() => {
            const phScope = activeHand ?? `project-${activeProject}`
            const phName = nodeById(phScope)?.name.toUpperCase() ?? 'PROJECT'
            const phNotebooks = notebooksByNode[phScope] ?? []
            const nbFocus = !!openNotebookId && notebookFocus
            const openNb = openNotebookId ? phNotebooks.find(n => n.id === openNotebookId) ?? null : null
            // Notebook handlers (scoped to this Hand) shared by the normal + focus layouts.
            const nbProps = {
              notebooks: phNotebooks,
              folderId: notebookFolder,
              setFolderId: setNotebookFolder,
              openNotebookId,
              // Manual card clicks always open for editing (resets any prior view mode set
              // by Spectre's openNotebook(mode:'view')).
              onOpenNotebook: (nb: NotebookMeta) => { setOpenNotebookMode('edit'); setOpenNotebookId(nb.id) },
              onCloseNotebook: () => { setOpenNotebookId(null); setNotebookFocus(false); openEditorApiRef.current = null; openNotebookContentRef.current = null },
              onCreateNotebook: (opts: { title: string; type: 'folder' | 'notebook'; color: string; icon: string }, parentId: string) => {
                void createNotebookRemote(phScope, { ...opts, parent_id: parentId }).then(nb => { if (nb && nb.type === 'notebook') { setOpenNotebookMode('edit'); setOpenNotebookId(nb.id) } })
              },
              onRenameNotebook: (id: string, title: string) => updateNotebookRemote(phScope, id, { title }),
              onDeleteNotebook: (id: string) => deleteNotebookRemote(phScope, id),
              onColorNotebook: (id: string, color: string) => updateNotebookRemote(phScope, id, { color }),
              onMoveNotebook: (id: string, parentId: string) => updateNotebookRemote(phScope, id, { parent_id: parentId }),
              onReorderNotebooks: (parentId: string, ids: string[]) => reorderNotebooks(phScope, parentId, ids),
              onMergeNotebooks: async (srcId: string, targetId: string, folderName: string) => {
                const folder = await createNotebookRemote(phScope, { title: folderName, type: 'folder' })
                if (!folder) return
                await updateNotebookRemote(phScope, targetId, { parent_id: folder.id })
                await updateNotebookRemote(phScope, srcId, { parent_id: folder.id })
                await loadNotebooks(phScope)
              },
              onDuplicateNotebook: async (id: string) => {
                // Document → independent copy at the same level ("… (copy)"). Notebook
                // (folder) → copy the folder plus every document inside it.
                const list = notebooksByNodeRef.current[phScope] ?? []
                const src = list.find(n => n.id === id)
                if (!src) return
                if (src.type === 'notebook') {
                  await createNotebookRemote(phScope, { title: `${src.title} (copy)`, type: 'notebook', parent_id: src.parent_id, content: src.content, icon: src.icon, color: src.color })
                } else {
                  const folder = await createNotebookRemote(phScope, { title: `${src.title} (copy)`, type: 'folder', icon: src.icon, color: src.color })
                  if (!folder) return
                  for (const ch of list.filter(n => n.parent_id === src.id && n.type === 'notebook')) {
                    await createNotebookRemote(phScope, { title: ch.title, type: 'notebook', parent_id: folder.id, content: ch.content, icon: ch.icon, color: ch.color })
                  }
                }
                await loadNotebooks(phScope)
              },
              onSaveNotebook: (id: string, json: string) => updateNotebookRemote(phScope, id, { content: json }),
              onEditorReady: (api: { id: string; insertMarkdown: (md: string, mode: 'append' | 'replace') => void }) => { openEditorApiRef.current = api },
              onEditorTeardown: () => { /* superseded by the next editor's onReady; falls back to API writes */ },
              onEditorContent: (id: string, title: string, markdown: string) => { openNotebookContentRef.current = { id, title, markdown } },
              onToggleFocus: () => setNotebookFocus(f => !f),
              onGhostRequest: ghostComplete,
              onThoughtConfirm: thoughtConfirm,
              // Spectre's openNotebook(mode:'view') opens the editor read-only.
              readOnly: openNotebookMode === 'view',
              // openFile preview (a Sources file shown in the right panel).
              previewFileId,
              onOpenFile: (id: string) => setPreviewFileId(id),
              onClosePreview: () => setPreviewFileId(null),
            }
            return (
            <div className="animate-slideUp folder-view-wrapper" style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              padding: '16px 24px', gap: '12px', minHeight: 0, overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <button
                  onClick={() => { setChatOpen(false); setActiveProject(null); setActiveHand(null); setActiveFolder('main') }}
                  style={breadcrumbLinkStyle}
                  onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                >
                  THE DIAGRAM
                </button>
                <span style={breadcrumbSepStyle}>›</span>
                <button
                  onClick={() => { setActiveProject(null); setActiveHand(null); loadProjectSummaries() }}
                  style={breadcrumbLinkStyle}
                  onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                >
                  PROJECTS
                </button>
                <span style={breadcrumbSepStyle}>›</span>
                <span style={{ fontSize: '10px', letterSpacing: '0.18em', color: accentHex, fontWeight: 600 }}>
                  {phName}
                </span>
                <button
                  onClick={() => setMapOpen({ nodeId: phScope, name: phName })}
                  title="Open the project map"
                  style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9.5px', letterSpacing: '0.14em', fontWeight: 700, color: DOMAIN.tasks, background: `${DOMAIN.tasks}14`, border: `0.5px solid ${DOMAIN.tasks}55`, borderRadius: '7px', padding: '4px 10px', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${DOMAIN.tasks}22` }}
                  onMouseLeave={e => { e.currentTarget.style.background = `${DOMAIN.tasks}14` }}
                >
                  <IconListCheck size={13} /> MAP
                </button>
                {/* The Librarian is project-local: it lives HERE, next to MAP —
                    the top bell is pure notifications now. */}
                <button
                  onClick={() => openLibrarian(phScope)}
                  title={librarianPending ? `The Librarian — ${librarianPending} plan${librarianPending === 1 ? '' : 's'} to review` : 'The Librarian — tidy this project’s documents'}
                  style={{ marginLeft: '6px', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9.5px', letterSpacing: '0.14em', fontWeight: 700, color: '#C69A3C', background: 'rgba(198,154,60,0.1)', border: `0.5px solid ${librarianPending ? '#C69A3C99' : 'rgba(198,154,60,0.4)'}`, borderRadius: '7px', padding: '4px 10px', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(198,154,60,0.2)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(198,154,60,0.1)' }}
                >
                  <IconBook size={13} /> LIBRARIAN{librarianPending ? ` · ${librarianPending}` : ''}
                </button>
              </div>

              {nbFocus && openNb ? (
                /* ── FOCUS MODE (state 4): chat collapses to 20%, editor takes 80%) ── */
                <div className="split-panels nb-focus-layout" style={{ flex: 1, display: 'flex', gap: '10px', minHeight: 0, overflow: 'hidden' }}>
                  <div style={{ ...panelStyle(), flex: '0 0 20%', minWidth: 180, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
                    {focusChatPanel(phScope)}
                  </div>
                  <div className="split-detail nb-focus-editor" style={{ ...panelStyle(), flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
                    <NotebookEditor
                      nodeId={phScope}
                      notebook={openNb}
                      onClose={nbProps.onCloseNotebook}
                      onSave={nbProps.onSaveNotebook}
                      focusMode={true}
                      onToggleFocus={nbProps.onToggleFocus}
                      onReady={nbProps.onEditorReady}
                      onTeardown={nbProps.onEditorTeardown}
                      onContent={nbProps.onEditorContent}
                      onGhostRequest={nbProps.onGhostRequest}
                      onThoughtConfirm={nbProps.onThoughtConfirm}
                      readOnly={nbProps.readOnly}
                      cfg={cfg}
                    />
                  </div>
                </div>
              ) : (
                <>
                {renderPaneTabs('WORKSPACE')}
                <div className="split-panels" ref={swipePanesRef} onTouchStart={onPanesTouchStart} onTouchMove={onPanesTouchMove} onTouchEnd={onPanesTouchEnd} style={{ flex: 1, display: 'flex', gap: '16px', minHeight: 0, overflow: 'hidden', ...({ '--pane': swipePane } as unknown as React.CSSProperties) }}>
                  {splitChatPanel(phName)}
                  {/* Draggable divider: the user sets the chat/work ratio themselves. */}
                  <div onPointerDown={dividerDown} title="Drag to resize the chat"
                    style={{ flexShrink: 0, width: '8px', margin: '0 -12px', cursor: 'col-resize', zIndex: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '2.5px', height: '52px', borderRadius: '2px', background: dividerDragging ? '#38BDF8' : 'rgba(255,255,255,0.14)', transition: 'background 0.15s' }} />
                  </div>
                  <div className="split-detail" style={{ ...panelStyle(), flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
                    <SourcesNotebooks
                      nodeId={phScope}
                      files={sourceFiles[phScope] ?? []}
                      onUpload={uploadFile}
                      onDelete={deleteFile}
                      cfg={cfg}
                      {...nbProps}
                    />
                  </div>
                </div>
                </>
              )}
            </div>
            )
          })()

        ) : chatOpen && activeFolder !== 'main' ? (

          /* ── FOLDER SPLIT VIEW (2nd level) ───────────────────── */
          <div className="animate-slideUp folder-view-wrapper" style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            padding: '16px 24px', gap: '12px', minHeight: 0, overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => { setChatOpen(false); setActiveFolder('main') }}
                style={breadcrumbLinkStyle}
                onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
                onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
              >
                THE DIAGRAM
              </button>
              <span style={breadcrumbSepStyle}>›</span>
              {activeHand ? (
                <>
                  <button
                    onClick={() => { setActiveHand(null); setChatView('sessions'); loadSessions(activeFolder) }}
                    style={breadcrumbLinkStyle}
                    onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                  >
                    {armLabel(activeFolder)}
                  </button>
                  <span style={breadcrumbSepStyle}>›</span>
                  <span style={{ fontSize: '10px', letterSpacing: '0.18em', color: accentHex, fontWeight: 600 }}>
                    {(nodeById(activeHand)?.name ?? '').toUpperCase()}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: '10px', letterSpacing: '0.18em', color: accentHex, fontWeight: 600 }}>
                  {armLabel(activeFolder)}
                </span>
              )}
            </div>

            {renderPaneTabs(activeHand ? (nodeById(activeHand)?.name.toUpperCase() ?? 'HAND') : armLabel(activeFolder))}
            <div className="split-panels" ref={swipePanesRef} onTouchStart={onPanesTouchStart} onTouchMove={onPanesTouchMove} onTouchEnd={onPanesTouchEnd} style={{ flex: 1, display: 'flex', gap: '16px', minHeight: 0, overflow: 'hidden', ...({ '--pane': swipePane } as unknown as React.CSSProperties) }}>
              {splitChatPanel(activeHand ? (nodeById(activeHand)?.name.toUpperCase() ?? 'HAND') : armLabel(activeFolder))}
              <div className="split-detail" style={{ ...panelStyle(), flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px' }}>
                {!activeHand && activeFolder === 'schedule' && (
                  <CalendarView
                    monthEvents={monthEvents}
                    viewMonth={viewMonth}
                    setViewMonth={setViewMonth}
                    selectedDay={selectedDay}
                    setSelectedDay={setSelectedDay}
                    gcalConnected={gcalConnected}
                    accentHex={DOMAIN.calendar}
                    cfg={cfg}
                    onChanged={() => { refreshMonth(viewMonthRef.current); refreshWeek() }}
                  />
                )}
                {!activeHand && activeFolder === 'body' && (
                  <ExpandedBodyStats oura={ouraData} connected={ouraConnected} error={ouraError} accentHex={DOMAIN.body} cfg={cfg} />
                )}
                {!activeHand && activeFolder === 'training' && (
                  <WorkoutArm
                    workouts={workouts}
                    exercises={exercises}
                    viewDate={viewDate}
                    setViewDate={setViewDate}
                    mutateWorkouts={mutateWorkouts}
                    openBlockRef={openBlockRef}
                    accentHex={DOMAIN.training}
                    cfg={cfg}
                    restTimer={restTimer}
                    startRestTimer={startRestTimer}
                  />
                )}
                {/* Custom Arms / Hands have no bespoke widget — a quiet node summary. */}
                {(() => {
                  const node = activeHand ? nodeById(activeHand) : nodeById(activeFolder)
                  const isKnown = !activeHand && ['schedule', 'body', 'projects', 'training'].includes(activeFolder)
                  if (isKnown || !node) return null
                  return <GenericNodeDetail node={node} accentHex={accentHex} cfg={cfg} />
                })()}
              </div>
            </div>
          </div>

        ) : (

          /* ── DASHBOARD ──────────────────────────────────────────── */
          <div className={`animate-fadeIn dash-canvas${voiceMode ? ' voice-active' : ''}`}>
            <style>{`
              .dash-canvas { position:relative; flex:1; min-height:0; overflow:hidden; }
              .dash-glow { position:absolute; inset:0; pointer-events:none; z-index:0; background: radial-gradient(ellipse 26% 32% at 50% 48%, rgba(14,165,233,0.10), transparent 70%), radial-gradient(ellipse 24% 26% at 86% 22%, rgba(168,85,247,0.05), transparent 70%), radial-gradient(ellipse 24% 26% at 14% 80%, rgba(16,185,129,0.05), transparent 70%); }
              .dash-scan { position:absolute; inset:0; pointer-events:none; z-index:1; opacity:0.3; background-image: repeating-linear-gradient(0deg, rgba(14,165,233,0.02) 0px, rgba(14,165,233,0.02) 1px, transparent 1px, transparent 3px); }
              .dash-canvas .lab-main { position:relative; z-index:2; height:100%; display:grid; gap:13px; padding:14px 24px 14px; grid-template-columns:1.2fr 1.1fr 0.9fr 0.9fr 1.1fr 1.2fr; grid-template-rows:repeat(5,1fr) auto; grid-template-areas:"cal cal focus north proj proj" "cal cal orb orb proj proj" "tasks tasks orb orb inbox inbox" "tasks tasks summ habits news news" "notes notes markets trends news news" "scribe scribe scribe scribe scribe scribe"; }
              .dash-canvas .lab-box { position:relative; display:flex; flex-direction:column; background:${PANEL}; border:0.5px solid ${cfg.border}; border-radius:14px; backdrop-filter:blur(12px); overflow:hidden; transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
              .dash-canvas .lab-box:hover { transform:translateY(-2px); border-color:var(--accent); box-shadow:0 12px 28px rgba(0,0,0,0.45), 0 0 16px -5px var(--accent); }
              .dash-canvas .lab-cell { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; border-radius:16px; transition:background .2s ease; }
              .dash-canvas .lab-scribe { grid-area:scribe; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; padding:8px 60px; background:radial-gradient(ellipse 60% 150% at 50% 50%, rgba(232,199,107,0.07), transparent 72%); -webkit-mask-image:linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%); mask-image:linear-gradient(90deg, transparent 0%, #000 13%, #000 87%, transparent 100%); }
              /* Voice mode keeps the dashboard fully VISIBLE (no dim/wash — that "blurred out" the
                 page for no reason). Instead of letting the orb's conversation panel SPILL over the
                 cards beneath it, voice gives the orb console its own tall central column so it has
                 real room and nothing overlaps. */
              @media (min-width:881px){
                /* Desktop voice layout: the orb spans the centre two columns across rows 1-4, so the
                   expanded orb + transcript + type bar sit in clear space. The four small centre
                   cards it would collide with (Focus, North Star, the Summary placeholder, Habits)
                   step aside FOR THE DURATION OF VOICE ONLY; every substantial card — Calendar,
                   Projects, Tasks, Curated, Inbox, Markets, Trends, Scribe — stays fully visible and
                   crisp framing the orb. They all return the instant voice ends. */
                .dash-canvas.voice-active .lab-main {
                  grid-template-areas:
                    "cal cal orb orb proj proj"
                    "cal cal orb orb proj proj"
                    "tasks tasks orb orb inbox inbox"
                    "tasks tasks orb orb news news"
                    "notes notes markets trends news news"
                    "scribe scribe scribe scribe scribe scribe";
                }
                .dash-canvas.voice-active [data-area="focus"],
                .dash-canvas.voice-active [data-area="north"],
                .dash-canvas.voice-active [data-area="summ"],
                .dash-canvas.voice-active [data-area="habits"] { display:none; }
              }
              @media (max-width:880px){
                /* Single scroll container = the canvas; the grid grows to content height. Keeping
                   lab-main at height:100% (the desktop value) with 14 implicit rows made the browser
                   COMPRESS the rows to fit, and the orb cell (no overflow:hidden) bled its 270px of
                   content over the cards below — the "jumble". height:auto + grid-auto-rows:min-content
                   gives every card its natural height with a clean gap; overflow:visible on lab-main
                   stops a second nested scroller. */
                .dash-canvas { overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; }
                .dash-canvas .lab-main {
                  grid-template-columns:1fr;
                  grid-template-rows:none;
                  grid-auto-rows:min-content;
                  height:auto; min-height:100%; overflow:visible;
                  gap:11px;
                  /* tasks ride high on mobile: phone capture + the NOW list are the point
                     of the phone view (TASKS-PLAN §4 mobile scope). */
                  grid-template-areas:"orb" "cal" "tasks" "summ" "proj" "news" "focus" "habits" "inbox" "markets" "trends" "notes" "north" "scribe";
                }
                .dash-canvas .lab-box, .dash-canvas .lab-cell { min-height:0; }
                .dash-canvas .lab-scribe { padding:8px 16px; }
              }
            `}</style>
            <div className="dash-glow" />
            <div className="dash-scan" />
            {/* Notifications prompt — the ONLY way to grant push on an installed iOS PWA is a
                button tap that fires Notification.requestPermission(); the Settings gear is too
                buried on mobile, so surface it prominently right on the dashboard. */}
            {notifPerm !== 'unsupported' && notifPerm !== 'granted' && !notifBannerHidden && (
              <div style={{ position: 'relative', zIndex: 3, display: 'flex', alignItems: 'center', gap: '12px', margin: '4px 16px 10px', padding: '12px 14px', borderRadius: '12px', background: `${DOMAIN.tasks}14`, border: `0.5px solid ${DOMAIN.tasks}55` }}>
                <IconBell size={18} color={DOMAIN.tasks} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>{notifPerm === 'denied' ? 'Notifications are blocked' : 'Turn on notifications'}</div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', marginTop: '2px' }}>{notifMsg ?? (notifPerm === 'denied' ? 'Enable them in iOS Settings → The Diagram → Notifications.' : 'So Spectre can remind you of tasks and blocks on this device.')}</div>
                </div>
                {notifPerm !== 'denied' && (
                  <button onClick={handleEnableNotifs} disabled={notifBusy}
                    style={{ flexShrink: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em', color: '#0b0e1a', background: DOMAIN.tasks, border: 'none', borderRadius: '9px', padding: '9px 16px', cursor: notifBusy ? 'default' : 'pointer' }}>{notifBusy ? '…' : 'ENABLE'}</button>
                )}
                <button onClick={() => setNotifBannerHidden(true)} aria-label="Dismiss" style={{ flexShrink: 0, width: '26px', height: '26px', color: 'rgba(255,255,255,0.4)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px' }}>✕</button>
              </div>
            )}
            {/* Block popover — click a calendar chip: link the event to a project, see the
                block checklist, assign the project's next map tasks in one tap (TASKS-PLAN §5). */}
            {blockPop && (() => {
              const e = blockPop.event
              const link = dashBlocks.find(b => b.event_id === e.id)
              const projTasks = link ? dashTasks.filter(t => t.node_id === link.node_id && t.status === 'todo').sort((a, b) => ((a.step ?? Infinity) - (b.step ?? Infinity)) || (a.lane - b.lane) || (a.created_at - b.created_at)) : []
              const assignedHere = projTasks.filter(t => t.block_event_id === e.id)
              const nextUp = projTasks.filter(t => t.block_event_id !== e.id).slice(0, 5)
              return (
                <div onClick={ev => ev.stopPropagation()}
                  style={{ position: 'fixed', left: blockPop.x, top: blockPop.y, width: '280px', zIndex: 80, background: 'rgba(10,14,32,0.97)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '12px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.9)', fontWeight: 600, marginBottom: '2px' }}>{e.title}</div>
                  <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginBottom: '10px' }}>{e.allDay ? 'All day' : `${fmt12fromDate(evDate(e.start))} – ${fmt12fromDate(evDate(e.end))}`}{e.recurringEventId ? ' · recurring' : ''}</div>
                  {!link && (
                    <div>
                      <div style={{ fontSize: '9px', letterSpacing: '0.09em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '6px' }}>LINK TO PROJECT</div>
                      {handsOf('projects').map(h => (
                        <div key={h.id} onClick={() => { linkBlock(e, h.id); }}
                          style={{ fontSize: '12px', color: 'rgba(255,255,255,0.8)', padding: '5px 6px', borderRadius: '6px', cursor: 'pointer' }}
                          onMouseEnter={ev => { ev.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}>{h.name}</div>
                      ))}
                    </div>
                  )}
                  {link && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '2px', background: DOMAIN.tasks, boxShadow: `0 0 5px ${DOMAIN.tasks}` }} />
                        <span style={{ fontSize: '11.5px', color: DOMAIN.tasks, fontWeight: 600, flex: 1 }}>{nodesRef.current.find(n => n.id === link.node_id)?.name ?? link.node_id}</span>
                        <span onClick={() => { unlinkBlock(e.id); setBlockPop(null) }} style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>unlink</span>
                      </div>
                      {assignedHere.length > 0 && <div style={{ fontSize: '9px', letterSpacing: '0.09em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, margin: '4px 0' }}>IN THIS BLOCK</div>}
                      {assignedHere.map(t => (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' }}>
                          <span onClick={() => toggleTaskDone(t)} style={{ width: '12px', height: '12px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '3px', cursor: 'pointer', flexShrink: 0 }} />
                          <span style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.8)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                          <span onClick={() => assignTaskToBlock(t.id, '')} title="Remove from block" style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', cursor: 'pointer' }}>×</span>
                        </div>
                      ))}
                      {nextUp.length > 0 && <div style={{ fontSize: '9px', letterSpacing: '0.09em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, margin: '6px 0 4px' }}>NEXT IN THE PROJECT</div>}
                      {nextUp.map(t => (
                        <div key={t.id} onClick={() => assignTaskToBlock(t.id, e.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', cursor: 'pointer', borderRadius: '5px' }}
                          onMouseEnter={ev => { ev.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}>
                          <span style={{ fontSize: '11px', color: DOMAIN.tasks, flexShrink: 0 }}>＋</span>
                          <span style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.65)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        </div>
                      ))}
                      {nextUp.length >= 3 && (
                        <div onClick={() => { nextUp.slice(0, 3).forEach(t => assignTaskToBlock(t.id, e.id)) }}
                          style={{ fontSize: '10px', color: DOMAIN.tasks, cursor: 'pointer', marginTop: '6px', fontWeight: 600 }}>＋ assign next 3</div>
                      )}
                      {projTasks.length === 0 && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>No open tasks in this project yet.</div>}
                    </div>
                  )}
                </div>
              )
            })()}
            <div className="lab-main">

              {/* CALENDAR — live */}
              <Box area="cal" accent={DOMAIN.calendar} icon={IconCalendar} label="CALENDAR" tag="TODAY" big onClick={() => handleFolderClick('schedule')}>
                {(() => {
                  if (!gcalConnected) return <div style={{ fontSize: '11px', color: DOMAIN.calendar }}>Connect Google Calendar</div>
                  const now = new Date()
                  const todays = weekEvents.filter(e => sameDay(evDate(e.start), now)).sort((a, b) => evDate(a.start).getTime() - evDate(b.start).getTime())
                  if (todays.length === 0) return <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.25)' }}>Nothing today</div>
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {todays.map(e => {
                        const past = evDate(e.end).getTime() < now.getTime()
                        const link = dashBlocks.find(b => b.event_id === e.id)
                        return (
                          <div key={e.id}
                            onClick={ev => { ev.stopPropagation(); setBlockPop({ event: e, x: Math.min(ev.clientX, window.innerWidth - 300), y: Math.min(ev.clientY, window.innerHeight - 320) }) }}
                            onMouseEnter={ev => { ev.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                            onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
                            style={{ display: 'flex', alignItems: 'center', gap: '10px', opacity: past ? 0.4 : 1, cursor: 'pointer', borderRadius: '6px', padding: '1px 3px', margin: '-1px -3px', transition: 'background .15s' }}>
                            <span style={{ fontSize: '11px', color: DOMAIN.calendar, fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: '54px' }}>{e.allDay ? 'All day' : fmt12fromDate(evDate(e.start))}</span>
                            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: e.color ?? DOMAIN.calendar, flexShrink: 0, opacity: 0.6 }} />
                            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.78)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{e.title}</span>
                            {link && <span title={`Linked: ${nodesRef.current.find(n => n.id === link.node_id)?.name ?? link.node_id}`} style={{ width: '6px', height: '6px', borderRadius: '2px', background: DOMAIN.tasks, flexShrink: 0, boxShadow: `0 0 5px ${DOMAIN.tasks}` }} />}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </Box>

              {/* TASKS — live NOW list (derived every render by the pure nowList; the clock
                  tick keeps it current — nothing stored). Quick-add parses NL time locally. */}
              <Box area="tasks" accent={DOMAIN.tasks} icon={IconListCheck} label="TASKS" tag="NOW" big onClick={() => setTasksFullOpen(true)}>
                {(() => {
                  const nowMs = Date.now()
                  const { sections } = nowList(nowMs, dashBlocks, dashTasks, {})
                  const doneToday = dashTasks.filter(t => t.status === 'done' && (t as NowTask & { completed_at?: number | null }).completed_at && new Date((t as NowTask & { completed_at?: number | null }).completed_at!).toDateString() === new Date(nowMs).toDateString())
                  const SECTION_LABEL: Record<string, string> = { 'active-block': 'NOW', 'due-now': 'DUE', 'carried-over': 'CARRIED OVER', 'upcoming-block': 'UP NEXT', today: 'TODAY', 'next-up': 'NEXT UP', yesterday: 'YESTERDAY' }
                  const projName = (id: string) => nodesRef.current.find(n => n.id === id)?.name ?? ''
                  const row = (t: NowTask, extra?: string) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '4px 0' }}>
                      <span onClick={e => { e.stopPropagation(); toggleTaskDone(t) }}
                        style={{ width: '13px', height: '13px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '3px', flexShrink: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} />
                      <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                      {((t as { spent_ms?: number }).spent_ms ?? 0) >= 60_000 && <span title="Real time spent (focus sessions)" style={{ fontSize: '9px', color: DOMAIN.focus, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtFocusMs((t as { spent_ms?: number }).spent_ms!)}</span>}
                      <span title="Lock in on this task (starts a focus session)" onClick={e => { e.stopPropagation(); void focusPost('start', t.title, t.id) }}
                        style={{ flexShrink: 0, cursor: 'pointer', color: DOMAIN.focus, fontSize: '9px', border: `0.5px solid ${DOMAIN.focus}44`, borderRadius: '5px', padding: '1px 6px', lineHeight: 1.5 }}>▶</span>
                      {t.due_at?.includes('T') && <span style={{ fontSize: '10px', color: DOMAIN.tasks, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmt12fromDate(new Date(t.due_at))}</span>}
                      {extra && <span style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.35)', flexShrink: 0, maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{extra}</span>}
                    </div>
                  )
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <input
                        value={taskInput}
                        onChange={e => setTaskInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') quickAddTask(taskInput); e.stopPropagation() }}
                        onClick={e => e.stopPropagation()}
                        placeholder="Add a task… ('groceries at 9am')"
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: `0.5px solid ${cfg.border}`, borderRadius: '7px', padding: '6px 10px', fontSize: '12px', color: 'rgba(255,255,255,0.85)', outline: 'none', marginBottom: '8px', flexShrink: 0 }}
                      />
                      {sections.length === 0 && <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.25)', padding: '6px 0' }}>Clear for now — capture anything above.</div>}
                      {sections.map((s, si) => (
                        <div key={si} style={{ marginBottom: '6px' }}>
                          <div style={{ fontSize: '8.5px', letterSpacing: '0.1em', color: s.kind === 'active-block' ? DOMAIN.tasks : 'rgba(255,255,255,0.35)', fontWeight: 700, padding: '2px 0' }}>
                            {SECTION_LABEL[s.kind]}{'block' in s ? ` — ${s.block.title || projName(s.block.node_id)}` : ''}{s.kind === 'yesterday' ? ` · ${s.count}` : ''}
                          </div>
                          {s.kind === 'yesterday'
                            ? (doneOpen ? s.tasks.map(t => row(t)) : <div onClick={e => { e.stopPropagation(); setDoneOpen(true) }} style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '2px 0' }}>{s.count} unfinished from before — show</div>)
                            : s.tasks.map(t => row(t, s.kind === 'next-up' ? projName(t.node_id) : undefined))}
                          {s.kind === 'carried-over' && (
                            <div style={{ display: 'flex', gap: '6px', padding: '3px 0 1px 22px' }}>
                              {([['✓ all', 'done-all'], ['→ next block', 'next-block'], ['→ today', 'today']] as const).map(([lbl, act]) => (
                                <span key={act} onClick={e => { e.stopPropagation(); recoverCarried(s.block.event_id, s.tasks, act) }}
                                  style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.5)', border: `0.5px solid ${cfg.border}`, borderRadius: '5px', padding: '2px 7px', cursor: 'pointer' }}>{lbl}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {doneToday.length > 0 && (
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginTop: '2px', flexShrink: 0 }}>
                          ✓ {doneToday.length} done today
                        </div>
                      )}
                    </div>
                  )
                })()}
              </Box>

              {/* NOTEPADS — the whiteboard next to the desk. Two views: the chip list of every
                  pad, or ONE pad ENLARGED to fill the whole box so an active list stays readable
                  at a glance. The enlargement persists (localStorage) until the user collapses it. */}
              {(() => {
                const expanded = expandedNotepadId ? notepads.find(n => n.id === expandedNotepadId) : undefined
                // Enlarged: the pad's own name takes over the widget header and its controls sit in
                // the header strip, so the entire body below is content — in a one-row grid cell a
                // second header row would cost about half the readable lines.
                const ctrlBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.32)', cursor: 'pointer', padding: '1px 2px', fontFamily: 'inherit', fontSize: '8.5px', letterSpacing: '0.12em', fontWeight: 700 }
                const hoverable = (e: React.MouseEvent<HTMLButtonElement>, on: boolean) => { e.currentTarget.style.color = on ? DOMAIN.notes : 'rgba(255,255,255,0.32)' }
                return (
                  <Box area="notes" accent={DOMAIN.notes} icon={IconNotebook}
                    label={expanded ? expanded.title.toUpperCase() : 'NOTEPADS'}
                    onClick={() => { if (!expanded) setNotepadsFullOpen(true) }}
                    headerRight={expanded ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
                        <button onClick={e => { e.stopPropagation(); setOpenNotepadId(expanded.id) }} title="Edit this notepad"
                          onMouseEnter={e => hoverable(e, true)} onMouseLeave={e => hoverable(e, false)} style={ctrlBtn}><IconPencil size={11} /></button>
                        <button onClick={e => { e.stopPropagation(); toggleNotepadExpanded(null) }} title="Collapse — back to all notepads"
                          onMouseEnter={e => hoverable(e, true)} onMouseLeave={e => hoverable(e, false)} style={ctrlBtn}><IconMinimize size={11} /> ALL</button>
                      </span>
                    ) : undefined}>
                {(() => {
                  // ── ENLARGED: one pad owns the box ──
                  if (expanded) {
                    const lines = expanded.content.split('\n').map(l => l.trim()).filter(Boolean)
                    return (
                      <div onClick={e => { e.stopPropagation(); setOpenNotepadId(expanded.id) }} title="Tap to edit"
                        style={{ height: '100%', minHeight: 0, cursor: 'pointer' }}>
                        {lines.length === 0
                          ? <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>empty — tap to write</span>
                          : lines.map((l, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', fontSize: '11.5px', color: 'rgba(255,255,255,0.74)', lineHeight: 1.55 }}>
                              <span style={{ color: `${DOMAIN.notes}88`, flexShrink: 0 }}>·</span>
                              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{l}</span>
                            </div>
                          ))}
                      </div>
                    )
                  }
                  // ── LIST: every pad as a chip; ⤢ on a chip enlarges it into the box ──
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {notepads.map(n => {
                        const preview = n.content.split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
                        return (
                          <div key={n.id} onClick={e => { e.stopPropagation(); setOpenNotepadId(n.id) }} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', maxWidth: '46%', background: n.content.trim() ? 'rgba(255,255,255,0.03)' : 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '5px 10px', cursor: 'pointer', textAlign: 'left' }}>
                            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: 'rgba(255,255,255,0.8)', minWidth: 0 }}>
                                <IconList size={12} color="rgba(255,255,255,0.4)" />
                                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                              </span>
                              {preview && <span style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.38)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>}
                            </span>
                            <span role="button" aria-label={`Enlarge ${n.title}`} title="Enlarge — keep this pad open in the widget"
                              onClick={e => { e.stopPropagation(); toggleNotepadExpanded(n.id) }}
                              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = DOMAIN.notes }}
                              onMouseLeave={e => { e.currentTarget.style.opacity = '0.35'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)' }}
                              style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.35, color: 'rgba(255,255,255,0.6)', flexShrink: 0, transition: 'opacity 0.15s, color 0.15s' }}>
                              <IconMaximize size={11} />
                            </span>
                          </div>
                        )
                      })}
                      <button
                        onClick={async e => {
                          e.stopPropagation()
                          try {
                            const r = await fetch('/api/notepads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New notepad' }) })
                            const d = await r.json().catch(() => null)
                            await loadNotepads()
                            if (d?.notepad?.id) setOpenNotepadId(d.notepad.id)
                          } catch { /* next open retries */ }
                        }}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', color: 'rgba(255,255,255,0.4)', background: 'transparent', border: `0.5px dashed ${cfg.border}`, borderRadius: '8px', padding: '5px 10px', cursor: 'pointer' }}>
                        <IconPlus size={11} /> new
                      </button>
                    </div>
                  )
                })()}
                  </Box>
                )
              })()}

              {/* PROJECTS — live */}
              <Box area="proj" accent={DOMAIN.projects} icon={IconFolder} label="PROJECTS" big>
                {handsOf('projects').length === 0 && <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', padding: '8px 0' }}>No projects yet — open to add one.</div>}
                {handsOf('projects').map((hand, i) => (
                  <div key={hand.id} onClick={() => handleHandClick(hand)}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderTop: i ? `0.5px solid ${cfg.border}` : undefined, cursor: 'pointer', transition: 'background 0.15s', borderRadius: '7px' }}>
                    {(() => { const dot = [DOMAIN.body, DOMAIN.projects, DOMAIN.calendar, DOMAIN.north, DOMAIN.news, DOMAIN.training][i % 6]; return <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: dot, boxShadow: `0 0 6px ${dot}`, flexShrink: 0 }} /> })()}
                    <span style={{ flex: 1, fontSize: '13px', color: 'rgba(255,255,255,0.85)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hand.name}</span>
                    <IconChevronRight size={15} color="rgba(255,255,255,0.25)" />
                  </div>
                ))}
                <div onClick={() => handleFolderClick('projects')} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginTop: '8px', cursor: 'pointer' }}><IconPlus size={12} /> add or remove projects</div>
              </Box>

              {/* NEWS — preview (tall) */}
              <Box area="news" accent={DOMAIN.news} icon={IconSparkles} label="CURATED FOR YOU" tag={morningNews?.status === 'ready' ? 'this morning' : 'tech · ai · research'} big>
                {/* News only — the Spectre morning note rides the wake push + Inbox, not this box. */}
                {morningNews?.status === 'ready' && morningNews.items.length > 0 ? (
                  morningNews.items.map((it, i) => (
                    <a key={i} href={it.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', gap: '10px', padding: '9px 0', borderTop: i ? `0.5px solid ${cfg.border}` : undefined }}>
                      <span style={{ width: '38px', height: '38px', borderRadius: '8px', background: `linear-gradient(135deg, ${DOMAIN.news}22, rgba(255,255,255,0.03))`, border: `0.5px solid ${cfg.border}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '8px', color: DOMAIN.news, letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'center', lineHeight: 1.2, padding: '2px' }}>{it.topic || 'news'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.85)', lineHeight: 1.3, fontWeight: 500 }}>{it.title}</div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.4, marginTop: '3px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.summary}</div>
                        <div style={{ fontSize: '9px', color: DOMAIN.news, marginTop: '3px' }}>{it.source}</div>
                      </div>
                    </a>
                  ))
                ) : morningNews?.status === 'compiling' ? (
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', fontStyle: 'italic', padding: '6px 0' }}>Compiling this morning&rsquo;s read on the local model&hellip;</div>
                ) : morningNews?.status === 'ready' ? (
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', padding: '6px 0' }}>Nothing worth your time surfaced today.</div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', padding: '6px 0' }}>The morning read compiles when the day starts.</div>
                )}
                <button onClick={() => { newsPollRef.current = 0; void loadNews(true) }} style={{ marginTop: '6px', padding: '3px 0', width: '100%', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.28)', fontSize: '9px', letterSpacing: '0.12em', cursor: 'pointer', textAlign: 'left' }}>↻ RECOMPILE</button>
              </Box>

              {/* FOCUS — the deep-work timer (live; server-authoritative, survives reloads) */}
              <Box area="focus" accent={DOMAIN.focus} icon={IconBolt} label="FOCUS">
                {focusData.open ? (
                  <>
                    <input
                      key={focusData.open.id}
                      defaultValue={focusData.open.label}
                      onBlur={e => { if (e.target.value.trim() && e.target.value !== focusData.open?.label) void focusPost('rename', e.target.value) }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: 'rgba(255,255,255,0.88)', fontWeight: 600, padding: 0 }}
                    />
                    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '18px', color: DOMAIN.focus, fontWeight: 600, marginTop: '3px' }}>{fmtFocusMs(Date.now() - focusData.open.started_at)}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '7px', flexWrap: 'wrap' }}>
                      {/* Task-linked sessions: LAND IT completes the task (focus and tasks unified).
                          Scratch sessions just land. "land only" keeps the escape hatch. */}
                      <button
                        title={focusData.open.task_id ? 'Land the session and complete the task' : 'Land the session'}
                        onClick={() => {
                          const tid = focusData.open?.task_id
                          if (tid) void fetch(`/api/tasks/${tid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) }).then(() => loadDashTasks()).catch(() => {})
                          void focusPost('stop')
                        }}
                        style={{ padding: '4px 12px', background: `${DOMAIN.focus}22`, border: `0.5px solid ${DOMAIN.focus}88`, borderRadius: '7px', color: DOMAIN.focus, fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer' }}>
                        {focusData.open.task_id ? 'LAND IT ✓' : 'LAND IT'}
                      </button>
                      {focusData.open.task_id ? (
                        <button title="Land without completing the task" onClick={() => void focusPost('stop')}
                          style={{ padding: '4px 8px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: '9px', cursor: 'pointer' }}>land only</button>
                      ) : null}
                      <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)' }}>today {fmtFocusMs(focusData.today_total_ms)}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      value={focusLabel}
                      onChange={e => setFocusLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { void focusPost('start', focusLabel || 'Deep work'); setFocusLabel('') } }}
                      placeholder="what are you locking onto?"
                      style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: `0.5px solid ${cfg.border}`, borderRadius: '7px', outline: 'none', fontSize: '11px', color: 'rgba(255,255,255,0.85)', padding: '6px 8px' }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '7px' }}>
                      <button onClick={() => { void focusPost('start', focusLabel || 'Deep work'); setFocusLabel('') }} style={{ padding: '4px 12px', background: `${DOMAIN.focus}22`, border: `0.5px solid ${DOMAIN.focus}88`, borderRadius: '7px', color: DOMAIN.focus, fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer' }}>LOCK IN</button>
                      <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)' }}>today {fmtFocusMs(focusData.today_total_ms)}</span>
                    </div>
                    {/* Lock in ON a task (weave item 1) — the session remembers it; landing can complete it. */}
                    {(() => {
                      const { sections } = nowList(Date.now(), dashBlocks, dashTasks, {})
                      const pool = sections
                        .filter(s => ['active-block', 'due-now', 'next-up', 'today'].includes(s.kind))
                        .flatMap(s => (s as { tasks?: NowTask[] }).tasks ?? [])
                      const seen = new Set<string>()
                      const sugg = pool.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true }).slice(0, 3)
                      if (!sugg.length) return null
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                          {sugg.map(t => (
                            <button key={t.id} onClick={() => void focusPost('start', t.title, t.id)} title={`Lock in on: ${t.title}`}
                              style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '9.5px', color: 'rgba(255,255,255,0.55)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '7px', padding: '3px 8px', cursor: 'pointer' }}>
                              {t.title}
                            </button>
                          ))}
                        </div>
                      )
                    })()}
                  </>
                )}
                {/* the day's landed sessions — what was actually done */}
                {focusData.sessions.filter(s => s.ended_at).slice(-2).reverse().map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '5px' }}>
                    <IconCheck size={10} color={`${DOMAIN.focus}99`} />
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                    <span style={{ fontSize: '9.5px', color: `${DOMAIN.focus}BB`, fontVariantNumeric: 'tabular-nums' }}>{fmtFocusMs((s.ended_at ?? 0) - s.started_at)}</span>
                  </div>
                ))}
              </Box>

              {/* HABITS — live tracker (deterministic; streaks derive server-side) */}
              <Box area="habits" accent={DOMAIN.habits} icon={IconFlame} label="HABITS">
                {(() => {
                  const today = localDateStr(Date.now())
                  const checkedToday = new Set(habitsData.checks.filter(c => c.date === today).map(c => c.habit_id))
                  return habitsData.habits.map(h => {
                    const done = checkedToday.has(h.id)
                    const streak = habitsData.streaks[h.id] ?? 0
                    return (
                      <div key={h.id} onClick={() => void toggleHabit(h.id, !done)} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', cursor: 'pointer' }}>
                        <span style={{ width: '14px', height: '14px', borderRadius: '4px', border: `1px solid ${done ? DOMAIN.habits : 'rgba(255,255,255,0.25)'}`, background: done ? `${DOMAIN.habits}33` : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {done && <IconCheck size={10} color={DOMAIN.habits} />}
                        </span>
                        <span style={{ fontSize: '11px', color: done ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.6)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                        {streak > 0 && <><IconFlame size={11} color={DOMAIN.habits} /><span style={{ fontSize: '11px', color: DOMAIN.habits, fontWeight: 600 }}>{streak}</span></>}
                      </div>
                    )
                  })
                })()}
                <input
                  value={newHabit}
                  onChange={e => setNewHabit(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newHabit.trim()) {
                      const name = newHabit.trim(); setNewHabit('')
                      void fetch('/api/habits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'create', name }) }).then(() => loadHabits())
                    }
                  }}
                  placeholder="+ habit"
                  style={{ width: '100%', marginTop: '4px', background: 'transparent', border: 'none', outline: 'none', fontSize: '10px', color: 'rgba(255,255,255,0.5)', padding: '2px 0' }}
                />
              </Box>

              {/* INBOX — the unified stream of what Spectre fired (click = mark read) */}
              <Box area="inbox" accent={DOMAIN.inbox} icon={IconBell} label="INBOX" tag={inboxData.unread ? String(inboxData.unread) : undefined}
                onClick={() => {
                  if (!inboxData.unread) return
                  void fetch('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'read' }) })
                  setInboxData(d => ({ unread: 0, events: d.events.map(e => ({ ...e, read_at: e.read_at ?? Date.now() })) }))
                }}>
                {inboxData.events.length === 0 && (
                  <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', padding: '2px 0' }}>Quiet. Check-ins, reminders, and compiles land here.</div>
                )}
                {inboxData.events.slice(0, 4).map((e, i) => (
                  <div key={e.id} style={{ fontSize: '10.5px', color: e.read_at ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.85)', lineHeight: 1.4, padding: '3px 0', borderTop: i ? `0.5px solid ${cfg.border}` : undefined, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    <span style={{ color: DOMAIN.inbox, fontSize: '9px', marginRight: '6px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{e.kind}</span>
                    {e.body || e.title}
                  </div>
                ))}
              </Box>

              {/* MILESTONES — the North Star's nearest dated steps (replaced MARKETS — dead
                  pixels became goal pixels). Click → the full map. */}
              <Box area="markets" accent={DOMAIN.north} icon={IconTarget} label="MILESTONES" onClick={() => setMapOpen({ nodeId: 'north-star', name: 'North Star' })}>
                {(() => {
                  const ms = dashTasks
                    .filter(t => t.node_id === 'north-star' && t.status === 'todo' && t.due_at)
                    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)))
                    .slice(0, 3)
                  if (!ms.length) return <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', padding: '2px 0' }}>No dated milestones yet — open the map and place them.</div>
                  return ms.map((t, i) => {
                    const days = Math.max(0, Math.ceil((new Date(`${String(t.due_at).slice(0, 10)}T23:59:59`).getTime() - Date.now()) / 86_400_000))
                    return (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 0', borderTop: i ? `0.5px solid ${cfg.border}` : undefined }}>
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.85)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        <span style={{ fontSize: '10px', color: DOMAIN.north, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{days}d</span>
                      </div>
                    )
                  })
                })()}
              </Box>

              {/* CONSISTENCY — habit trends, weekly resolution (replaced the TRENDS preview;
                  cold-state rule: 6-week shapes, never a daily verdict) */}
              <Box area="trends" accent={DOMAIN.trends} icon={IconChartBar} label="CONSISTENCY">
                {(() => {
                  const top = habitsData.habits.slice(0, 3)
                  if (!top.length || !habitsData.checks.length) return <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', lineHeight: 1.5 }}>Check habits off and their weekly shapes grow here — one small line per habit, six weeks deep.</div>
                  const weeks = [...Array(6)].map((_, w) => { const end = Date.now() - w * 7 * 86_400_000; return { start: end - 7 * 86_400_000, end } }).reverse()
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      {top.map(h => {
                        const d = weeks.map(w => habitsData.checks.filter(c => { const t = new Date(`${c.date}T12:00:00`).getTime(); return c.habit_id === h.id && t > w.start && t <= w.end }).length)
                        return (
                          <div key={h.id} style={{ flex: 1, textAlign: 'center' }}>
                            {spark(d, DOMAIN.trends)}
                            <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>{h.name.split(' ')[0].toUpperCase().slice(0, 5)}</div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </Box>

              {/* NORTH STAR — dissolved, and now a door: click → the goal map (the Tasks map
                  machinery on the north-star node — the user places their own goals there). */}
              <div className="lab-cell" data-area="north" title="Open the North Star map"
                onClick={() => setMapOpen({ nodeId: 'north-star', name: 'North Star' })}
                style={{ gridArea: 'north', cursor: 'pointer', background: `radial-gradient(ellipse 90% 130% at 50% 50%, ${DOMAIN.north}12, transparent 72%)` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><IconTarget size={12} color={DOMAIN.north} /><span style={{ fontSize: '8.5px', letterSpacing: '0.2em', color: DOMAIN.north, fontWeight: 700, textShadow: `0 0 10px ${DOMAIN.north}66` }}>NORTH STAR</span><span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em' }}>· MAP →</span></div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)', fontWeight: 600, marginTop: '3px' }}>Your long-term goal</div>
                {/* Quote of the day — set each morning from yesterday's chapter (Scribe, local model). */}
                {(() => {
                  const q = scribeQuote.quote ? scribeQuote : { quote: 'Somewhere, something incredible is waiting to be known.', author: 'Carl Sagan' }
                  return (
                    <div style={{ marginTop: '8px', maxWidth: '240px' }}>
                      <p style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '10.5px', color: 'rgba(232,228,205,0.72)', lineHeight: 1.5, margin: 0, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>“{q.quote}”</p>
                      <div style={{ fontSize: '8.5px', letterSpacing: '0.08em', color: DOMAIN.north, marginTop: '4px', textShadow: `0 0 8px ${DOMAIN.north}44` }}>— {q.author}</div>
                    </div>
                  )
                })()}
              </div>

              {/* SPECTRE SUMMARY — dissolved */}
              <div className="lab-cell" data-area="summ" style={{ gridArea: 'summ', padding: '4px 12px' }}>
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.58)', lineHeight: 1.55, margin: 0 }}>Good morning. Once the morning optimizer is wired, your day lands here — schedule-aware.</p>
              </div>

              {/* ORB CELL — voice-first hero; chat lives in the drawer */}
              <div style={{ gridArea: 'orb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: voiceMode ? '14px' : '10px', minHeight: 0, position: 'relative', zIndex: voiceMode ? 6 : 2 }}>
                <div onClick={handleOrbClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', flexShrink: 0, height: voiceMode ? '300px' : '188px', transition: 'height 0.6s cubic-bezier(0.4,0,0.2,1)' }}>
                  <SpectreOrb cfg={cfg} active={orbActive || ttsPlaying} listening={isListening} mode={mode} renderSize={300} size={voiceMode ? 300 : 188} voiceMode={voiceMode} voicePhase={voiceMode ? voicePhase : undefined} />
                </div>
                {!voiceMode ? (
                  <>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '11px', letterSpacing: '0.4em', color: accentHex, fontWeight: 700, textShadow: `0 0 14px ${accentHex}66` }}>SPECTRE</div>
                      <div style={{ fontSize: '8.5px', color: 'rgba(255,255,255,0.24)', letterSpacing: '0.18em', marginTop: '3px' }}>ONLINE · TAP ORB TO SPEAK</div>
                    </div>
                    <button onClick={() => { loadSessions('main'); setMainDrawerOpen(true) }} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', border: `0.5px solid ${cfg.border}`, borderRadius: '20px', padding: '6px 14px', fontSize: '11px', color: 'rgba(255,255,255,0.6)', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.18s' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = `${accentHex}66`; e.currentTarget.style.color = accentHex }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = cfg.border; e.currentTarget.style.color = 'rgba(255,255,255,0.6)' }}>
                      <IconMessage size={13} /> open chat
                    </button>
                  </>
                ) : (
                  <>
                    {(() => {
                      const listening = voicePhase === 'listening'
                      const busy = voicePhase === 'thinking' || voicePhase === 'transcribing'
                      const icon = listening ? '⏹' : busy ? '…' : '🎙'
                      return (
                        <button onClick={e => { e.stopPropagation(); handleMicTap() }} title={listening ? 'Stop & send' : voicePhase === 'speaking' ? 'Interrupt' : 'Tap to speak'}
                          style={{ width: '58px', height: '58px', borderRadius: '50%', border: `1.5px solid ${listening ? accentHex : 'rgba(255,255,255,0.18)'}`, background: listening ? cfg.dim : 'rgba(255,255,255,0.03)', color: listening ? accentHex : 'rgba(255,255,255,0.45)', cursor: busy ? 'default' : 'pointer', fontSize: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: listening ? 'pulse-active 1s ease-in-out infinite' : 'none', transition: 'all 0.2s', flexShrink: 0, position: 'relative', zIndex: 5 }}>
                          {icon}
                        </button>
                      )
                    })()}
                    {(() => {
                      const lastUser = [...messages].reverse().find(m => m.role === 'user')
                      const lastSpectre = [...messages].reverse().find(m => m.role === 'assistant')
                      const reconfig = voicePhase === 'reconfiguring'
                      const status = reconfig ? 'Reconfiguring voice systems…' : voicePhase === 'listening' ? 'Listening…' : voicePhase === 'transcribing' ? 'Transcribing…' : voicePhase === 'thinking' ? 'Thinking…' : voicePhase === 'speaking' ? 'Speaking…' : 'Tap the mic to speak'
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center', width: '100%' }}>
                          <span style={{ fontSize: '10px', letterSpacing: '0.22em', color: reconfig ? '#F59E0B' : accentHex, opacity: reconfig ? 0.95 : 0.75, fontWeight: 600 }}>{status.toUpperCase()}</span>
                          <div style={{ width: '100%', maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: '10px', ...panelStyle({ padding: '14px 16px' }) }}>
                            <div style={{ display: 'flex', gap: '12px' }}><span style={{ fontSize: '9px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.3)', minWidth: '50px', paddingTop: '3px' }}>YOU</span><span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, flex: 1 }}>{lastUser?.content || '—'}</span></div>
                            <div style={{ height: '0.5px', background: cfg.border }} />
                            <div style={{ display: 'flex', gap: '12px' }}><span style={{ fontSize: '9px', letterSpacing: '0.16em', color: accentHex, minWidth: '50px', paddingTop: '3px', opacity: 0.8 }}>SPECTRE</span><span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.92)', lineHeight: 1.55, flex: 1 }}>{lastSpectre?.content || '…'}</span></div>
                          </div>
                          <form onSubmit={e => { e.preventDefault(); if (input.trim()) sendVoiceTurn(input) }} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', opacity: 0.6, width: '100%', maxWidth: '460px', ...panelStyle({ padding: '10px 14px' }) }}>
                            <textarea ref={inputRef} value={input} rows={1} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.trim()) sendVoiceTurn(input) } }} placeholder="Or type a message…" disabled={streaming} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: '12px', fontFamily: 'inherit', resize: 'none', overflowY: 'auto', lineHeight: '1.6', padding: 0, minHeight: '21px', maxHeight: '80px' }} />
                            <button type="submit" disabled={!input.trim() || streaming} style={{ padding: '4px 10px', borderRadius: '5px', border: `0.5px solid ${accentHex}`, background: 'transparent', color: accentHex, fontSize: '9px', letterSpacing: '0.14em', fontWeight: 700, cursor: !input.trim() || streaming ? 'not-allowed' : 'pointer', opacity: !input.trim() || streaming ? 0.3 : 0.7, fontFamily: 'inherit', flexShrink: 0 }}>SEND</button>
                          </form>
                        </div>
                      )
                    })()}
                  </>
                )}
              </div>

              {/* SCRIBE — dissolved ribbon (live: latest chapter; click → full Chronicle) */}
              <div className="lab-scribe" onClick={() => { loadScribe(); setScribeIndex(0); setScribeOpen(true) }} title="Open your Chronicle" style={{ ['--accent']: DOMAIN.scribe } as React.CSSProperties}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center', marginBottom: '5px' }}>
                  <IconBook size={13} color={DOMAIN.scribe} /><span style={{ fontSize: '9px', letterSpacing: '0.22em', color: DOMAIN.scribe, fontWeight: 700, textShadow: `0 0 10px ${DOMAIN.scribe}55` }}>SCRIBE</span><span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)' }}>· {scribeLatest && scribeLatest.title ? scribeLatest.title : 'your chronicle'}</span>
                </div>
                <p style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '13px', color: 'rgba(236,228,205,0.78)', lineHeight: 1.6, margin: 0, textAlign: 'center', maxWidth: '900px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {(() => {
                    const full = scribeLatest?.narrative?.trim()
                    if (!full) return 'Your chronicle begins as you live the day — talk, build, train, and the Scribe will set it down as your story.'
                    // Ribbon = teaser only: first ~2 sentences + an ellipsis hinting at what's still to
                    // come. The full chapter lives in the Chronicle (click the ribbon to unroll it).
                    const sentences = full.match(/[^.!?]+[.!?]+(?:\s|$)/g)
                    const snippet = (sentences ? sentences.slice(0, 2).join(' ') : full).trim()
                    return snippet.length < full.length ? `${snippet} …` : snippet
                  })()}
                </p>
              </div>

            </div>
          </div>
        )}
      </main>

      {/* Mobile bottom tab bar — hidden on desktop, visible on mobile */}
      {!chatOpen && (
        <div
          className="mobile-tab-bar"
          style={{
            display: 'none',
            flexShrink: 0,
            zIndex: 20,
            borderTop: `0.5px solid ${cfg.border}`,
            background: 'rgba(3,3,10,0.92)',
            backdropFilter: 'blur(16px)',
          }}
        >
          {(['dashboard', 'chat'] as const).map(tab => {
            const isActive = tab === 'chat' ? mainDrawerOpen : !mainDrawerOpen
            return (
            <button
              key={tab}
              onClick={() => { if (tab === 'chat') { loadSessions('main'); setMainDrawerOpen(true) } else { setMainDrawerOpen(false) } }}
              style={{
                flex: 1,
                padding: '10px 12px 14px',
                background: 'transparent',
                border: 'none',
                borderTop: `2px solid ${isActive ? accentHex : 'transparent'}`,
                color: isActive ? accentHex : 'rgba(255,255,255,0.28)',
                fontSize: '9px',
                letterSpacing: '0.16em',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontFamily: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span style={{ fontSize: '16px', lineHeight: 1 }}>
                {tab === 'dashboard' ? '⊞' : '◎'}
              </span>
              {tab === 'dashboard' ? 'DASHBOARD' : 'SPECTRE'}
            </button>
          )})}
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer" style={{
        position: 'relative', zIndex: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 24px',
        borderTop: `0.5px solid ${cfg.border}`,
        background: 'rgba(3,3,10,0.75)',
        backdropFilter: 'blur(16px)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '10px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.2)' }}>
          THE DIAGRAM · v4
        </span>
      </footer>

      {/* Main page conversation drawer — slides in from the left, overlays (never
          reflows) the bento grid. Click-catcher outside it or Escape dismisses. */}
      {!chatOpen || activeFolder === 'main' ? (
        <>
          {mainDrawerOpen && (
            <div onClick={() => setMainDrawerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 48, background: 'transparent' }} />
          )}
          <div
            style={{
              position: 'fixed', top: 0, left: 0, bottom: 0, width: 'min(460px, 92vw)', zIndex: 49,
              background: '#0A0E1A', borderRight: '0.5px solid rgba(255,255,255,0.08)',
              transform: mainDrawerOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.22s ease',
              display: 'flex', flexDirection: 'column', padding: '16px 14px', gap: '10px',
            }}
          >
            <span style={{ fontSize: '10px', letterSpacing: '0.2em', color: accentHex, fontWeight: 700, flexShrink: 0 }}>
              SPECTRE · CONVERSATIONS
            </span>
            <div style={{ flexShrink: 0, maxHeight: '30%', overflowY: 'auto' }}>
              <SessionList
                sessions={sessions['main'] ?? []}
                activeId={activeSessionId['main'] ?? null}
                onSelect={id => selectSession('main', id)}
                onNew={() => startNewSession('main')}
                accentHex={accentHex}
                cfg={cfg}
                searchScope="main"
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {messagesList(true)}
              {chatInputBar}
            </div>
          </div>
        </>
      ) : null}

      {/* SCRIBE — the Chronicle. Deliberately breaks the neon dashboard vibe: it should feel like
          unrolling a scroll — aged parchment, sepia ink, serif throughout, fleuron dividers, edges
          that fade like curled ends. Dated chapters, newest first. */}
      {librarianOpen && (() => {
        const LIB = '#C69A3C'
        const plan = librarianPlan
        const actions = plan?.actions ?? []
        const applied = plan?.status === 'applied'
        const pending = actions.filter(a => a.status === 'pending')
        const approvedCount = pending.filter(a => librarianApproved.has(a.id)).length
        const projName = nodes.find(n => n.id === librarianNodeId)?.name ?? 'this project'
        const groups: { key: LibrarianAction['op']; label: string }[] = [
          { key: 'move', label: 'File into folders' },
          { key: 'create_folder', label: 'New folders' },
          { key: 'archive', label: 'Archive' },
          { key: 'merge', label: 'Merge duplicates' },
          { key: 'rename', label: 'Rename' },
        ]
        const destOf = (a: LibrarianAction): string => {
          const e = librarianEdits[a.id]
          if (e) { if (e.target_folder_id !== undefined) return e.target_folder_id ? (librarianFolders.find(f => f.id === e.target_folder_id)?.title ?? 'folder') : 'Top level'; if (e.target_new_folder) return `${e.target_new_folder} (new)` }
          if (a.target_folder_id) return librarianFolders.find(f => f.id === a.target_folder_id)?.title ?? a.target_label ?? 'folder'
          if (a.target_new_folder) return `${a.target_new_folder} (new)`
          return a.target_label ?? 'Top level'
        }
        const label = (a: LibrarianAction): string => {
          if (a.op === 'move') return `${a.doc_title}  →  ${destOf(a)}`
          if (a.op === 'create_folder') return `New folder “${a.folder_name}”`
          if (a.op === 'archive') return `Archive “${a.doc_title}”  ·  ${a.reason}`
          if (a.op === 'merge') return `Merge ${(a.doc_titles || []).length} docs → “${a.merge_into_title}”`
          if (a.op === 'rename') return `“${a.doc_title}”  →  “${a.new_title}”`
          return a.op
        }
        const moveSelect = (a: LibrarianAction) => {
          const e = librarianEdits[a.id]
          let cur = 'loose'
          if (e) cur = e.target_folder_id !== undefined ? (e.target_folder_id ? `f:${e.target_folder_id}` : 'loose') : (e.target_new_folder ? `n:${e.target_new_folder}` : 'loose')
          else cur = a.target_folder_id ? `f:${a.target_folder_id}` : a.target_new_folder ? `n:${a.target_new_folder}` : 'loose'
          const newNames = new Set<string>()
          actions.forEach(x => { if (x.op === 'create_folder' && x.folder_name) newNames.add(x.folder_name) })
          if (cur.startsWith('n:')) newNames.add(cur.slice(2))
          return (
            <select value={cur} onChange={ev => {
              const v = ev.target.value
              if (v === '__new') { const name = window.prompt('New folder name:')?.trim(); if (name) redirectLibrarianMove(a.id, { target_new_folder: name }) }
              else if (v === 'loose') redirectLibrarianMove(a.id, { target_folder_id: '' })
              else if (v.startsWith('f:')) redirectLibrarianMove(a.id, { target_folder_id: v.slice(2) })
              else if (v.startsWith('n:')) redirectLibrarianMove(a.id, { target_new_folder: v.slice(2) })
            }}
              onClick={e => e.stopPropagation()}
              style={{ marginTop: '5px', fontSize: '11px', color: 'rgba(255,255,255,0.75)', background: 'rgba(255,255,255,0.04)', border: `1px solid ${LIB}44`, borderRadius: '6px', padding: '3px 6px', maxWidth: '100%' }}>
              {librarianFolders.map(f => <option key={f.id} value={`f:${f.id}`} style={{ color: '#000' }}>{f.title}</option>)}
              {[...newNames].map(nm => <option key={`n${nm}`} value={`n:${nm}`} style={{ color: '#000' }}>{nm} (new)</option>)}
              <option value="loose" style={{ color: '#000' }}>Leave loose</option>
              <option value="__new" style={{ color: '#000' }}>＋ New folder…</option>
            </select>
          )
        }
        return (
          <div onClick={() => setLibrarianOpen(false)} className="animate-fadeIn"
            style={{ position: 'fixed', inset: 0, zIndex: 72, display: 'flex', justifyContent: 'flex-end', background: 'rgba(3,6,16,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            <div onClick={e => e.stopPropagation()} className="animate-slideInRight"
              style={{ width: 'min(500px, 96vw)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
                background: 'linear-gradient(180deg, rgba(11,16,34,0.985), rgba(6,10,24,0.985))', borderLeft: `1px solid ${LIB}55`, boxShadow: '-26px 0 64px rgba(0,0,0,0.55)' }}>
              {/* header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 12px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                    <IconBook size={17} color={LIB} />
                    <span style={{ fontSize: '13px', letterSpacing: '0.26em', color: LIB, fontWeight: 700, textTransform: 'uppercase' }}>The Librarian</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {projName}{plan?.summary ? `  ·  ${plan.summary}` : ''}{plan?.model ? `  ·  ${plan.model.includes('gpt-oss') ? 'local' : 'Haiku'}` : ''}
                  </div>
                </div>
                <button onClick={() => setLibrarianOpen(false)} aria-label="Close"
                  style={{ width: '28px', height: '28px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', color: 'rgba(255,255,255,0.6)', background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '7px', cursor: 'pointer' }}>✕</button>
              </div>

              {/* body */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {librarianResult && (
                  <div style={{ margin: '12px 16px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(29,158,117,0.12)', border: '1px solid rgba(29,158,117,0.4)', color: '#7fe3c0', fontSize: '12px' }}>{librarianResult}</div>
                )}
                {librarianBusy && !plan ? (
                  <div style={{ padding: '60px 24px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>Reading your documents…</div>
                ) : !plan ? (
                  <div style={{ padding: '44px 24px', textAlign: 'center' }}>
                    <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '13px', lineHeight: 1.7, marginBottom: '18px' }}>Let the Librarian read {projName}’s documents and propose how to tidy them. Nothing moves until you approve it.</div>
                    <button onClick={() => librarianNodeId && runLibrarian(librarianNodeId)} disabled={librarianBusy}
                      style={{ fontSize: '12px', letterSpacing: '0.08em', color: '#1a1205', background: LIB, border: 'none', borderRadius: '8px', padding: '9px 18px', cursor: 'pointer', fontWeight: 600 }}>✦ Tidy this project</button>
                  </div>
                ) : actions.length === 0 ? (
                  <div style={{ padding: '44px 24px', textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>Already tidy — nothing to organize.</div>
                ) : (
                  groups.map(gr => {
                    const items = actions.filter(a => a.op === gr.key)
                    if (!items.length) return null
                    return (
                      <div key={gr.key}>
                        <div style={{ padding: '12px 16px 5px', fontSize: '10px', letterSpacing: '0.16em', color: `${LIB}cc`, textTransform: 'uppercase', fontWeight: 600 }}>{gr.label} ({items.length})</div>
                        {items.map(a => (
                          <div key={a.id} style={{ display: 'flex', gap: '10px', padding: '9px 16px', borderTop: '1px solid rgba(255,255,255,0.045)', opacity: a.status === 'applied' ? 0.45 : 1 }}>
                            <input type="checkbox" checked={librarianApproved.has(a.id)} disabled={applied || a.status !== 'pending'} onChange={() => toggleLibrarianApprove(a.id)} style={{ marginTop: '2px', accentColor: LIB, cursor: 'pointer', flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <span style={{ wordBreak: 'break-word' }}>{label(a)}</span>
                                <span style={{ fontSize: '8.5px', letterSpacing: '0.08em', padding: '1px 5px', borderRadius: '4px', fontWeight: 700, color: a.confidence === 'high' ? '#1a1205' : '#E0A94F', background: a.confidence === 'high' ? LIB : 'transparent', border: a.confidence === 'high' ? 'none' : '1px solid #E0A94F66' }}>{a.confidence.toUpperCase()}</span>
                                {a.escalated && <span title="Reviewed by Claude Haiku" style={{ fontSize: '10px' }}>🛡</span>}
                                {a.status === 'applied' && <span style={{ fontSize: '9px', color: '#7fe3c0' }}>✓ done</span>}
                              </div>
                              {a.why && <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.4)', marginTop: '3px', lineHeight: 1.5 }}>{a.why}</div>}
                              {a.note && <div style={{ fontSize: '10px', color: /skip/i.test(a.note) ? '#E0A94F' : 'rgba(255,255,255,0.4)', marginTop: '3px', fontStyle: 'italic', lineHeight: 1.5 }}>{a.note}</div>}
                              {a.op === 'move' && !applied && a.status === 'pending' && moveSelect(a)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })
                )}
              </div>

              {/* footer */}
              {plan && actions.length > 0 && (
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  {applied ? (
                    <>
                      <button onClick={() => librarianNodeId && runLibrarian(librarianNodeId)} disabled={librarianBusy}
                        style={{ fontSize: '12px', color: LIB, background: 'transparent', border: `1px solid ${LIB}66`, borderRadius: '8px', padding: '8px 14px', cursor: 'pointer' }}>↻ Run again</button>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => setLibrarianOpen(false)} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer' }}>Close</button>
                    </>
                  ) : (
                    <>
                      <button onClick={applyLibrarian} disabled={librarianBusy || approvedCount === 0}
                        style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', color: approvedCount ? '#1a1205' : 'rgba(255,255,255,0.35)', background: approvedCount ? LIB : 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: approvedCount ? 'pointer' : 'default' }}>
                        {librarianBusy ? 'Applying…' : `✓ Apply ${approvedCount} approved`}</button>
                      <button onClick={() => librarianNodeId && runLibrarian(librarianNodeId)} disabled={librarianBusy} title="Regenerate the plan"
                        style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', borderRadius: '8px', padding: '9px 12px', cursor: 'pointer' }}>↻</button>
                      <div style={{ flex: 1 }} />
                      <button onClick={dismissLibrarian} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Dismiss</button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {mapOpen && (
        <MapOverlay
          nodeId={mapOpen.nodeId}
          nodeName={mapOpen.name}
          cfg={cfg}
          onClose={() => setMapOpen(null)}
          onChange={loadDashTasks}
        />
      )}

      {/* RHYTHM — the evening wind-down offer. Card = the invitation;
          chip = snoozed-to-boundary (a quiet moon, zero re-pings). Declining is honored silently. */}
      {windDownOffer === 'card' && !windDownOpen && (
        <div className="animate-fadeIn" style={{ position: 'fixed', right: '22px', bottom: '22px', zIndex: 75, width: '300px', padding: '16px 18px', background: 'rgba(8,10,22,0.96)', border: '0.5px solid rgba(201,169,106,0.45)', borderRadius: '14px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', backdropFilter: 'blur(12px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <IconMoon size={15} color="#C9A96A" stroke={1.6} />
            <span style={{ fontSize: '11px', letterSpacing: '0.22em', color: '#C9A96A', fontWeight: 700 }}>WIND-DOWN</span>
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', lineHeight: 1.5, marginBottom: '14px' }}>
            Time to close the day. The unfinished thing goes on tomorrow&rsquo;s list — not on tonight.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setWindDownOffer(null); setWindDownOpen(true) }} style={{ flex: 1, padding: '8px 0', background: 'rgba(201,169,106,0.16)', border: '0.5px solid rgba(201,169,106,0.55)', borderRadius: '9px', color: '#E8D5AC', fontSize: '11px', letterSpacing: '0.14em', fontWeight: 700, cursor: 'pointer' }}>BEGIN</button>
            <button onClick={() => setWindDownOffer('chip')} style={{ flex: 1, padding: '8px 0', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '9px', color: 'rgba(255,255,255,0.55)', fontSize: '11px', cursor: 'pointer' }}>Finish this block first</button>
          </div>
          <button onClick={() => { const dk = localDateStr(Date.now()); localStorage.setItem(`rhythm_dismissed_${dk}`, '1'); try { const arr = JSON.parse(localStorage.getItem('rhythm_declines') || '[]'); arr.push(dk); localStorage.setItem('rhythm_declines', JSON.stringify(arr.slice(-30))) } catch { /* decline history is best-effort */ } setWindDownOffer(null) }} style={{ marginTop: '8px', width: '100%', padding: '4px 0', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.28)', fontSize: '10px', cursor: 'pointer' }}>not tonight</button>
        </div>
      )}
      {windDownOffer === 'chip' && !windDownOpen && (
        <button className="animate-fadeIn" title="Wind-down is waiting" onClick={() => { setWindDownOffer(null); setWindDownOpen(true) }}
          style={{ position: 'fixed', right: '22px', bottom: '22px', zIndex: 75, width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(8,10,22,0.95)', border: '0.5px solid rgba(201,169,106,0.5)', borderRadius: '50%', cursor: 'pointer', boxShadow: '0 6px 24px rgba(0,0,0,0.45)' }}>
          <IconMoon size={18} color="#C9A96A" stroke={1.6} />
        </button>
      )}
      {windDownOpen && <WindDownSurface onClose={() => setWindDownOpen(false)} modelId={selectedModel} speak={speakOneOff} />}

      {/* SECRETARY PROPOSAL pop-out: a corner card wherever the user is; expand to review
          + apply per item. No reopening the map. The review dialog portals to <body>. */}
      {secPop && !secReviewOpen && createPortal(
        <div className="animate-fadeIn" style={{ position: 'fixed', right: '22px', bottom: '22px', zIndex: 78, width: '300px', padding: '15px 17px', background: 'rgba(10,14,32,0.98)', border: '0.5px solid rgba(127,119,221,0.5)', borderRadius: '13px', boxShadow: '0 12px 40px rgba(0,0,0,0.55)', backdropFilter: 'blur(12px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '7px' }}>
            <IconSparkles size={14} color="#9B93E8" />
            <span style={{ fontSize: '10px', letterSpacing: '0.16em', color: '#9B93E8', fontWeight: 700 }}>{`SECRETARY · ${secPop.nodeName.toUpperCase()}`}</span>
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)', lineHeight: 1.45, marginBottom: '12px' }}>
            {`${secPop.actions.length} change${secPop.actions.length === 1 ? '' : 's'} drafted${secPop.summary ? ` — ${secPop.summary}` : ''}. Nothing moves until you say so.`}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => setSecReviewOpen(true)} style={{ flex: 1, padding: '8px 0', background: 'rgba(127,119,221,0.18)', border: '0.5px solid rgba(127,119,221,0.55)', borderRadius: '9px', color: '#C4BEF5', fontSize: '11px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer' }}>REVIEW</button>
            <button onClick={() => void secResolve('dismiss')} style={{ padding: '8px 14px', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '9px', color: 'rgba(255,255,255,0.5)', fontSize: '11px', cursor: 'pointer' }}>Dismiss</button>
          </div>
        </div>, document.body)}
      {secPop && secReviewOpen && createPortal(
        <div onClick={() => setSecReviewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,4,12,0.6)', backdropFilter: 'blur(6px)' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(520px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'rgba(10,14,32,0.98)', border: '0.5px solid rgba(127,119,221,0.4)', borderRadius: '14px', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ padding: '16px 20px 12px', borderBottom: `0.5px solid ${cfg.border}` }}>
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)', fontWeight: 700, letterSpacing: '0.05em' }}>{`SECRETARY PROPOSAL · ${secPop.nodeName}`}</div>
              <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>{`${secPop.summary || 'Structural changes'} · nothing changes until you apply.`}</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
              {secPop.actions.map((a, i) => (
                <div key={i} onClick={() => setSecApproved(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', cursor: 'pointer' }}>
                  <span style={{ width: '15px', height: '15px', flexShrink: 0, border: `1.5px solid ${secApproved.has(i) ? '#9B93E8' : 'rgba(255,255,255,0.3)'}`, borderRadius: '4px', background: secApproved.has(i) ? '#9B93E8' : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{secApproved.has(i) && <IconCheck size={11} color="#0b0e1a" />}</span>
                  <span style={{ fontSize: '12.5px', color: secApproved.has(i) ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.5)', flex: 1 }}>{describeSecretaryAction(a)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 20px', borderTop: `0.5px solid ${cfg.border}` }}>
              <button onClick={() => void secResolve('apply')} disabled={secApproved.size === 0}
                style={{ fontSize: '12px', fontWeight: 700, color: secApproved.size ? '#0b0e1a' : 'rgba(255,255,255,0.3)', background: secApproved.size ? '#9B93E8' : 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '8px', padding: '9px 18px', cursor: secApproved.size ? 'pointer' : 'default' }}>{`Apply ${secApproved.size}`}</button>
              <div style={{ flex: 1 }} />
              <button onClick={() => void secResolve('dismiss')} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '9px 16px', cursor: 'pointer' }}>Dismiss</button>
              <button onClick={() => setSecReviewOpen(false)} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>, document.body)}

      {/* Global rest-timer chip: the countdown follows the user anywhere in the Diagram. */}
      {restTimer && activeFolder !== 'training' && <RestChip timer={restTimer} />}

      {/* Voice shimmer: the conversation panel visibly carries the live voice. */}
      <style>{`
        @keyframes voiceShimmer {
          0%, 100% { box-shadow: 0 0 18px -6px rgba(56,189,248,0.4), inset 0 0 24px -16px rgba(56,189,248,0.3); border-color: rgba(56,189,248,0.4); }
          50% { box-shadow: 0 0 36px -4px rgba(56,189,248,0.7), inset 0 0 34px -12px rgba(56,189,248,0.5); border-color: rgba(56,189,248,0.85); }
        }
        .voice-shimmer { animation: voiceShimmer 2.6s ease-in-out infinite; }
      `}</style>

      {/* FULL-PAGE TASKS + NOTEPADS */}
      {tasksFullOpen && (
        <TasksFullView
          cfg={cfg}
          notepads={notepads}
          nodeNames={Object.fromEntries(nodes.filter(n => n.level === 'hand').map(n => [n.id, n.name]))}
          onClose={() => setTasksFullOpen(false)}
          onChanged={loadDashTasks}
          onOpenNotepad={id => setOpenNotepadId(id)}
        />
      )}
      {notepadsFullOpen && (
        <NotepadsFullView
          cfg={cfg}
          notepads={notepads}
          onClose={() => setNotepadsFullOpen(false)}
          onOpen={id => setOpenNotepadId(id)}
          expandedId={expandedNotepadId}
          onToggleExpanded={id => toggleNotepadExpanded(id)}
          onNew={async () => {
            try {
              const r = await fetch('/api/notepads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New notepad' }) })
              const d = await r.json().catch(() => null)
              await loadNotepads()
              if (d?.notepad?.id) setOpenNotepadId(d.notepad.id)
            } catch { /* next tap retries */ }
          }}
        />
      )}

      {/* NOTEPADS — the whiteboard modal */}
      {openNotepadId && (() => {
        const np = notepads.find(n => n.id === openNotepadId)
        if (!np) return null
        return (
          <NotepadModal
            notepad={np}
            accent={DOMAIN.notes}
            dirty={notepadDirty}
            onLinked={() => { void loadDashTasks() }}
            onPatch={p => patchNotepadLocal(np.id, p)}
            expanded={expandedNotepadId === np.id}
            onToggleExpanded={() => toggleNotepadExpanded(np.id)}
            onArchive={() => {
              void fetch('/api/notepads', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: np.id, is_archived: true }) }).then(() => loadNotepads())
              if (expandedNotepadId === np.id) toggleNotepadExpanded(null)
              setOpenNotepadId(null)
            }}
            onClose={() => { void saveNotepadNow(np.id); setOpenNotepadId(null) }}
          />
        )
      })()}

      {scribeOpen && (
        <div onClick={() => setScribeOpen(false)} className="animate-fadeIn"
          style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            // Spectre dreamscape, blurred: the diagram shows softly behind (backdrop-filter), tinted
            // dark-blue with the same cyan/violet glows as the dashboard + a gentle vignette so the
            // scroll reads as the centre of the room — not stranded on a black void.
            background: 'radial-gradient(ellipse 68% 52% at 50% 26%, rgba(14,165,233,0.12), transparent 66%), radial-gradient(ellipse 46% 44% at 84% 80%, rgba(168,85,247,0.07), transparent 70%), radial-gradient(ellipse 42% 40% at 14% 78%, rgba(16,185,129,0.05), transparent 72%), radial-gradient(ellipse 75% 70% at 50% 50%, rgba(4,7,18,0.30) 36%, rgba(2,4,12,0.66) 100%)',
            backdropFilter: 'blur(28px) saturate(1.15)', WebkitBackdropFilter: 'blur(28px) saturate(1.15)' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(880px, 92vw)', height: '96vh', margin: '2vh 0', display: 'flex', flexDirection: 'column', overflow: 'hidden',
              fontFamily: 'Georgia, "Times New Roman", serif', borderRadius: '5px', border: '1px solid rgba(120,90,40,0.35)',
              background: 'repeating-linear-gradient(0deg, rgba(120,90,40,0.018) 0px, rgba(120,90,40,0.018) 1px, transparent 1px, transparent 4px), linear-gradient(170deg, #efe7d2 0%, #e9ddc1 45%, #e3d4b2 100%)',
              boxShadow: '0 34px 90px rgba(0,0,0,0.62), inset 0 0 70px rgba(110,75,28,0.20), inset 0 0 4px rgba(80,55,20,0.5)' }}>
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 40px 14px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
                <IconBook size={18} color="#7a5a1e" />
                <span style={{ fontSize: '15px', letterSpacing: '0.34em', color: '#5a4216', fontWeight: 700, textTransform: 'uppercase' }}>The Chronicle</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button onClick={refreshScribe} disabled={scribeRefreshing} title="Rewrite today's chapter from scratch"
                  style={{ fontFamily: 'Georgia, serif', fontSize: '11px', letterSpacing: '0.12em', color: scribeRefreshing ? '#a8966c' : '#6a4f1c', background: 'transparent', border: '1px solid rgba(120,90,40,0.4)', borderRadius: '6px', padding: '5px 12px', cursor: scribeRefreshing ? 'default' : 'pointer' }}>{scribeRefreshing ? 'WRITING…' : '↻ REFRESH'}</button>
                <button onClick={() => setScribeOpen(false)} aria-label="Close"
                  style={{ width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', color: '#6a4f1c', background: 'transparent', border: '1px solid rgba(120,90,40,0.4)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'Georgia, serif' }}>✕</button>
              </div>
            </div>
            <div style={{ flexShrink: 0, margin: '0 40px', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(120,90,40,0.45) 20%, rgba(120,90,40,0.45) 80%, transparent)' }} />
            {scribeEntries.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: '16px', color: 'rgba(90,66,22,0.62)', lineHeight: 1.8, padding: '0 50px' }}>
                The chronicle is yet unwritten. Live the day — speak, build, train — and the Scribe will set down your story here, chapter by chapter.
              </div>
            ) : (() => {
              // Book pager: ONE day per page. ‹ turns to the older day (left), › to the newer (right);
              // a single long day scrolls vertically within its own page instead of pushing prior days away.
              const idx = Math.min(Math.max(scribeIndex, 0), scribeEntries.length - 1)
              const e = scribeEntries[idx]
              const dateLabel = (scribeToday && e.date === scribeToday) ? 'TODAY' : new Date(`${e.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              const olderEnabled = idx < scribeEntries.length - 1   // older = further into the newest-first array
              const newerEnabled = idx > 0
              const turn = (glyph: string, title: string, go: () => void, enabled: boolean) => (
                <button onClick={() => { if (enabled) go() }} disabled={!enabled} title={title} aria-label={title}
                  style={{ width: '34px', height: '34px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontFamily: 'Georgia, serif', color: enabled ? '#6a4f1c' : 'rgba(120,90,40,0.22)', background: 'transparent', border: `1px solid ${enabled ? 'rgba(120,90,40,0.4)' : 'rgba(120,90,40,0.13)'}`, borderRadius: '8px', cursor: enabled ? 'pointer' : 'default' }}>{glyph}</button>
              )
              return (
                <>
                  {/* page navigation row */}
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '20px', padding: '14px 40px 4px' }}>
                    {turn('‹', 'Older day', () => setScribeIndex(idx + 1), olderEnabled)}
                    <div style={{ minWidth: '240px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '11px', letterSpacing: '0.22em', color: 'rgba(120,90,40,0.9)', textTransform: 'uppercase' }}>{dateLabel}</span>
                        {e.status === 'live' && <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: '#7a5a1e', border: '1px solid rgba(120,90,40,0.5)', borderRadius: '3px', padding: '1px 6px' }}>LIVE</span>}
                      </div>
                      <div style={{ fontSize: '9px', letterSpacing: '0.18em', color: 'rgba(120,90,40,0.5)', marginTop: '4px' }}>{scribeEntries.length - idx} / {scribeEntries.length}</div>
                    </div>
                    {turn('›', 'Newer day', () => setScribeIndex(idx - 1), newerEnabled)}
                  </div>
                  {/* the day's page — a long day scrolls here; key re-fades on a page turn */}
                  <div key={idx} className="animate-fadeIn" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 40px 70px',
                    WebkitMaskImage: 'linear-gradient(180deg, transparent 0, #000 3%, #000 96%, transparent 100%)', maskImage: 'linear-gradient(180deg, transparent 0, #000 3%, #000 96%, transparent 100%)' }}>
                    <div style={{ maxWidth: '660px', margin: '0 auto' }}>
                      {e.title && <div style={{ fontSize: '24px', color: '#3a2a10', fontWeight: 700, marginBottom: '14px', lineHeight: 1.25 }}>{e.title}</div>}
                      {/* pre-wrap preserves the blank line between appended passages (morning/afternoon/
                          night movements) so the day's running story reads as paragraphs. */}
                      <p style={{ fontSize: '16px', lineHeight: 1.85, color: '#3b2f1a', margin: 0, whiteSpace: 'pre-wrap' }}>{e.narrative}</p>
                    </div>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* Arm / Hand deletion confirmation. */}
      {confirmDelete && (
        <div
          onClick={() => setConfirmDelete(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="animate-fadeIn"
            style={{ width: '100%', maxWidth: '360px', background: '#0A0E1A', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px' }}
          >
            <span style={{ fontSize: '11px', letterSpacing: '0.2em', color: '#F87171', fontWeight: 700 }}>
              DELETE {confirmDelete.level.toUpperCase()}
            </span>
            <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', lineHeight: 1.55 }}>
              Delete <strong style={{ color: 'rgba(255,255,255,0.92)' }}>{confirmDelete.name}</strong>? This cannot be undone.
              {confirmDelete.level === 'arm' && (
                <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                  All hands inside this arm will also be archived.
                </span>
              )}
              {confirmDelete.level === 'hand' && (
                <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                  All chats and notebooks in this project will also be archived.
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{ padding: '8px 16px', borderRadius: '6px', border: '0.5px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const { id, level } = confirmDelete
                  setConfirmDelete(null)
                  await deleteNodeRemote(id, level)
                  // If we're inside the deleted arm/hand, navigate back to the dashboard.
                  if (activeFolder === id || activeHand === id) {
                    setChatOpen(false)
                    setActiveFolder('main')
                    setActiveHand(null)
                    setActiveProject(null)
                  }
                }}
                style={{ padding: '8px 16px', borderRadius: '6px', border: '0.5px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.12)', color: '#F87171', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Arm / Hand rename modal. */}
      {renamingNode && (
        <RenameModal
          label={renamingNode.level === 'arm' ? 'RENAME ARM' : 'RENAME HAND'}
          initialName={renamingNode.name}
          accentHex={accentHex}
          cfg={cfg}
          onSave={name => { renameNodeRemote(renamingNode.id, name); setRenamingNode(null) }}
          onClose={() => setRenamingNode(null)}
        />
      )}

      {/* Arm / Hand creation modals. */}
      {creatingArm && (
        <CreationModal
          level="arm"
          accentHex={accentHex}
          cfg={cfg}
          onClose={() => setCreatingArm(false)}
          onCreate={async ({ name, template, icon }) => {
            await createNodeRemote({ name, level: 'arm', template, icon })
            setCreatingArm(false)
          }}
        />
      )}
      {creatingHand && (
        <CreationModal
          level="hand"
          accentHex={accentHex}
          cfg={cfg}
          onClose={() => setCreatingHand(false)}
          onCreate={async ({ name, template, icon }) => {
            const created = await createNodeRemote({ name, level: 'hand', parent_id: creatingHandParent, template, icon })
            setCreatingHand(false)
            // New project Hands land on the Projects card list — refresh summaries so the
            // freshly created card shows its "No activity yet" line.
            if (created && creatingHandParent === 'projects') loadProjectSummaries()
          }}
        />
      )}

      {/* Deep-research confirmation gate — research CANNOT fire (button OR voice/chat action)
          without an explicit "Start Research" click here, with an honest cost estimate up front. */}
      {researchConfirm && (
        <div
          onClick={() => setResearchConfirm(null)}
          className="animate-fadeIn"
          style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(440px, 92vw)', padding: '22px', borderRadius: '14px', background: PANEL, border: `0.5px solid ${accentHex}66` }}
          >
            {researchConfirm.plan ? (() => {
              // ── Pre-flight plan review: Spectre proposed a context-aware plan. Show its reasoning +
              // agent directions; Launch fires with the plan, Adjust hands the chat back to Spectre. ──
              const plan = researchConfirm.plan
              const nameById = new Map(plan.agents.map(a => [a.id, a.name]))
              return (
                <>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', marginBottom: '4px' }}>Deep Research Plan</div>
                  <div style={{ fontSize: '11px', letterSpacing: '0.06em', color: accentHex, fontWeight: 700, marginBottom: '14px' }}>SPECTRE ORCHESTRATED</div>
                  {plan.reasoning && <div style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.62)', lineHeight: 1.5, marginBottom: '16px' }}>{plan.reasoning}</div>}
                  <div style={{ fontSize: '10px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '8px' }}>RESEARCH AGENTS ({plan.agents.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', maxHeight: '230px', overflowY: 'auto' }}>
                    {plan.agents.map((a, i) => (
                      <div key={a.id} style={{ display: 'flex', gap: '8px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: accentHex, flexShrink: 0, width: '14px' }}>{i + 1}.</span>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'rgba(255,255,255,0.88)' }}>{a.name}</span>
                          <span style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.45 }}>{a.directive ? ` — ${a.directive}` : ''}</span>
                          {a.dependencies.length > 0 && (
                            <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.38)', marginTop: '2px' }}>└─ Needs: {a.dependencies.map(d => nameById.get(d) ?? `Agent ${d}`).join(', ')}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {plan.synthesis_focus && (
                    <div style={{ marginBottom: '16px' }}>
                      <div style={{ fontSize: '10px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '4px' }}>SYNTHESIS FOCUS</div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.58)', lineHeight: 1.45 }}>{plan.synthesis_focus}</div>
                    </div>
                  )}
                  <ResearchDepthSelector mode={researchConfirm.mode} accentHex={accentHex} onChange={m => setResearchConfirm(c => c ? { ...c, mode: m } : c)} />
                  <div style={{ display: 'flex', gap: '14px', marginBottom: '20px' }}>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Model: <span style={{ color: 'rgba(255,255,255,0.8)' }}>{researchModelLabel(researchConfirm.model)}</span></span>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Est. cost: <span style={{ color: accentHex, fontWeight: 600 }}>{estimateResearchCost(researchConfirm.model)}</span></span>
                  </div>
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => setResearchConfirm(null)}
                      style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit' }}
                    >Cancel</button>
                    <button
                      onClick={() => {
                        const c = researchConfirm; setResearchConfirm(null)
                        // Hand the planning back to Spectre in the chat: a UI pill + a pre-filled prompt.
                        pushTransition(c.scope, '→ Adjusting research plan…')
                        setInput('Please adjust the plan: ')
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                      style={{ fontSize: '13px', color: accentHex, background: 'transparent', border: `0.5px solid ${accentHex}`, borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit' }}
                    >Adjust</button>
                    <button
                      onClick={() => { const c = researchConfirm; setResearchConfirm(null); void startResearch(c.query, c.scope, c.plan, c.sessionId, c.history, c.mode) }}
                      style={{ fontSize: '13px', fontWeight: 700, color: '#fff', background: accentHex, border: 'none', borderRadius: '8px', padding: '8px 18px', cursor: 'pointer', fontFamily: 'inherit' }}
                    >Launch</button>
                  </div>
                </>
              )
            })() : (
              <>
                <div style={{ fontSize: '16px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', marginBottom: '16px' }}>Start Deep Research?</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', width: '62px', flexShrink: 0, paddingTop: '1px' }}>TOPIC</span>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.82)', lineHeight: 1.45 }}>{researchConfirm.query.length > 220 ? researchConfirm.query.slice(0, 220) + '…' : researchConfirm.query}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', width: '62px', flexShrink: 0 }}>MODEL</span>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.82)' }}>{researchModelLabel(researchConfirm.model)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ fontSize: '11px', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', width: '62px', flexShrink: 0, paddingTop: '1px' }}>EST. COST</span>
                    <span style={{ fontSize: '13px', color: accentHex, fontWeight: 600 }}>{estimateResearchCost(researchConfirm.model)} <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>(scales with complexity)</span></span>
                  </div>
                </div>
                <ResearchDepthSelector mode={researchConfirm.mode} accentHex={accentHex} onChange={m => setResearchConfirm(c => c ? { ...c, mode: m } : c)} />
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, marginBottom: '20px' }}>Spectre will determine how many research agents are needed.</div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setResearchConfirm(null)}
                    style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.2)', borderRadius: '8px', padding: '8px 18px', cursor: 'pointer', fontFamily: 'inherit' }}
                  >Cancel</button>
                  <button
                    onClick={() => { const c = researchConfirm; setResearchConfirm(null); void startResearch(c.query, c.scope, undefined, c.sessionId, c.history, c.mode) }}
                    style={{ fontSize: '13px', fontWeight: 700, color: '#fff', background: accentHex, border: 'none', borderRadius: '8px', padding: '8px 18px', cursor: 'pointer', fontFamily: 'inherit' }}
                  >Start Research</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Transient notification — voice-failover outcomes (amber, top-center). */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          className="animate-fadeIn"
          style={{
            position: 'fixed', top: '18px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 9999, maxWidth: '480px', width: 'max-content',
            display: 'flex', alignItems: 'flex-start', gap: '10px',
            padding: '12px 16px', borderRadius: '12px',
            background: 'rgba(20,14,4,0.94)', border: '0.5px solid rgba(245,158,11,0.55)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.5), 0 0 18px rgba(245,158,11,0.18)',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', flexShrink: 0, lineHeight: 1.3 }}>⚡</span>
          <span style={{ fontSize: '12px', lineHeight: 1.5, color: 'rgba(255,255,255,0.9)', letterSpacing: '0.01em' }}>
            {toast}
          </span>
        </div>
      )}

      <style>{`
        *, *::before, *::after { cursor: default; user-select: none; }
        textarea, input { cursor: text; user-select: text; }
        /* Chat message text stays freely selectable/copyable (overrides the global none). */
        .msg-bubble, .msg-bubble * { user-select: text; -webkit-user-select: text; cursor: text; }
        .msg-bubble a { cursor: pointer; }
        .msg-copy, .msg-copy * { cursor: pointer; user-select: none; -webkit-user-select: none; }
        /* Docu-scape editor — the writing surface is a real text field: I-beam cursor, selectable
           text, and click-to-place-cursor (overrides the global cursor:default / user-select:none
           that otherwise made the editor unclickable and showed an arrow instead of an I-beam). */
        .nb-prose, .nb-prose * { cursor: text; user-select: text; -webkit-user-select: text; }
        .nb-prose img { cursor: default; }
        .nb-prose input[type="checkbox"] { cursor: pointer; }
      `}</style>
    </div>
  )
}

/* ── Shared style constants ───────────────────────────────── */

const breadcrumbLinkStyle: React.CSSProperties = {
  background: 'none', border: 'none',
  color: 'rgba(255,255,255,0.35)', fontSize: '10px',
  letterSpacing: '0.18em', cursor: 'pointer',
  fontFamily: 'inherit', padding: 0, transition: 'color 0.2s',
}

const breadcrumbSepStyle: React.CSSProperties = {
  fontSize: '10px', color: 'rgba(255,255,255,0.15)', letterSpacing: '0.1em',
}

/* ── Sub-components ───────────────────────────────────────── */

// Centered creation modal for new Arms (level='arm') and Hands (level='hand'). Same
// dark aesthetic as the rest of The Diagram. Name + template (+ icon for Arms).
// Focus-timer display: m:ss under an hour, h:mm:ss over.
function fmtFocusMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

// ═══ NOTEPADS — the whiteboard modal ═════════════════════════════════════════════
// Plain text, fast, main-page. The bridge to Tasks is one-way and honest: a line can be
// PROMOTED into a real task row (one source of truth — the task is the task, the pad is
// the pad; no text-sync engine, which is the drift trap TASKS-PLAN §1.1 exists to avoid).
// ═══ Full-page TASKS view ═════════════════════════════════════════════════════════
// Task TYPES made visible: note-linked categories (complete as a WHOLE — the list is the
// unit), project lists (roll daily, never "finish"), personal/day tasks, and the
// completed history. Self-fetches all tasks incl. done; toggles PATCH the same rows the
// NOW list derives from.
type FullTask = { id: string; node_id: string; notepad_id?: string; title: string; status: string; due_at: string | null; completed_at?: number | null; spent_ms?: number; step: number | null; lane: number; created_at: number }

function TasksFullView({ cfg, notepads, nodeNames, onClose, onChanged, onOpenNotepad }: {
  cfg: OrbCfg
  notepads: { id: string; title: string }[]
  nodeNames: Record<string, string>
  onClose: () => void
  onChanged: () => void
  onOpenNotepad: (id: string) => void
}) {
  const ACC = '#F59E0B'
  const [all, setAll] = useState<FullTask[]>([])
  const [expandedDone, setExpandedDone] = useState<Set<string>>(new Set())
  const load = useCallback(async () => {
    try { const r = await fetch('/api/tasks?include_done=1'); const d = await r.json(); setAll(Array.isArray(d.tasks) ? d.tasks : []) } catch { /* resting */ }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const toggle = async (t: FullTask) => {
    const next = t.status === 'done' ? 'todo' : 'done'
    setAll(ts => ts.map(x => (x.id === t.id ? { ...x, status: next, completed_at: next === 'done' ? Date.now() : null } : x)))
    try { await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) }); onChanged() } catch { void load() }
  }
  const live = all.filter(t => t.status !== 'dropped')
  const noteIds = [...new Set(live.filter(t => t.notepad_id).map(t => t.notepad_id!))]
  const projIds = [...new Set(live.filter(t => t.node_id && !t.notepad_id && t.status === 'todo').map(t => t.node_id))]
  const personal = live.filter(t => !t.node_id && !t.notepad_id && t.status === 'todo').sort((a, b) => String(a.due_at ?? '9999').localeCompare(String(b.due_at ?? '9999')))
  const doneHistory = live.filter(t => t.status === 'done').sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)).slice(0, 60)
  const padTitle = (id: string) => notepads.find(n => n.id === id)?.title ?? 'Note list'
  const card: React.CSSProperties = { background: 'rgba(255,255,255,0.025)', border: `0.5px solid ${cfg.border}`, borderRadius: '13px', padding: '15px 18px' }
  const label = (text: string, color = 'rgba(255,255,255,0.4)') => (
    <div style={{ fontSize: '9.5px', letterSpacing: '0.24em', color, fontWeight: 700, margin: '20px 0 8px' }}>{text}</div>
  )
  const row = (t: FullTask, extra?: string) => (
    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' }}>
      <span onClick={() => void toggle(t)}
        style={{ width: '14px', height: '14px', borderRadius: '4px', flexShrink: 0, cursor: 'pointer', border: `1px solid ${t.status === 'done' ? ACC : 'rgba(255,255,255,0.3)'}`, background: t.status === 'done' ? `${ACC}33` : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {t.status === 'done' && <IconCheck size={10} color={ACC} />}
      </span>
      <span style={{ fontSize: '12.5px', color: t.status === 'done' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.85)', textDecoration: t.status === 'done' ? 'line-through' : 'none', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
      {(t.spent_ms ?? 0) >= 60_000 && <span style={{ fontSize: '9px', color: '#38BDF8', flexShrink: 0 }}>⏱ {fmtFocusMs(t.spent_ms!)}</span>}
      {t.due_at && <span style={{ fontSize: '10px', color: ACC, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{String(t.due_at).slice(5, 10)}</span>}
      {extra && <span style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>{extra}</span>}
    </div>
  )
  return (
    <div className="animate-fadeIn" style={{ position: 'fixed', inset: 0, zIndex: 70, overflowY: 'auto', background: 'rgba(3,4,12,0.97)', backdropFilter: 'blur(16px)' }}>
      <div style={{ width: 'min(740px, 94vw)', margin: '0 auto', padding: '36px 0 70px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <IconListCheck size={18} color={ACC} />
            <span style={{ fontSize: '13px', letterSpacing: '0.32em', color: ACC, fontWeight: 700 }}>TASKS</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '6px' }}><IconX size={17} /></button>
        </div>
        <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.38)', marginBottom: '10px' }}>
          Note lists complete as a whole. Project lists roll daily — they close out the day and yield the next one. History keeps the receipts.
        </div>

        {/* NOTE LISTS — categories pushed from notepads; the LIST is the unit of done */}
        {noteIds.length > 0 && label('NOTE LISTS', '#7F77DD')}
        {noteIds.map(nid => {
          const ts = live.filter(t => t.notepad_id === nid)
          const open = ts.filter(t => t.status === 'todo')
          const complete = ts.length > 0 && open.length === 0
          if (complete && !expandedDone.has(nid)) {
            return (
              <div key={nid} onClick={() => setExpandedDone(s => new Set(s).add(nid))} style={{ ...card, marginBottom: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', borderColor: 'rgba(127,119,221,0.4)' }}>
                <IconCheck size={15} color="#7F77DD" />
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', flex: 1 }}>{padTitle(nid)}</span>
                <span style={{ fontSize: '10px', letterSpacing: '0.14em', color: '#7F77DD', fontWeight: 700 }}>COMPLETE · {ts.length}/{ts.length}</span>
              </div>
            )
          }
          return (
            <div key={nid} style={{ ...card, marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span onClick={() => onOpenNotepad(nid)} title="Open the notepad" style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', fontWeight: 600, cursor: 'pointer' }}>📝 {padTitle(nid)}</span>
                <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#7F77DD', fontVariantNumeric: 'tabular-nums' }}>{ts.length - open.length}/{ts.length}</span>
              </div>
              {ts.map(t => row(t))}
            </div>
          )
        })}

        {/* PROJECT LISTS — roll daily, never finish */}
        {projIds.length > 0 && label('PROJECTS — ROLL DAILY', '#F59E0B')}
        {projIds.map(pid => {
          const open = live.filter(t => t.node_id === pid && !t.notepad_id && t.status === 'todo')
            .sort((a, b) => ((a.step ?? Infinity) - (b.step ?? Infinity)) || (a.lane - b.lane) || (a.created_at - b.created_at))
          const doneToday = live.filter(t => t.node_id === pid && t.status === 'done' && t.completed_at && new Date(t.completed_at).toDateString() === new Date().toDateString()).length
          return (
            <div key={pid} style={{ ...card, marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>{nodeNames[pid] ?? pid}</span>
                <span style={{ marginLeft: 'auto', fontSize: '9.5px', color: 'rgba(255,255,255,0.35)' }}>{doneToday ? `✓ ${doneToday} today · ` : ''}{open.length} open · rolls to tomorrow</span>
              </div>
              {open.slice(0, 10).map(t => row(t))}
              {open.length > 10 && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', paddingTop: '4px' }}>+{open.length - 10} more on the map</div>}
            </div>
          )
        })}

        {/* PERSONAL / DAY */}
        {personal.length > 0 && label('PERSONAL')}
        {personal.length > 0 && <div style={card}>{personal.map(t => row(t))}</div>}

        {/* HISTORY */}
        {doneHistory.length > 0 && label('COMPLETED — THE RECEIPTS')}
        {doneHistory.length > 0 && (
          <div style={card}>
            {doneHistory.map(t => row(t, `${t.node_id ? (nodeNames[t.node_id] ?? '') + ' · ' : t.notepad_id ? padTitle(t.notepad_id) + ' · ' : ''}${t.completed_at ? new Date(t.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}`))}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══ Full-page NOTEPADS view: every pad, bigger previews ══════════════════
function NotepadsFullView({ cfg, notepads, onClose, onOpen, onNew, expandedId, onToggleExpanded }: {
  cfg: OrbCfg
  notepads: { id: string; title: string; content: string }[]
  onClose: () => void
  onOpen: (id: string) => void
  onNew: () => void
  // Which pad (if any) is enlarged in the dashboard NOTEPADS widget.
  expandedId?: string | null
  onToggleExpanded?: (id: string) => void
}) {
  const ACC = '#38BDF8'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="animate-fadeIn" style={{ position: 'fixed', inset: 0, zIndex: 70, overflowY: 'auto', background: 'rgba(3,4,12,0.97)', backdropFilter: 'blur(16px)' }}>
      <div style={{ width: 'min(880px, 94vw)', margin: '0 auto', padding: '36px 0 70px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <IconNotebook size={18} color={ACC} />
            <span style={{ fontSize: '13px', letterSpacing: '0.32em', color: ACC, fontWeight: 700 }}>NOTEPADS</span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)' }}>brainstorm here — push lists to Tasks when they become real</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '6px' }}><IconX size={17} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {notepads.map(n => {
            const lines = n.content.split('\n').map(l => l.trim()).filter(Boolean)
            return (
              <div key={n.id} onClick={() => onOpen(n.id)} style={{ background: 'rgba(255,255,255,0.025)', border: `0.5px solid ${cfg.border}`, borderRadius: '13px', padding: '15px 17px', cursor: 'pointer', minHeight: '130px', transition: 'border-color 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = `${ACC}66` }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = cfg.border }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '13.5px', color: 'rgba(255,255,255,0.9)', fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                  {onToggleExpanded && (
                    <span role="button"
                      aria-label={expandedId === n.id ? `Collapse ${n.title}` : `Enlarge ${n.title} on the dashboard`}
                      title={expandedId === n.id ? 'Collapse — the widget goes back to all notepads' : 'Keep this pad enlarged in the dashboard NOTEPADS widget'}
                      onClick={e => { e.stopPropagation(); onToggleExpanded(n.id) }}
                      style={{ display: 'inline-flex', alignItems: 'center', color: expandedId === n.id ? ACC : 'rgba(255,255,255,0.35)', flexShrink: 0, cursor: 'pointer' }}>
                      {expandedId === n.id ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
                    </span>
                  )}
                </div>
                {lines.slice(0, 5).map((l, i) => (
                  <div key={i} style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {l}</div>
                ))}
                {lines.length === 0 && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>empty — tap to write</div>}
                {lines.length > 5 && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginTop: '4px' }}>+{lines.length - 5} more lines</div>}
              </div>
            )
          })}
          <div onClick={onNew} style={{ border: `0.5px dashed ${cfg.border}`, borderRadius: '13px', padding: '15px 17px', cursor: 'pointer', minHeight: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>
            <IconPlus size={14} /> new notepad
          </div>
        </div>
      </div>
    </div>
  )
}

function NotepadModal({ notepad, accent, dirty, onPatch, onArchive, onClose, onLinked, expanded, onToggleExpanded }: {
  notepad: { id: string; title: string; content: string }
  accent: string
  dirty: boolean
  onPatch: (patch: { title?: string; content?: string }) => void
  onArchive: () => void
  onClose: () => void
  onLinked?: () => void
  // Keep this pad enlarged in the dashboard's NOTEPADS box after the modal closes.
  expanded?: boolean
  onToggleExpanded?: () => void
}) {
  const [sent, setSent] = useState<Set<number>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Push the WHOLE pad into Tasks as a note-linked category: the list becomes
  // the unit — it shows in the full Tasks view and completes as a whole.
  const [linkState, setLinkState] = useState<'idle' | 'linking' | 'linked'>('idle')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const lines = notepad.content.split('\n').map((raw, i) => ({ text: raw.replace(/^[-*•\s]+/, '').trim(), i })).filter(x => x.text)
  const promote = async (text: string, i: number) => {
    try {
      await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: text, notes: `from notepad "${notepad.title}"` }) })
      setSent(s => new Set(s).add(i))
    } catch { /* stays promotable */ }
  }
  const pushAll = async () => {
    if (linkState !== 'idle' || !lines.length) return
    setLinkState('linking')
    try {
      for (const l of lines) {
        if (sent.has(l.i)) continue
        await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: l.text, notepad_id: notepad.id, notes: `from notepad "${notepad.title}"` }) })
      }
      setSent(new Set(lines.map(l => l.i)))
      setLinkState('linked')
      onLinked?.()
    } catch { setLinkState('idle') }
  }
  return (
    <div className="animate-fadeIn" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,4,12,0.6)', backdropFilter: 'blur(10px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'rgba(8,12,30,0.97)', border: `0.5px solid ${accent}55`, borderRadius: '14px', padding: '18px 20px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <IconNotebook size={15} color={accent} />
          <input
            value={notepad.title}
            onChange={e => onPatch({ title: e.target.value })}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '14px', fontWeight: 600, color: 'rgba(255,255,255,0.9)' }}
          />
          <span style={{ fontSize: '9px', color: dirty ? 'rgba(255,255,255,0.35)' : `${accent}99`, letterSpacing: '0.08em', flexShrink: 0 }}>{dirty ? 'saving…' : 'saved ✓'}</span>
          {onToggleExpanded && (
            <button onClick={onToggleExpanded}
              aria-label={expanded ? 'Collapse on dashboard' : 'Keep enlarged on dashboard'}
              title={expanded ? 'Collapse — the widget goes back to all notepads' : 'Keep this pad enlarged in the dashboard NOTEPADS widget'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, background: expanded ? `${accent}1F` : 'transparent', border: `0.5px solid ${expanded ? `${accent}66` : 'rgba(255,255,255,0.14)'}`, borderRadius: '6px', padding: '3px 7px', color: expanded ? accent : 'rgba(255,255,255,0.45)', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}>
              {expanded ? <IconMinimize size={11} /> : <IconMaximize size={11} />} {expanded ? 'ENLARGED' : 'ENLARGE'}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '4px' }}><IconX size={15} /></button>
        </div>
        <textarea
          value={notepad.content}
          onChange={e => onPatch({ content: e.target.value })}
          placeholder={'take out the trash\npick up groceries\n…one thought per line'}
          autoFocus
          style={{ width: '100%', minHeight: '220px', maxHeight: '44vh', resize: 'vertical', background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.1)', borderRadius: '9px', padding: '10px 12px', color: 'rgba(255,255,255,0.85)', fontSize: '13px', lineHeight: 1.65, outline: 'none', fontFamily: 'inherit' }}
        />
        {lines.length > 0 && (
          <div style={{ marginTop: '10px', overflowY: 'auto', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px' }}>
              <span style={{ fontSize: '9px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.35)' }}>PROMOTE A LINE → REAL TASK</span>
              <button onClick={() => void pushAll()} disabled={linkState !== 'idle'}
                title="Create a task for every line, linked to this pad — the list completes as a whole"
                style={{ marginLeft: 'auto', fontSize: '9.5px', letterSpacing: '0.08em', fontWeight: 700, color: linkState === 'linked' ? '#9B93E8' : '#B9B3F0', background: linkState === 'linked' ? 'transparent' : 'rgba(127,119,221,0.14)', border: `0.5px solid ${linkState === 'linked' ? 'transparent' : 'rgba(127,119,221,0.5)'}`, borderRadius: '7px', padding: '3px 9px', cursor: linkState === 'idle' ? 'pointer' : 'default' }}>
                {linkState === 'linked' ? '✓ LINKED AS TASK LIST' : linkState === 'linking' ? 'linking…' : `⇉ PUSH ALL ${lines.length} → TASK LIST`}
              </button>
            </div>
            {lines.map(l => (
              <div key={l.i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
                <span style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.6)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.text}</span>
                {sent.has(l.i)
                  ? <span style={{ fontSize: '10px', color: accent }}>✓ task</span>
                  : <button onClick={() => void promote(l.text, l.i)} style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: `0.5px solid rgba(255,255,255,0.15)`, borderRadius: '6px', padding: '2px 8px', cursor: 'pointer', flexShrink: 0 }}>→ task</button>}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
          {confirmDelete
            ? <button onClick={onArchive} style={{ fontSize: '10px', color: '#D85A30', background: 'transparent', border: '0.5px solid #D85A3066', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer' }}>really delete?</button>
            : <button onClick={() => setConfirmDelete(true)} style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', background: 'transparent', border: 'none', cursor: 'pointer' }}>delete pad</button>}
        </div>
      </div>
    </div>
  )
}

// ═══ RHYTHM — the wind-down surface ═══════════════════════
// A 10–15 minute HANDOFF, not an hour of screen time: close the loops, glance at the
// chapter, stretch if wanted, then LEAVE the PC. Parts, never a sequence — nothing is
// numbered, timed, or counted (the user authors their own ritual). Deliberately terminal.

const WIND_DOWN_ROUTINE: { name: string; hint: string; seconds: number }[] = [
  { name: 'Neck rolls', hint: 'slow circles, both directions', seconds: 40 },
  { name: 'Shoulder rolls + chest opener', hint: 'roll back, then clasp hands behind you', seconds: 45 },
  { name: 'Wrist + forearm stretch', hint: 'flexors and extensors — the keyboard and mouse hands', seconds: 60 },
  { name: 'Thoracic extension', hint: 'hands behind head, open the upper back', seconds: 45 },
  { name: 'Hip flexor lunge — left', hint: 'the sitting-all-day muscle', seconds: 45 },
  { name: 'Hip flexor lunge — right', hint: 'switch sides, sink slow', seconds: 45 },
  { name: 'Forward fold', hint: 'hamstrings — hang heavy, breathe', seconds: 45 },
  { name: 'Child’s pose', hint: 'long exhales. done.', seconds: 60 },
]

// The spiral session's standing context — rides EVERY call so the protocol survives the
// whole conversation (the kick-off text alone would scroll out of the bounded history).
const SPIRAL_CONTEXT = `[SPIRAL SESSION — late-night overthinking containment]
It is late evening during ${USER_POSS} wind-down. They tapped the spiral button: an anxious or self-doubting loop is loud tonight. This is a private containment session — it never enters the Chronicle.
Protocol:
1. Open warmly in ONE short line, then gently ask what kind of thought it is tonight — doubt ("can I really do this"), comparison ("everyone else is further ahead"), meaning ("will any of this even matter"), or something else.
2. CONTAINMENT, not processing: short turns, grounded, aim to land in under ~10 minutes.
3. Doubt / comparison → help ${USER} pull their own counter-evidence with prompting questions. If they keep an Evidence File notebook (on the North Star node), you may use it as a prompt deck — point them toward what they wrote there rather than reciting it AT them. Never invent accomplishments; ask, and let them say it.
4. Meaning → NEVER answer with accomplishments. Reconnect to what they care about, or just listen.
5. Land softly: end with one small physical suggestion (a few slow breaths, a stretch, a short walk) and give the thought a home — "we can take this apart properly tomorrow, with fresh eyes."
6. Protect sleep: never open new work, never problem-solve projects, keep the temperature low.
You are a calm, supportive companion — not a therapist: no diagnoses or clinical claims. If ${USER} says they are in danger or thinking of hurting themselves, gently encourage them to reach out right away to someone they trust or a local crisis line.`

const SPIRAL_KICKOFF = `${USER_CAP} just tapped the spiral button. Open the session — speak first.`

function WindDownSurface({ onClose, modelId, speak }: { onClose: () => void; modelId: string; speak: (line: string) => void }) {
  const dateKey = localDateStr(Date.now())
  const JSON_HEADERS = { 'Content-Type': 'application/json' }

  // Close the day — open loops become REAL tasks due tomorrow (one source of truth:
  // they land in the NOW list + the wake push for free; no Rhythm-side store exists).
  const [capture, setCapture] = useState('')
  const [captured, setCaptured] = useState<string[]>([])
  const submitCapture = async () => {
    const title = capture.trim()
    if (!title) return
    setCapture('')
    setCaptured(c => [...c, title])
    const tm = new Date(); tm.setDate(tm.getDate() + 1)
    try {
      await fetch('/api/tasks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title, due_at: localDateStr(tm.getTime()) }) })
    } catch { /* offline capture still shows locally; quick-add is the recovery path */ }
  }

  // Tonight's chapter — trigger a fresh regen (the 22:00 checkpoint may still be in
  // flight), then present it. "being written" beats presenting the stale afternoon text.
  const [chapter, setChapter] = useState<{ title: string; narrative: string } | null>(null)
  const [chapterState, setChapterState] = useState<'writing' | 'ready' | 'off'>('writing')
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        await fetch('/api/scribe/generate', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ date: dateKey }) }).catch(() => null)
        const res = await fetch('/api/scribe')
        const data = await res.json().catch(() => null)
        type Entry = { date?: string; title?: string; narrative?: string }
        const entries: Entry[] = Array.isArray(data?.entries) ? data.entries : []
        const entry = entries.find(e => e.date === dateKey) || (data?.latest as Entry | undefined) || null
        if (!dead) {
          if (entry?.narrative) { setChapter({ title: entry.title || 'Today', narrative: entry.narrative }); setChapterState('ready') }
          else setChapterState('off')
        }
      } catch { if (!dead) setChapterState('off') }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey])

  // Stretch — static routine, one countdown. The reorderable builder is deliberately 2c.
  const [stretchIdx, setStretchIdx] = useState(-1)
  const [stretchLeft, setStretchLeft] = useState(0)
  useEffect(() => { if (stretchIdx >= 0) setStretchLeft(WIND_DOWN_ROUTINE[stretchIdx].seconds) }, [stretchIdx])
  useEffect(() => {
    if (stretchIdx < 0) return
    const id = setInterval(() => {
      setStretchLeft(s => {
        if (s > 1) return s - 1
        setStretchIdx(i => (i + 1 < WIND_DOWN_ROUTINE.length ? i + 1 : -1))
        return 0
      })
    }, 1000)
    return () => clearInterval(id)
  }, [stretchIdx])

  // The spiral — zero-friction containment chat. Self-contained: streams straight from
  // /api/spectre/agent under scope 'spiral-main' (excluded from the Chronicle), persists
  // best-effort so nothing is lost, and Spectre speaks FIRST — the user never re-explains.
  const [spiralOpen, setSpiralOpen] = useState(false)
  const [spiralMsgs, setSpiralMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [spiralInput, setSpiralInput] = useState('')
  const [spiralBusy, setSpiralBusy] = useState(false)
  const spiralSessionRef = useRef<string | null>(null)
  const spiralEndRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { spiralEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [spiralMsgs])
  // Voice, both directions: click-to-record → /api/stt → sends as a turn;
  // Spectre's replies speak aloud via the shared TTS element (unlocked — the user clicked to get here).
  const [spiralVoice, setSpiralVoice] = useState(true)
  const [recState, setRecState] = useState<'idle' | 'rec' | 'stt'>('idle')
  const recRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const toggleRec = async () => {
    if (recState === 'rec') { recRef.current?.stop(); return }
    if (recState !== 'idle' || spiralBusy) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      recChunksRef.current = []
      mr.ondataavailable = e => { if (e.data.size) recChunksRef.current.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setRecState('stt')
        try {
          const blob = new Blob(recChunksRef.current, { type: 'audio/webm' })
          const form = new FormData()
          form.append('file', blob, 'audio.webm')
          const res = await fetch('/api/stt', { method: 'POST', body: form })
          const data = await res.json().catch(() => null)
          const text = String(data?.text ?? '').trim()
          if (text) void spiralSend(text, false)
        } catch { /* mic is best-effort; typing still works */ }
        setRecState('idle')
      }
      mr.start()
      recRef.current = mr
      setRecState('rec')
    } catch { setRecState('idle') }
  }

  const spiralSend = async (text: string, hidden: boolean) => {
    if (spiralBusy) return
    setSpiralBusy(true)
    const history = spiralMsgs.filter(m => m.content.trim())
    if (!hidden) setSpiralMsgs(m => [...m, { role: 'user', content: text }])
    setSpiralMsgs(m => [...m, { role: 'assistant', content: '' }])
    // Persistence is fire-and-forget and self-catching — the conversation works regardless.
    void (async () => {
      try {
        if (!spiralSessionRef.current) {
          const r = await fetch('/api/chat/sessions', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ folder_id: 'spiral-main', title: `Spiral — ${dateKey}` }) })
          const d = await r.json().catch(() => null)
          spiralSessionRef.current = d?.session?.id ?? null
        }
        if (spiralSessionRef.current && !hidden) {
          await fetch(`/api/chat/sessions/${spiralSessionRef.current}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ role: 'user', content: text }) })
        }
      } catch { /* private log is best-effort */ }
    })()
    let acc = ''
    try {
      const res = await fetch('/api/spectre/agent', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({
          text, modelId, scope: 'spiral-main', history,
          context: SPIRAL_CONTEXT, skipMemory: hidden,
          now: `Current time: ${new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
        }),
      })
      const reader = res.body?.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (reader) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'text' && ev.delta) {
              acc += ev.delta
              const shown = acc
              setSpiralMsgs(m => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: shown }; return c })
            }
          } catch { /* partial frame */ }
        }
      }
      if (acc && spiralVoice) speak(stripMarkdown(acc))
      if (!acc) setSpiralMsgs(m => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: '…I’m here. Say it however it comes.' }; return c })
    } catch {
      setSpiralMsgs(m => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: 'Connection hiccup — I’m still here. Try again.' }; return c })
    }
    if (acc && spiralSessionRef.current) {
      try { await fetch(`/api/chat/sessions/${spiralSessionRef.current}/messages`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ role: 'assistant', content: acc }) }) } catch { /* best-effort */ }
    }
    setSpiralBusy(false)
  }
  const openSpiral = () => {
    setSpiralOpen(true)
    if (!spiralMsgs.length) void spiralSend(SPIRAL_KICKOFF, true)
  }

  // Tonight's marks (weave item 3) — the night habits live where the night closes.
  const [nightHabits, setNightHabits] = useState<{ id: string; name: string; done: boolean }[]>([])
  useEffect(() => {
    let dead = false
    ;(async () => {
      try {
        const r = await fetch('/api/habits')
        const d = await r.json()
        const today = localDateStr(Date.now())
        const checked = new Set((d.checks ?? []).filter((c: { date: string }) => c.date === today).map((c: { habit_id: string }) => c.habit_id))
        const NIGHT = ['habit-walk', 'habit-read', 'habit-sleep']
        if (!dead) setNightHabits((d.habits ?? []).filter((h: { id: string }) => NIGHT.includes(h.id)).map((h: { id: string; name: string }) => ({ id: h.id, name: h.name, done: checked.has(h.id) })))
      } catch { /* the card simply hides */ }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggleNight = (id: string, done: boolean) => {
    setNightHabits(hs => hs.map(h => (h.id === id ? { ...h, done } : h)))
    void fetch('/api/habits', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ op: done ? 'check' : 'uncheck', id }) }).catch(() => {})
  }

  // Goodnight — the intentional exit. Terminal by design.
  const [goodnight, setGoodnight] = useState(false)
  const sayGoodnight = () => { setGoodnight(true); setTimeout(onClose, 3600) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !goodnight) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goodnight])

  const GOLD = '#C9A96A'
  const card: React.CSSProperties = { background: 'rgba(255,255,255,0.028)', border: '0.5px solid rgba(201,169,106,0.22)', borderRadius: '14px', padding: '18px 20px' }
  const label: React.CSSProperties = { fontSize: '10px', letterSpacing: '0.26em', color: 'rgba(201,169,106,0.85)', fontWeight: 700, marginBottom: '10px' }

  return (
    <div className="animate-fadeIn" style={{ position: 'fixed', inset: 0, zIndex: 70, overflowY: 'auto', background: 'radial-gradient(ellipse 70% 45% at 50% 0%, rgba(201,169,106,0.06), transparent 60%), linear-gradient(180deg, #04050e 0%, #090b18 55%, #0b0d1c 100%)' }}>
      {goodnight ? (
        <div className="animate-fadeIn" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', textAlign: 'center', padding: '24px' }}>
          <IconMoon size={30} color={GOLD} stroke={1.2} />
          <div style={{ fontSize: '22px', color: 'rgba(255,255,255,0.85)', fontWeight: 300, letterSpacing: '0.04em' }}>Goodnight{USER_NAME ? `, ${USER_NAME}` : ''}.</div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.45)', maxWidth: '340px', lineHeight: 1.6 }}>
            The day is closed. Shut the PC down — tomorrow it can wake before you do.
          </div>
        </div>
      ) : (
        <div style={{ width: 'min(680px, 94vw)', margin: '0 auto', padding: '38px 0 60px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <IconMoon size={18} color={GOLD} stroke={1.4} />
              <span style={{ fontSize: '13px', letterSpacing: '0.34em', color: GOLD, fontWeight: 700 }}>WIND-DOWN</span>
              <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: '6px' }}><IconX size={17} /></button>
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.38)', marginBottom: '26px', lineHeight: 1.5 }}>
            Nothing here is a checklist. Take what you need, then leave the screen — the hour belongs to you, not to this page.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Close the day */}
            <div style={card}>
              <div style={label}>CLOSE THE DAY</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', marginBottom: '10px', lineHeight: 1.5 }}>
                The &ldquo;one more thing&rdquo; goes here. It lands on tomorrow&rsquo;s list — tomorrow-you has it covered.
              </div>
              <input
                value={capture}
                onChange={e => setCapture(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submitCapture() }}
                placeholder="what's still open? (Enter to file it for tomorrow)"
                autoFocus
                style={{ width: '100%', padding: '10px 12px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '9px', color: 'rgba(255,255,255,0.85)', fontSize: '13px', outline: 'none' }}
              />
              {captured.length > 0 && (
                <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {captured.map((t, i) => (
                    <div key={i} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)', display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <IconCheck size={13} color={GOLD} /> <span>{t}</span> <span style={{ color: 'rgba(255,255,255,0.25)' }}>→ tomorrow</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tonight's chapter */}
            <div style={card}>
              <div style={label}>TONIGHT&rsquo;S CHAPTER</div>
              {chapterState === 'writing' && <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>The chapter is being written&hellip;</div>}
              {chapterState === 'off' && <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)' }}>The Scribe is resting tonight. The day still counted.</div>}
              {chapterState === 'ready' && chapter && (
                <div style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
                  <div style={{ fontSize: '14px', color: 'rgba(232,213,172,0.9)', marginBottom: '8px' }}>{chapter.title}</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.75, maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{chapter.narrative}</div>
                </div>
              )}
            </div>

            {/* Stretch */}
            <div style={card}>
              <div style={label}>UNKNOT — {'≈'}7 MIN</div>
              {stretchIdx < 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
                    Eight moves for the hands, back, and hips — a long day at the desk feels it tomorrow.
                  </div>
                  <button onClick={() => setStretchIdx(0)} style={{ flexShrink: 0, padding: '8px 16px', background: 'rgba(201,169,106,0.14)', border: `0.5px solid rgba(201,169,106,0.5)`, borderRadius: '9px', color: '#E8D5AC', fontSize: '11px', letterSpacing: '0.12em', fontWeight: 700, cursor: 'pointer' }}>BEGIN</button>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '15px', color: 'rgba(255,255,255,0.85)' }}>{WIND_DOWN_ROUTINE[stretchIdx].name}</span>
                    <span style={{ fontSize: '22px', color: GOLD, fontVariantNumeric: 'tabular-nums', fontWeight: 300 }}>{stretchLeft}s</span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '10px' }}>{WIND_DOWN_ROUTINE[stretchIdx].hint}</div>
                  <div style={{ height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', marginBottom: '12px' }}>
                    <div style={{ height: '100%', width: `${(stretchLeft / WIND_DOWN_ROUTINE[stretchIdx].seconds) * 100}%`, background: GOLD, borderRadius: '2px', transition: 'width 1s linear' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => setStretchIdx(i => (i + 1 < WIND_DOWN_ROUTINE.length ? i + 1 : -1))} style={{ padding: '6px 14px', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.55)', fontSize: '11px', cursor: 'pointer' }}>next</button>
                    <button onClick={() => setStretchIdx(-1)} style={{ padding: '6px 14px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.3)', fontSize: '11px', cursor: 'pointer' }}>stop</button>
                    <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>{stretchIdx + 1} / {WIND_DOWN_ROUTINE.length}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Tonight's marks — the night habits (the ring confirms asleep-by tomorrow) */}
            {nightHabits.length > 0 && (
              <div style={card}>
                <div style={label}>TONIGHT&rsquo;S MARKS</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  {nightHabits.map(h => (
                    <button key={h.id} onClick={() => toggleNight(h.id, !h.done)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '7px 12px', background: h.done ? 'rgba(201,169,106,0.14)' : 'transparent', border: `0.5px solid ${h.done ? 'rgba(201,169,106,0.5)' : 'rgba(255,255,255,0.14)'}`, borderRadius: '9px', color: h.done ? '#E8D5AC' : 'rgba(255,255,255,0.55)', fontSize: '12px', cursor: 'pointer' }}>
                      {h.done ? <IconCheck size={13} color={GOLD} /> : <span style={{ width: '13px' }} />}{h.name}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', marginTop: '8px' }}>no pressure — these are marks, not homework. the ring vouches for bedtime on its own.</div>
              </div>
            )}

            {/* The spiral */}
            <div style={{ ...card, border: spiralOpen ? '0.5px solid rgba(201,169,106,0.45)' : card.border }}>
              <div style={label}>THE SPIRAL</div>
              {!spiralOpen ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
                    If your mind is loud tonight, tap — no explaining needed. This stays out of the Chronicle.
                  </div>
                  <button onClick={openSpiral} style={{ flexShrink: 0, padding: '8px 16px', background: 'rgba(127,119,221,0.12)', border: '0.5px solid rgba(127,119,221,0.5)', borderRadius: '9px', color: '#B9B3F0', fontSize: '11px', letterSpacing: '0.12em', fontWeight: 700, cursor: 'pointer' }}>I&rsquo;M SPIRALING</button>
                </div>
              ) : (
                <div>
                  <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '12px' }}>
                    {spiralMsgs.map((m, i) => (
                      <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '9px 13px', borderRadius: '12px', fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: m.role === 'user' ? 'rgba(201,169,106,0.12)' : 'rgba(255,255,255,0.045)', color: m.role === 'user' ? 'rgba(232,213,172,0.9)' : 'rgba(255,255,255,0.75)', border: '0.5px solid rgba(255,255,255,0.07)' }}>
                        {m.content || <span style={{ opacity: 0.5 }}>&hellip;</span>}
                      </div>
                    ))}
                    <div ref={spiralEndRef} />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      value={spiralInput}
                      onChange={e => setSpiralInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && spiralInput.trim() && !spiralBusy) { const t = spiralInput.trim(); setSpiralInput(''); void spiralSend(t, false) } }}
                      placeholder={recState === 'rec' ? 'listening…' : recState === 'stt' ? 'hearing you…' : spiralBusy ? '…' : 'say it however it comes'}
                      style={{ flex: 1, padding: '9px 12px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '9px', color: 'rgba(255,255,255,0.85)', fontSize: '13px', outline: 'none' }}
                    />
                    <button onClick={() => void toggleRec()} title={recState === 'rec' ? 'Stop and send' : 'Speak instead of typing'} aria-label="Record voice"
                      style={{ width: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: recState === 'rec' ? 'rgba(216,90,48,0.18)' : 'transparent', border: `0.5px solid ${recState === 'rec' ? '#D85A30' : 'rgba(255,255,255,0.14)'}`, borderRadius: '9px', cursor: 'pointer' }}>
                      <IconMicrophone size={15} color={recState === 'rec' ? '#D85A30' : recState === 'stt' ? '#C9A96A' : 'rgba(255,255,255,0.5)'} stroke={1.6} />
                    </button>
                    <button onClick={() => setSpiralVoice(v => !v)} title={spiralVoice ? 'Spectre speaks replies — click to mute' : 'Replies are silent — click to hear Spectre'} aria-label="Toggle spoken replies"
                      style={{ width: '38px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '9px', cursor: 'pointer' }}>
                      {spiralVoice ? <IconVolume size={15} color="#C9A96A" stroke={1.6} /> : <IconVolumeOff size={15} color="rgba(255,255,255,0.35)" stroke={1.6} />}
                    </button>
                    <button onClick={() => setSpiralOpen(false)} title="Land it" style={{ padding: '0 14px', background: 'transparent', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '9px', color: 'rgba(255,255,255,0.5)', fontSize: '11px', cursor: 'pointer' }}>land it</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Goodnight */}
          <button onClick={sayGoodnight} style={{ marginTop: '26px', width: '100%', padding: '13px 0', background: 'rgba(201,169,106,0.1)', border: '0.5px solid rgba(201,169,106,0.4)', borderRadius: '12px', color: '#E8D5AC', fontSize: '12px', letterSpacing: '0.28em', fontWeight: 700, cursor: 'pointer' }}>
            GOODNIGHT
          </button>
          <div style={{ marginTop: '10px', textAlign: 'center', fontSize: '11px', color: 'rgba(255,255,255,0.25)' }}>
            asleep on time — the machine takes it from here
          </div>
        </div>
      )}
    </div>
  )
}

function CreationModal({ level, accentHex, cfg, onCreate, onClose }: {
  level: NodeLevel
  accentHex: string
  cfg: OrbCfg
  onCreate: (payload: { name: string; template: NodeTemplate; icon: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<NodeTemplate>('research')
  const [icon, setIcon] = useState('ti-flask')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 40) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = () => { if (name.trim()) onCreate({ name: name.trim(), template, icon }) }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="animate-fadeIn"
        style={{
          width: '100%', maxWidth: '420px', background: '#0A0E1A',
          border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px',
          padding: '22px', display: 'flex', flexDirection: 'column', gap: '18px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.2em', color: accentHex, fontWeight: 700 }}>
            NEW {level === 'arm' ? 'ARM' : 'HAND'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', display: 'flex' }} aria-label="Close">
            <IconX size={16} stroke={1.6} />
          </button>
        </div>

        <input
          ref={nameRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          placeholder={level === 'arm' ? 'Arm name…' : 'Hand name…'}
          style={{
            background: 'rgba(255,255,255,0.03)', border: `0.5px solid ${cfg.border}`, borderRadius: '6px',
            padding: '10px 12px', color: '#fff', fontSize: '14px', fontFamily: 'inherit', outline: 'none',
          }}
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>TEMPLATE</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {TEMPLATE_CHOICES.map(t => (
              <button
                key={t.value}
                onClick={() => { setTemplate(t.value); setIcon(t.icon) }}
                title={t.desc}
                style={{
                  padding: '6px 12px', borderRadius: '6px', fontSize: '10px', letterSpacing: '0.08em', fontWeight: 700,
                  border: `0.5px solid ${template === t.value ? accentHex : 'rgba(255,255,255,0.1)'}`,
                  background: template === t.value ? cfg.dim : 'transparent',
                  color: template === t.value ? accentHex : 'rgba(255,255,255,0.45)',
                  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                }}
              >
                {t.label.toUpperCase()}
              </button>
            ))}
          </div>
          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)' }}>
            {TEMPLATE_CHOICES.find(t => t.value === template)?.desc}
          </span>
        </div>

        {level === 'arm' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '9px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.5)', fontWeight: 700 }}>ICON</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {ICON_CHOICES.map(ic => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  style={{
                    width: '34px', height: '34px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `0.5px solid ${icon === ic ? accentHex : 'rgba(255,255,255,0.1)'}`,
                    background: icon === ic ? cfg.dim : 'transparent',
                    color: icon === ic ? accentHex : 'rgba(255,255,255,0.45)', cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  <Ti name={ic} size={18} />
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!name.trim()}
          style={{
            width: '100%', padding: '11px', borderRadius: '6px', border: 'none',
            background: name.trim() ? accentHex : 'rgba(255,255,255,0.08)',
            color: name.trim() ? '#03030A' : 'rgba(255,255,255,0.3)',
            fontSize: '11px', letterSpacing: '0.16em', fontWeight: 700,
            cursor: name.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit', transition: 'all 0.15s',
          }}
        >
          CREATE
        </button>
      </div>
    </div>
  )
}

// Inline primer editor shown within an Arm/Hand's session layer (gear icon toggles it).
function PrimerEditor({ node, accentHex, cfg, onSave, onClose }: {
  node: NodeMeta
  accentHex: string
  cfg: OrbCfg
  onSave: (primer: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(node.primer ?? '')
  return (
    <div className="animate-fadeIn" style={{
      ...panelStyleStatic(cfg), padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '9px', letterSpacing: '0.18em', color: accentHex, fontWeight: 700 }}>SPECTRE PRIMER · {node.name.toUpperCase()}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', display: 'flex' }} aria-label="Close">
          <IconX size={14} stroke={1.6} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        rows={5}
        placeholder={TEMPLATE_PRIMERS[node.template] || 'Define this node’s Spectre context…'}
        style={{
          background: 'rgba(255,255,255,0.03)', border: `0.5px solid ${cfg.border}`, borderRadius: '6px',
          padding: '10px', color: 'rgba(255,255,255,0.85)', fontSize: '12px', lineHeight: 1.5,
          fontFamily: 'inherit', outline: 'none', resize: 'vertical', minHeight: '90px',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.04em' }}>{text.length} chars</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setText(TEMPLATE_PRIMERS[node.template])}
            style={{ padding: '6px 10px', borderRadius: '5px', border: `0.5px solid ${cfg.border}`, background: 'transparent', color: 'rgba(255,255,255,0.45)', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            RESET TO DEFAULT
          </button>
          <button
            onClick={() => onSave(text)}
            style={{ padding: '6px 14px', borderRadius: '5px', border: 'none', background: accentHex, color: '#03030A', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  )
}

// Standalone panel style (mirrors Home.panelStyle) for sub-components that need it.
function panelStyleStatic(cfg: OrbCfg, extra?: React.CSSProperties): React.CSSProperties {
  return { background: PANEL, border: `0.5px solid ${cfg.border}`, borderRadius: '12px', backdropFilter: 'blur(12px)', ...extra }
}

// Highlights the matched query substring (case-insensitive) within a string.
function HighlightMatch({ text, query, accent }: { text: string; query: string; accent: string }) {
  if (!query.trim()) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color: accent, fontWeight: 700 }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

// The intermediate session layer — a search box, an optional HANDS section (child
// nodes of an Arm), a "+ NEW CONVERSATION" button, and a dense reverse-chronological
// conversation list. Shared by the Arm/Hand split panel and the main page drawer.
// Collapsible SECTIONS bar — tag-based filtering for a project Hand's chats. Lives
// between the "new chat" zone and the previous-chats list. "All" + one pill per tag +
// an inline "+ Add section" creator. Selecting a pill filters the list (and scopes
// search + new-chat tagging via the parent).
function SectionsBar({
  tags, activeTagId, onSelect, onAddTag, onDeleteTag, accentHex, cfg,
}: {
  tags: Tag[]
  activeTagId: string | null
  onSelect: (tagId: string | null) => void
  onAddTag: (name: string) => void
  onDeleteTag: (id: string) => void
  accentHex: string
  cfg: OrbCfg
}) {
  const [open, setOpen] = useState(false)
  const userToggled = useRef(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const addRef = useRef<HTMLInputElement>(null)

  // Auto-expand once tags exist (unless the user has manually toggled).
  useEffect(() => { if (!userToggled.current) setOpen(tags.length > 0) }, [tags.length])
  useEffect(() => { if (adding) setTimeout(() => addRef.current?.focus(), 30) }, [adding])

  const submit = () => { const n = name.trim(); if (n) { onAddTag(n); setName(''); setAdding(false) } }

  // Outer is a div with role=button (not a real button element) so the optional delete
  // control inside it never nests interactive-in-interactive. Each pill gets a stable key.
  const pill = (key: string, label: string, color: string, selected: boolean, onClick: () => void, onDelete?: () => void) => (
    <div
      key={key}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="section-pill"
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', borderRadius: '999px', cursor: 'pointer', userSelect: 'none',
        fontSize: '10.5px', letterSpacing: '0.04em', fontWeight: 600, whiteSpace: 'nowrap',
        border: `0.5px solid ${selected ? color : 'rgba(255,255,255,0.14)'}`,
        background: selected ? `${color}26` : 'transparent',
        color: selected ? color : 'rgba(255,255,255,0.55)', transition: 'all 0.15s',
      }}
    >
      {color !== 'none' && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 }} />}
      {label}
      {onDelete && (
        <button
          className="section-del"
          onClick={e => { e.stopPropagation(); onDelete() }}
          aria-label={`Delete section ${label}`}
          title="Delete section"
          style={{ background: 'none', border: 'none', padding: 0, margin: '0 -2px 0 0', cursor: 'pointer', color: 'currentColor', opacity: 0.5, display: 'flex' }}
        >
          <IconX size={11} stroke={2} />
        </button>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
      <button
        onClick={() => { userToggled.current = true; setOpen(o => !o) }}
        style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontFamily: 'inherit' }}
      >
        <IconChevronRight size={12} stroke={2} color="rgba(255,255,255,0.4)" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s' }} />
        <span style={{ fontSize: '8.5px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.4)', fontWeight: 700 }}>SECTIONS</span>
        {!open && activeTagId && tags.find(t => t.id === activeTagId) && (
          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: tags.find(t => t.id === activeTagId)!.color, marginLeft: '2px' }} />
        )}
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {pill('all', 'All', 'none', activeTagId === null, () => onSelect(null))}
          {tags.map(t => pill(t.id, t.name, t.color, activeTagId === t.id, () => onSelect(t.id), () => onDeleteTag(t.id)))}
          {adding ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 6px', borderRadius: '999px', border: `0.5px solid ${accentHex}` }}>
              <input
                ref={addRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setName('') } }}
                onBlur={() => { if (!name.trim()) setAdding(false) }}
                placeholder="Section name…"
                style={{ width: '110px', background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: '11px', fontFamily: 'inherit' }}
              />
            </span>
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '999px', border: '1px dashed rgba(255,255,255,0.16)', background: 'transparent', color: 'rgba(255,255,255,0.4)', fontSize: '10px', letterSpacing: '0.06em', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.color = accentHex; e.currentTarget.style.borderColor = accentHex }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)' }}
            >
              <IconPlus size={11} stroke={2} /> ADD SECTION
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function SessionList({
  sessions, activeId, onSelect, onNew, accentHex, cfg,
  searchScope, hands = [], onHandClick, onNewHand, onDeleteHand, hideNewButton = false,
  tagsEnabled = false, tags = [], activeTagId = null, onSetSessionTag,
}: {
  sessions: SessionMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  accentHex: string
  cfg: OrbCfg
  searchScope?: string                       // folder_id to scope conversation search
  hands?: NodeMeta[]                          // child Hands of this Arm (if any)
  onHandClick?: (hand: NodeMeta) => void
  onNewHand?: () => void                      // present only when this node is an Arm
  onDeleteHand?: (hand: NodeMeta) => void
  hideNewButton?: boolean                     // Project Hands render their own "new chat" zone
  tagsEnabled?: boolean                       // project Hands — dots, filter, context menu
  tags?: Tag[]
  activeTagId?: string | null                 // null = "All"
  onSetSessionTag?: (sessionId: string, tagId: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SessionSearchResult[] | null>(null)
  const [handMenuOpen, setHandMenuOpen] = useState<string | null>(null)  // hand id with open ⋮ menu
  const handMenuRef = useRef<HTMLDivElement | null>(null)
  // Session context menu (right-click / long-press) → move-to-section.
  const [ctxMenu, setCtxMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tagById = Object.fromEntries(tags.map(t => [t.id, t])) as Record<string, Tag>

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('scroll', close, true) }
  }, [ctxMenu])

  // Close the Hand ⋮ menu when clicking outside.
  useEffect(() => {
    if (!handMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (handMenuRef.current && !handMenuRef.current.contains(e.target as Node)) setHandMenuOpen(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [handMenuOpen])

  // Debounced (200ms), scoped conversation search. Respects the active section filter.
  useEffect(() => {
    if (!searchScope || !query.trim()) { setResults(null); return }
    const t = setTimeout(async () => {
      try {
        const tagParam = tagsEnabled && activeTagId ? `&tag_id=${encodeURIComponent(activeTagId)}` : ''
        const res = await fetch(`/api/chat/search?folder_id=${encodeURIComponent(searchScope)}&q=${encodeURIComponent(query)}${tagParam}`, { cache: 'no-store' })
        const data = await res.json()
        setResults(Array.isArray(data.results) ? data.results : [])
      } catch { setResults([]) }
    }, 200)
    return () => clearTimeout(t)
  }, [query, searchScope, tagsEnabled, activeTagId])

  const showResults = results !== null
  // In "All" mode show every session (with tag dots); a selected section filters the list.
  const filtered = tagsEnabled && activeTagId ? sessions.filter(s => s.tag_id === activeTagId) : sessions
  const list = showResults ? results! : filtered
  const showDots = tagsEnabled && !activeTagId

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, gap: '10px' }}>
      {searchScope && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '6px', border: `0.5px solid ${cfg.border}`, background: 'rgba(255,255,255,0.02)', flexShrink: 0 }}>
          <IconSearch size={13} stroke={1.6} color="rgba(255,255,255,0.35)" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search conversations…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: '12px', fontFamily: 'inherit' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', display: 'flex', padding: 0 }} aria-label="Clear search">
              <IconX size={12} stroke={1.6} />
            </button>
          )}
        </div>
      )}

      {/* HANDS section — child nodes of this Arm (hidden during search). */}
      {!showResults && (hands.length > 0 || onNewHand) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flexShrink: 0 }}>
          <span style={{ fontSize: '8.5px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.35)', fontWeight: 700, padding: '0 2px' }}>HANDS</span>
          {hands.map(h => (
            <div key={h.id} style={{ position: 'relative' }} ref={handMenuOpen === h.id ? handMenuRef : null}>
              <div
                onClick={() => onHandClick?.(h)}
                className="session-row"
                style={{
                  textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 10px', borderRadius: '6px', border: `0.5px solid ${cfg.border}`,
                  background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', width: '100%',
                }}
              >
                <Ti name={h.icon} size={15} color={accentHex} />
                <span style={{ flex: 1, fontSize: '12px', color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                {onDeleteHand ? (
                  <button
                    onClick={e => { e.stopPropagation(); setHandMenuOpen(v => v === h.id ? null : h.id) }}
                    className="arm-grip"
                    aria-label="Hand options"
                    style={{ background: 'none', border: 'none', padding: '2px 5px', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '14px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
                  >
                    ⋮
                  </button>
                ) : (
                  <IconChevronRight size={14} stroke={1.6} color="rgba(255,255,255,0.3)" />
                )}
              </div>
              {handMenuOpen === h.id && onDeleteHand && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 20, marginTop: '2px',
                  background: 'rgba(8,12,30,0.97)', border: '1px solid rgba(255,255,255,0.10)',
                  borderRadius: '7px', overflow: 'hidden', minWidth: '130px',
                }}>
                  <button
                    onClick={e => { e.stopPropagation(); setHandMenuOpen(null); onDeleteHand(h) }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', color: '#F87171', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.03em' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                  >
                    Delete hand
                  </button>
                </div>
              )}
            </div>
          ))}
          {onNewHand && (
            <button
              onClick={onNewHand}
              style={{
                textAlign: 'left', display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 10px', borderRadius: '6px', border: 'none', background: 'transparent',
                color: 'rgba(255,255,255,0.4)', fontSize: '9px', letterSpacing: '0.12em', fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              <IconPlus size={12} stroke={1.8} /> NEW HAND
            </button>
          )}
        </div>
      )}

      {!showResults && !hideNewButton && (
        <>
          {(hands.length > 0 || onNewHand) && (
            <span style={{ fontSize: '8.5px', letterSpacing: '0.2em', color: 'rgba(255,255,255,0.35)', fontWeight: 700, padding: '0 2px', flexShrink: 0 }}>CONVERSATIONS</span>
          )}
          <button
            onClick={onNew}
            className="session-new"
            style={{
              width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '8px',
              border: `0.5px solid ${cfg.border}`, borderLeft: `2px solid ${accentHex}`,
              background: 'transparent', color: accentHex,
              fontSize: '10px', letterSpacing: '0.16em', fontWeight: 700,
              fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0, transition: 'background 0.15s',
            }}
          >
            + NEW CONVERSATION
          </button>
        </>
      )}

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {list.length === 0 && (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.2)', fontSize: '12px', marginTop: '24px', letterSpacing: '0.03em' }}>
            {showResults ? 'No matches' : 'No conversations yet'}
          </div>
        )}
        {list.map((s, i) => {
          const active = s.id === activeId
          const rawExcerpt = showResults ? (s as SessionSearchResult).match_excerpt : s.last_message_preview
          // A persisted research row's JSON snapshot never shows as a preview — label it instead.
          const excerpt = rawExcerpt?.startsWith(RESEARCH_MSG_PREFIX) ? '🔬 Deep research report' : rawExcerpt
          const dotTag = showDots && s.tag_id ? tagById[s.tag_id] : undefined
          const openCtx = (x: number, y: number) => {
            if (!tagsEnabled || !onSetSessionTag) return
            setCtxMenu({ sessionId: s.id, x: Math.min(x, window.innerWidth - 180), y: Math.min(y, window.innerHeight - 220) })
          }
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              onContextMenu={tagsEnabled && onSetSessionTag ? (e => { e.preventDefault(); openCtx(e.clientX, e.clientY) }) : undefined}
              onTouchStart={tagsEnabled && onSetSessionTag ? (e => { const t = e.touches[0]; longPressRef.current = setTimeout(() => openCtx(t.clientX, t.clientY), 500) }) : undefined}
              onTouchEnd={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null } }}
              onTouchMove={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null } }}
              className="session-row"
              style={{
                textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '3px',
                padding: '10px 12px', border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                borderLeft: `2px solid ${active ? accentHex : 'transparent'}`,
                background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                cursor: 'pointer', fontFamily: 'inherit', width: '100%',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                  {dotTag && (
                    <span title={dotTag.name} style={{ width: '7px', height: '7px', borderRadius: '50%', background: dotTag.color, flexShrink: 0 }} />
                  )}
                  {(s.summary_count ?? 0) > 0 && (
                    <span title="History compressed" style={{ width: '4px', height: '4px', borderRadius: '50%', background: accentHex, opacity: 0.6, flexShrink: 0 }} />
                  )}
                  <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.85)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {showResults ? <HighlightMatch text={s.title} query={query} accent={accentHex} /> : s.title}
                  </span>
                </span>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {relativeTime(s.updated_at)}
                </span>
              </div>
              {excerpt && (
                <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {showResults ? <HighlightMatch text={excerpt} query={query} accent={accentHex} /> : excerpt}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Session context menu — move-to-section (right-click / long-press). */}
      {ctxMenu && onSetSessionTag && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 80,
            background: 'rgba(8,12,30,0.98)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '8px', overflow: 'hidden', minWidth: '170px', padding: '4px 0',
            boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ fontSize: '8px', letterSpacing: '0.18em', color: 'rgba(255,255,255,0.35)', fontWeight: 700, padding: '6px 12px 4px' }}>MOVE TO SECTION</div>
          {tags.length === 0 && (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', padding: '4px 12px 8px', fontStyle: 'italic' }}>No sections yet</div>
          )}
          {tags.map(t => {
            const cur = list.find(s => s.id === ctxMenu.sessionId)?.tag_id === t.id
            return (
              <button
                key={t.id}
                onClick={() => { onSetSessionTag(ctxMenu.sessionId, t.id); setCtxMenu(null) }}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', color: cur ? t.color : 'rgba(255,255,255,0.8)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                {t.name}{cur ? ' ✓' : ''}
              </button>
            )
          })}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
          <button
            onClick={() => { onSetSessionTag(ctxMenu.sessionId, null); setCtxMenu(null) }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
          >
            Remove tag
          </button>
        </div>
      )}
    </div>
  )
}

// Attachment preview chip — used both in the composer (with onRemove + an upload
// spinner) and in chat history (read-only). Images render a thumbnail (≤120px tall);
// files render an icon + name + size.
function AttachmentChip({
  att, cfg, onRemove,
}: {
  att: { filename: string; file_type: string; size_bytes: number; kind: AttachmentKind; previewUrl?: string; uploading?: boolean; error?: string }
  cfg: OrbCfg
  onRemove?: () => void
}) {
  const [hover, setHover] = useState(false)
  const Icon = att.kind === 'pdf' ? IconFileTypePdf : att.kind === 'image' ? IconPhoto : att.kind === 'text' ? IconFileText : IconFile
  const isImg = att.kind === 'image' && att.previewUrl
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: '8px',
        padding: isImg ? 0 : '8px 10px', borderRadius: '10px',
        border: `0.5px solid ${att.error ? 'rgba(248,113,113,0.5)' : cfg.border}`,
        background: '#0A0E1A', maxWidth: '220px', overflow: 'hidden',
      }}
    >
      {isImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={att.previewUrl} alt={att.filename} style={{ maxHeight: '120px', maxWidth: '200px', objectFit: 'cover', borderRadius: '10px', display: 'block', opacity: att.uploading ? 0.6 : 1 }} />
      ) : (
        <>
          <Icon size={18} stroke={1.6} color={att.kind === 'pdf' ? '#EF5350' : 'rgba(255,255,255,0.6)'} style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.82)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</div>
            <div style={{ fontSize: '9px', color: att.error ? '#F87171' : 'rgba(255,255,255,0.35)' }}>
              {att.error ?? (att.uploading ? 'Uploading…' : fmtBytes(att.size_bytes))}
            </div>
          </div>
        </>
      )}
      {att.uploading && isImg && (
        <span style={{ position: 'absolute', top: '4px', left: '4px', fontSize: '8px', letterSpacing: '0.08em', color: '#fff', background: 'rgba(0,0,0,0.55)', borderRadius: '4px', padding: '1px 5px' }}>…</span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label="Remove attachment"
          title="Remove"
          style={{
            position: 'absolute', top: '3px', right: '3px',
            width: '17px', height: '17px', borderRadius: '50%',
            border: 'none', background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.85)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: hover || !isImg ? 1 : 0, transition: 'opacity 0.15s', padding: 0,
          }}
        >
          <IconX size={11} stroke={2.2} />
        </button>
      )}
    </div>
  )
}

// ── Circuit-board DAG visual (Max mode) ──────────────────────────────────────────────────────────
// An SVG canvas that renders the orchestrated agent graph as a circuit board. Rows by topological
// level: Orchestrator (top) → level-0 agents → … → Synthesis (bottom). Nodes glow by state (waiting /
// running-amber-pulse / complete-cyan; synthesis violet; orchestrator gold). Dependency connections use
// Manhattan (right-angle) routing and animate a traveling pulse on dependency_resolved, then stay lit.
// Clicking any node opens an inline detail panel below the canvas.
const DAG_COLORS = {
  waiting: { fill: '#0a0a0f', border: '#2a2a3a', text: '#4a4a6a', sub: '#3a3a4a', glow: '' },
  running: { fill: '#0d0d1a', border: '#f59e0b', text: '#ffffff', sub: '#f59e0b', glow: '#f59e0b' },
  complete: { fill: '#0a1a1a', border: '#06b6d4', text: '#cffafe', sub: '#06b6d4', glow: '#06b6d4' },
  synthRunning: { fill: '#120d1a', border: '#8b5cf6', text: '#ffffff', sub: '#a78bfa', glow: '#8b5cf6' },
  synthComplete: { fill: '#140a1f', border: '#a855f7', text: '#f3e8ff', sub: '#c084fc', glow: '#a855f7' },
  orchestrator: { fill: '#1a1407', border: '#fbbf24', text: '#fde68a', sub: '#fbbf24', glow: '#fbbf24' },
} as const
function ResearchDag({ dag, done }: { dag: DagState; done: boolean }) {
  // selected: an agent id, or the orchestrator / synthesis sentinels, or null (nothing open).
  const [selected, setSelected] = useState<number | 'orchestrator' | 'synthesis' | null>(null)

  // ── Layout ── rows top→bottom: orchestrator, one row per topo level, synthesis.
  const NODE_W = 132, NODE_H = 48, SYNTH_W = 156, ROW_GAP = 84, PAD = 18
  const rows: { kind: 'orchestrator' | 'agents' | 'synthesis'; ids: number[] }[] = [
    { kind: 'orchestrator', ids: [] },
    ...dag.levels.map(l => ({ kind: 'agents' as const, ids: l })),
    { kind: 'synthesis', ids: [] },
  ]
  const maxCols = Math.max(1, ...rows.map(r => (r.kind === 'agents' ? r.ids.length : 1)))
  const width = Math.max(360, maxCols * (NODE_W + 34) + PAD * 2)
  const contentH = PAD * 2 + (rows.length - 1) * ROW_GAP + NODE_H
  const svgH = Math.max(260, contentH)

  // Center positions per node.
  const pos = new Map<number, { x: number; y: number }>()
  let orchPos = { x: width / 2, y: PAD + NODE_H / 2 }
  let synthPos = { x: width / 2, y: PAD + NODE_H / 2 }
  rows.forEach((row, i) => {
    const y = PAD + NODE_H / 2 + i * ROW_GAP
    if (row.kind === 'orchestrator') orchPos = { x: width / 2, y }
    else if (row.kind === 'synthesis') synthPos = { x: width / 2, y }
    else { const k = row.ids.length; row.ids.forEach((id, j) => pos.set(id, { x: (width * (j + 1)) / (k + 1), y })) }
  })

  const byId = new Map(dag.agents.map(a => [a.id, a]))
  const isDependedOn = new Set<number>()
  for (const a of dag.agents) for (const d of a.dependencies) isDependedOn.add(d)
  const rootAgents = dag.agents.filter(a => a.dependencies.length === 0)        // orchestrator → these
  const leafAgents = dag.agents.filter(a => !isDependedOn.has(a.id))            // these → synthesis

  // Manhattan path: source bottom-center → down to mid → across → up to target top-center.
  const manhattan = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const sx = from.x, sy = from.y + NODE_H / 2, tx = to.x, ty = to.y - NODE_H / 2
    const midY = (sy + ty) / 2
    return `M ${sx} ${sy} V ${midY} H ${tx} V ${ty}`
  }

  // ── Edges ──
  type Edge = { key: string; d: string; state: 'inactive' | 'traveling' | 'complete'; color: string }
  const edges: Edge[] = []
  // Orchestrator → each root agent: lit when that agent starts (state !== waiting).
  for (const a of rootAgents) {
    const p = pos.get(a.id); if (!p) continue
    edges.push({ key: `o-${a.id}`, d: manhattan(orchPos, p), state: a.state !== 'waiting' ? 'complete' : 'inactive', color: '#fbbf24' })
  }
  // Dependency edges: traveling on dependency_resolved, then solid lit.
  for (const a of dag.agents) {
    const tp = pos.get(a.id); if (!tp) continue
    for (const dep of a.dependencies) {
      const sp = pos.get(dep); if (!sp) continue
      const key = `${dep}-${a.id}`
      const depDone = byId.get(dep)?.state === 'complete'
      const state: Edge['state'] = dag.traveling.includes(key) ? 'traveling'
        : (dag.resolved.includes(key) || (depDone && a.state !== 'waiting')) ? 'complete' : 'inactive'
      edges.push({ key, d: manhattan(sp, tp), state, color: '#06b6d4' })
    }
  }
  // Leaf agents → synthesis: lit once synthesis has begun (its findings have flowed in).
  for (const a of leafAgents) {
    const sp = pos.get(a.id); if (!sp) continue
    const lit = a.state === 'complete' && dag.synthesis !== 'waiting'
    edges.push({ key: `s-${a.id}`, d: manhattan(sp, synthPos), state: lit ? 'complete' : 'inactive', color: '#a855f7' })
  }

  // ── Node renderer ──
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const renderNode = (
    center: { x: number; y: number }, w: number, name: string, statusLabel: string,
    colors: typeof DAG_COLORS[keyof typeof DAG_COLORS], st: DagNodeState, isSel: boolean, onClick: () => void, larger?: boolean,
  ) => {
    const h = larger ? NODE_H + 6 : NODE_H
    const x = center.x - w / 2, y = center.y - h / 2
    const glowStyle = colors.glow
      ? (st === 'running'
        ? { filter: `drop-shadow(0 0 4px ${colors.glow})`, animation: 'dagGlowPulse 0.8s ease-in-out infinite alternate' as const }
        : { filter: `drop-shadow(0 0 5px ${colors.glow})` })
      : {}
    return (
      <g key={`${name}-${center.x}-${center.y}`} onClick={onClick} style={{ cursor: 'pointer' }}>
        <rect x={x} y={y} width={w} height={h} rx={9} ry={9} fill={colors.fill}
          stroke={colors.border} strokeWidth={isSel ? 2 : 1.2} style={glowStyle} />
        {st === 'running' && (
          <circle cx={x + 13} cy={center.y} r={5} fill="none" stroke={colors.sub} strokeWidth={1.6} strokeDasharray="8 18"
            style={{ transformBox: 'fill-box', transformOrigin: 'center', animation: 'dagSpin 0.8s linear infinite' }} />
        )}
        {st === 'complete' && (
          <path d={`M ${x + 9} ${center.y} l 3 3.4 l 6.4 -7.6`} fill="none" stroke={colors.sub} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
        )}
        <text x={center.x + (st === 'waiting' ? 0 : 8)} y={center.y - 3} textAnchor="middle" fontSize={11} fontWeight={700} fill={colors.text} style={{ pointerEvents: 'none' }}>{truncate(name, larger ? 20 : 15)}</text>
        <text x={center.x + (st === 'waiting' ? 0 : 8)} y={center.y + 11} textAnchor="middle" fontSize={8} letterSpacing="0.08em" fill={colors.sub} style={{ pointerEvents: 'none' }}>{statusLabel}</text>
      </g>
    )
  }

  const orchColors = DAG_COLORS.orchestrator
  const synthColors = dag.synthesis === 'complete' ? DAG_COLORS.synthComplete : dag.synthesis === 'running' ? DAG_COLORS.synthRunning : DAG_COLORS.waiting
  const synthLabel = dag.synthesis === 'complete' ? 'COMPLETE' : dag.synthesis === 'running' ? 'SYNTHESIZING' : 'WAITING'
  const synthState: DagNodeState = dag.synthesis

  // ── Detail panel content ──
  const detail = (() => {
    if (selected === 'orchestrator') {
      return (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: orchColors.sub, letterSpacing: '0.04em', marginBottom: '6px' }}>ORCHESTRATOR — {dag.agents.length} agents · {dag.levels.length} level{dag.levels.length === 1 ? '' : 's'}</div>
          {dag.reasoning && <p style={{ fontSize: '11px', lineHeight: 1.55, color: 'rgba(255,255,255,0.62)', margin: '0 0 8px' }}>{dag.reasoning}</p>}
          {dag.synthesisFocus && <p style={{ fontSize: '10.5px', lineHeight: 1.5, color: 'rgba(255,255,255,0.45)', margin: 0 }}><b style={{ color: 'rgba(255,255,255,0.6)' }}>Synthesis focus:</b> {dag.synthesisFocus}</p>}
          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '8px' }}>{dag.levels.map((l, i) => `Level ${i}: ${l.map(id => byId.get(id)?.name ?? id).join(', ')}`).join(' → ')}</div>
        </div>
      )
    }
    if (selected === 'synthesis') {
      return (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: synthColors.sub, letterSpacing: '0.04em', marginBottom: '6px' }}>SYNTHESIS — {synthLabel}</div>
          <p style={{ fontSize: '11px', lineHeight: 1.55, color: 'rgba(255,255,255,0.55)', margin: 0 }}>Weaves every agent&apos;s findings into one coherent report. {dag.synthesisFocus && <>Prioritizing: {dag.synthesisFocus}</>}</p>
        </div>
      )
    }
    if (typeof selected === 'number') {
      const a = byId.get(selected); if (!a) return null
      const stColor = a.state === 'complete' ? DAG_COLORS.complete.sub : a.state === 'running' ? DAG_COLORS.running.sub : DAG_COLORS.waiting.sub
      return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: stColor }}>{a.name}</span>
            <span style={{ fontSize: '8.5px', letterSpacing: '0.08em', color: stColor }}>{a.state.toUpperCase()}</span>
          </div>
          <p style={{ fontSize: '11px', lineHeight: 1.5, color: 'rgba(255,255,255,0.62)', margin: '0 0 8px' }}>{a.directive}</p>
          {a.searches.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '3px' }}>SEARCHED</div>
              {a.searches.map((q, i) => <div key={i} style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.45 }}>› {q}</div>)}
            </div>
          )}
          {a.sources.length > 0 && (
            <div style={{ marginBottom: '8px', maxHeight: '120px', overflowY: 'auto' }}>
              <div style={{ fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '3px' }}>SOURCES ({a.sources.length})</div>
              {a.sources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px', color: 'rgba(255,255,255,0.55)', textDecoration: 'none', padding: '1px 0' }}>
                  {s.favicon && <img src={s.favicon} alt="" width={12} height={12} style={{ borderRadius: '2px', flexShrink: 0 }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                </a>
              ))}
            </div>
          )}
          {a.summaryPreview && (
            <div>
              <div style={{ fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '3px' }}>SUMMARY</div>
              <p style={{ fontSize: '10.5px', lineHeight: 1.5, color: 'rgba(255,255,255,0.5)', margin: 0 }}>{a.summaryPreview}{a.summaryPreview.length >= 100 ? '…' : ''}</p>
            </div>
          )}
        </div>
      )
    }
    return null
  })()

  return (
    <div style={{ marginBottom: '11px' }}>
      <div style={{ maxHeight: '600px', overflowY: 'auto', borderRadius: '8px', border: '0.5px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.25)' }}>
        <svg width="100%" viewBox={`0 0 ${width} ${svgH}`} style={{ display: 'block', minHeight: '260px' }} preserveAspectRatio="xMidYMin meet">
          {/* Connections first (under nodes) */}
          {edges.map(e => (
            <path key={e.key} d={e.d} fill="none"
              stroke={e.state === 'inactive' ? '#1e1e2e' : e.color}
              strokeWidth={e.state === 'inactive' ? 1.5 : 2}
              strokeDasharray={e.state === 'traveling' ? '7 993' : undefined}
              style={e.state === 'traveling'
                ? { animation: 'dagDash 1.5s linear', filter: `drop-shadow(0 0 3px ${e.color})` }
                : e.state === 'complete' ? { filter: `drop-shadow(0 0 2px ${e.color})` } : {}}
            />
          ))}
          {/* Orchestrator (always shown complete once the plan arrives) */}
          {renderNode(orchPos, NODE_W, 'Orchestrator', 'COMPLETE', orchColors, 'complete', selected === 'orchestrator', () => setSelected(selected === 'orchestrator' ? null : 'orchestrator'))}
          {/* Agents */}
          {dag.agents.map(a => {
            const p = pos.get(a.id); if (!p) return null
            const colors = a.state === 'complete' ? DAG_COLORS.complete : a.state === 'running' ? DAG_COLORS.running : DAG_COLORS.waiting
            const label = a.state === 'complete' ? `COMPLETE${a.sources.length ? ` · ${a.sources.length} src` : ''}` : a.state === 'running' ? `SEARCHING${a.sources.length ? ` · ${a.sources.length} src` : ''}` : 'WAITING'
            return renderNode(p, NODE_W, a.name, label, colors, a.state, selected === a.id, () => setSelected(selected === a.id ? null : a.id))
          })}
          {/* Synthesis */}
          {renderNode(synthPos, SYNTH_W, 'Synthesis', synthLabel, synthColors, synthState, selected === 'synthesis', () => setSelected(selected === 'synthesis' ? null : 'synthesis'), true)}
        </svg>
      </div>
      {detail && (
        <div className="animate-fadeIn" style={{ marginTop: '8px', padding: '11px 13px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.1)' }}>{detail}</div>
      )}
      {!done && <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', marginTop: '5px', textAlign: 'center' }}>tap any node for detail</div>}
    </div>
  )
}

// Research depth selector (Quick / Deep / Exhaustive) shown in the launch confirm modal. Exhaustive
// adds a fire-and-forget warning. The objective above is what saturation is measured against.
function ResearchDepthSelector({ mode, accentHex, onChange }: { mode: ResearchModeUI; accentHex: string; onChange: (m: ResearchModeUI) => void }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '8px' }}>RESEARCH DEPTH</div>
      <div style={{ display: 'flex', gap: '6px' }}>
        {RESEARCH_MODES.map(m => {
          const on = mode === m.key
          return (
            <button
              key={m.key}
              onClick={() => onChange(m.key)}
              style={{ flex: 1, textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', fontFamily: 'inherit', border: `0.5px solid ${on ? accentHex : 'rgba(255,255,255,0.15)'}`, background: on ? `${accentHex}1A` : 'transparent', transition: 'all 0.15s' }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: on ? accentHex : 'rgba(255,255,255,0.8)' }}>{m.label}</div>
              <div style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.3, marginTop: '2px' }}>{m.blurb}</div>
              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginTop: '3px' }}>{m.time}</div>
            </button>
          )
        })}
      </div>
      {mode === 'exhaustive' && (
        <div style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '8px', background: 'rgba(216,90,48,0.10)', border: '0.5px solid rgba(216,90,48,0.4)', fontSize: '11px', color: 'rgba(255,255,255,0.72)', lineHeight: 1.5 }}>
          ⚠ <b>Exhaustive</b> runs unattended for <b>hours</b> until the topic saturates — fire-and-forget. Make sure your objective is clearly defined; it&apos;s what &ldquo;enough&rdquo; is measured against. <b>Wind Down</b> gives a clean exit anytime.
        </div>
      )}
    </div>
  )
}

// ── Rich deep-research panel ───────────────────────────────────────────────────────────────────
// A full-width live card (not a bubble) that opens in the chat thread when research starts. Header
// (mode/model badges, live elapsed timer, token meter, STOP + WIND DOWN), a step progress bar, a
// live source feed, the circuit-board DAG visual, and a knowledge-saturation indicator. Transforms
// into a completion state with an "Open Notebook" link once done; stays as a permanent record.
function ResearchPanel({ r, accentHex, cfg, onOpen, onStop, onWindDown, notebookReady }: {
  r: ResearchCardState
  accentHex: string
  cfg: OrbCfg
  onOpen?: (nodeId: string, notebookId: string) => void
  onStop?: (scope: string) => void
  onWindDown?: (scope: string) => void
  notebookReady?: (notebookId: string) => boolean
}) {
  const [now, setNow] = useState(Date.now())
  // Tick the elapsed timer once a second while the run is live; freeze when done.
  useEffect(() => {
    if (r.done) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [r.done])

  const modelLabel = researchModelLabel(r.model, true)
  const errored = !!r.error
  const elapsedMs = (r.finishedAt ?? now) - r.startedAt
  const mm = Math.floor(elapsedMs / 60000), ss = Math.floor((elapsedMs % 60000) / 1000)
  const elapsed = `${mm}:${String(ss).padStart(2, '0')}`
  // Live token + cost meter, e.g. "47.3k tok · ~$0.42". Both update on every token_update event.
  const tokLabel = r.tokens != null
    ? `${(r.tokens / 1000).toFixed(1)}k tok${r.cost != null ? ` · ~$${r.cost.toFixed(2)}` : ''}`
    : ''

  // Pipeline steps for the progress bar (the DAG pipeline: Plan → Search → Synthesize → Save).
  const STEP_LABELS: { key: ResearchStep; label: string }[] =
    [{ key: 'plan', label: 'Plan' }, { key: 'search', label: 'Search' }, { key: 'synthesize', label: 'Synthesize' }, { key: 'save', label: 'Save' }]
  const curIdx = Math.max(0, STEP_LABELS.findIndex(s => s.key === r.step))
  const pct = r.done ? 100 : Math.round(((curIdx + 1) / STEP_LABELS.length) * 100)
  const recentSources = r.sources.slice(-5).reverse()

  const green = '#1D9E75', red = '#D85A30'
  const borderCol = errored ? 'rgba(216,90,48,0.55)' : r.done ? `${green}55` : `${accentHex}55`

  return (
    <div className="animate-fadeIn" style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{ maxWidth: '96%', width: '100%', padding: '14px 16px', borderRadius: '2px 12px 12px 12px', background: PANEL, border: `0.5px solid ${borderCol}` }}>
        {/* Header row: badges + elapsed + tokens + STOP */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '11px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', letterSpacing: '0.14em', fontWeight: 700, color: 'rgba(255,255,255,0.5)', padding: '2px 7px', borderRadius: '4px', border: '0.5px solid rgba(255,255,255,0.2)' }}>{modelLabel}</span>
          <span style={{ fontSize: '10px', letterSpacing: '0.16em', fontWeight: 700, color: 'rgba(255,255,255,0.45)' }}>DEEP RESEARCH</span>
          {r.mode && r.mode !== 'quick' && (
            <span style={{ fontSize: '8px', letterSpacing: '0.12em', fontWeight: 700, color: accentHex, padding: '2px 7px', borderRadius: '4px', border: `0.5px solid ${accentHex}66`, background: `${accentHex}14` }}>{r.mode === 'exhaustive' ? 'EXHAUSTIVE' : 'DEEP'}{r.playwright ? ' · FULL' : ''}</span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.55)' }}>⏱ {elapsed}</span>
            {tokLabel && <span style={{ fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.4)' }}>{tokLabel}</span>}
            {!r.done && (
              <>
                {/* Wind Down — graceful: finish current agents, no new ones, go to synthesis. */}
                <button
                  onClick={() => onWindDown?.(r.nodeId)}
                  disabled={r.windingDown || r.aborting}
                  title="Finish the current agents, then synthesize — a clean graceful exit"
                  style={{ fontSize: '10px', letterSpacing: '0.06em', fontWeight: 700, color: r.windingDown ? 'rgba(255,255,255,0.4)' : '#E0A050', background: 'transparent', border: `0.5px solid ${r.windingDown ? 'rgba(255,255,255,0.2)' : 'rgba(224,160,80,0.55)'}`, borderRadius: '5px', padding: '4px 9px', cursor: (r.windingDown || r.aborting) ? 'default' : 'pointer', fontFamily: 'inherit' }}
                >{r.windingDown ? 'WINDING DOWN…' : '◐ WIND DOWN'}</button>
                {/* Stop — immediate halt, no synthesis. */}
                <button
                  onClick={() => onStop?.(r.nodeId)}
                  disabled={r.aborting}
                  title="Halt immediately — saves raw findings, skips synthesis"
                  style={{ fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700, color: '#fff', background: r.aborting ? 'rgba(216,90,48,0.4)' : red, border: 'none', borderRadius: '5px', padding: '4px 11px', cursor: r.aborting ? 'default' : 'pointer', fontFamily: 'inherit' }}
                >{r.aborting ? 'STOPPING…' : '■ STOP'}</button>
              </>
            )}
          </span>
        </div>

        {/* Progress bar + step labels (live, while running) */}
        {!errored && (
          <div style={{ marginBottom: '11px' }}>
            <div style={{ height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: r.done ? green : accentHex, transition: 'width 0.4s ease' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '5px' }}>
              {STEP_LABELS.map((s, i) => {
                const reached = r.done || i <= curIdx
                const current = !r.done && i === curIdx
                return (
                  <span key={s.key} style={{ fontSize: '8.5px', letterSpacing: '0.06em', fontWeight: current ? 700 : 500, color: current ? accentHex : reached ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.25)' }}>{s.label}</span>
                )
              })}
            </div>
          </div>
        )}

        {/* Circuit-board DAG — orchestrated, dependency-aware agent graph (the only research visual).
            Completed/restored cards render it static and slightly muted: a permanent record,
            visually distinct from a live run. */}
        {r.dag && (
          <div style={{ opacity: r.done ? 0.75 : 1, transition: 'opacity 0.6s ease', pointerEvents: 'auto' }}>
            <ResearchDag dag={r.dag} done={r.done} />
          </div>
        )}

        {/* Knowledge-saturation indicator — how much NEW ground each round covers, converging as the
            topic is exhausted. The objective set at launch is the reference frame. Drives Exhaustive
            auto-winddown after `needed` consecutive low-novelty rounds. */}
        {r.saturation && (
          <div style={{ marginBottom: '11px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, color: 'rgba(255,255,255,0.4)' }}>KNOWLEDGE SATURATION · ROUND {r.saturation.round}</span>
              <span style={{ fontSize: '10px', fontVariantNumeric: 'tabular-nums', color: r.saturation.saturation > 0.7 ? '#E0A050' : 'rgba(255,255,255,0.5)' }}>{Math.round(r.saturation.saturation * 100)}%</span>
            </div>
            <div style={{ height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(r.saturation.saturation * 100)}%`, height: '100%', background: r.saturation.saturation > 0.85 ? '#E0A050' : accentHex, transition: 'width 0.6s ease' }} />
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.32)', marginTop: '3px' }}>
              {Math.round(r.saturation.novelty * 100)}% new this round
              {r.mode === 'exhaustive' && r.saturation.consecutiveLow > 0 ? ` · ${r.saturation.consecutiveLow}/${r.saturation.needed} low-novelty rounds → auto wind-down` : ''}
            </div>
          </div>
        )}

        {/* Live source feed — last 5 found, newest first */}
        {recentSources.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '11px', maxHeight: '128px', overflowY: 'auto' }}>
            {recentSources.map((s, i) => (
              <a key={s.url + i} href={s.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11px', color: 'rgba(255,255,255,0.55)', textDecoration: 'none', padding: '2px 0' }}>
                {s.domain && <img src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=32`} alt="" width={13} height={13} style={{ borderRadius: '2px', flexShrink: 0 }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{s.domain}</span>
              </a>
            ))}
          </div>
        )}

        {/* Footer: completion link / error / live status */}
        {r.done && !errored && r.notebookId ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px', color: r.partial ? '#E0A050' : green, fontWeight: 700, letterSpacing: '0.03em' }}>{r.partial ? '◐ Partial report saved' : '✓ Research complete'}</span>
              <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>{elapsed}{tokLabel ? ` · ${tokLabel}` : ''}</span>
            </div>
            {(() => {
              // FIX 2B — clickable only once the notebook is resolvable (tree index / loaded state);
              // until then a brief loading state rather than a broken link.
              const ready = notebookReady ? notebookReady(r.notebookId!) : true
              return (
                <button
                  onClick={() => { if (ready) onOpen?.(r.nodeId, r.notebookId!) }}
                  disabled={!ready}
                  style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', background: cfg.dim, border: `0.5px solid ${accentHex}${ready ? '' : '66'}`, borderRadius: '6px', padding: '6px 12px', cursor: ready ? 'pointer' : 'default', fontFamily: 'inherit', opacity: ready ? 1 : 0.7 }}
                >
                  <i className={ready ? 'ti ti-book' : 'ti ti-loader-2'} style={{ fontSize: '13px', color: accentHex, ...(ready ? {} : { display: 'inline-block', animation: 'spin-slow 1s linear infinite' }) }} />
                  <span style={{ fontSize: '12px', color: accentHex }}>{ready ? `Open Notebook — ${r.notebookTitle}` : 'Preparing notebook…'}</span>
                </button>
              )
            })()}
          </div>
        ) : errored ? (
          <span style={{ fontSize: '12px', color: '#E07A50', lineHeight: 1.5 }}>{r.error}</span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            {!r.done && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: accentHex, animation: 'pulse-active 1s ease-in-out infinite', flexShrink: 0 }} />}
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.5, wordBreak: 'break-word' }}>{r.status}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// A single chat bubble. Text inside `.msg-bubble` is freely selectable/copyable
// (the global user-select:none is overridden in the page <style>). A clipboard
// button fades in on hover and copies the full message text.
function ChatMessageBase({
  msg, isLast, streaming, cfg, accentHex,
  fromVoice = false, canEdit = false, canRetry = false, onEdit, onRetry, onResearchOpen, onResearchStop, onResearchWindDown, researchNotebookReady,
  onSaveOffer, onSaveOfferDismiss,
}: {
  msg: Message
  isLast: boolean
  streaming: boolean
  searching: boolean
  deepThinking: boolean
  cfg: OrbCfg
  accentHex: string
  fromVoice?: boolean
  canEdit?: boolean                 // user bubble — show the edit affordance
  canRetry?: boolean                // last assistant bubble — show retry
  onEdit?: (newText: string) => void
  onRetry?: () => void
  onResearchOpen?: (nodeId: string, notebookId: string) => void  // open a finished research notebook
  onResearchStop?: (scope: string) => void                       // STOP a running research run
  onResearchWindDown?: (scope: string) => void                   // WIND DOWN a running research run
  researchNotebookReady?: (notebookId: string) => boolean        // Open Notebook gating (FIX 2B)
  onSaveOffer?: (msg: Message, targetId?: string) => void        // 💾 chip → verified createDocument pipeline
  onSaveOfferDismiss?: (msg: Message) => void                    // ✕ on the 💾 chip
}) {
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const isUser = msg.role === 'user'
  // Attachment-only message (image/file, no text) — skip the empty text bubble.
  const hideBubble = isUser && !editing && !msg.content && (msg.attachments?.length ?? 0) > 0

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch { /* clipboard unavailable (insecure context) — no-op */ }
  }
  const beginEdit = () => { setDraft(msg.content); setEditing(true) }
  const saveEdit = () => { const t = draft.trim(); if (t && t !== msg.content) onEdit?.(t); setEditing(false) }

  // Deep-research progress card → the rich live ResearchPanel (its own component for the live timer).
  if (msg.kind === 'research' && msg.research) {
    return <ResearchPanel r={msg.research} accentHex={accentHex} cfg={cfg} onOpen={onResearchOpen} onStop={onResearchStop} onWindDown={onResearchWindDown} notebookReady={researchNotebookReady} />
  }

  // Transition pill: an ephemeral navigation/UI-action marker, rendered as a muted inline
  // line (not a bubble). Informational only — never persisted, never editable/retryable.
  if (msg.kind === 'transition') {
    return (
      <div className="animate-fadeIn" style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <span style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: '12px',
          color: 'rgba(255,255,255,0.35)', letterSpacing: '0.02em', padding: '2px 0',
        }}>
          {msg.content}
        </span>
      </div>
    )
  }

  // FIX 2 — transient-failure placeholder: an amber bubble with an explicit "tap to retry"
  // button (re-runs the last turn via onRetry → retryLast), instead of a generic dead error.
  if (msg.kind === 'error') {
    return (
      <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
        <div className="msg-bubble" style={{
          maxWidth: '88%', padding: '10px 14px', borderRadius: '2px 12px 12px 12px',
          background: 'rgba(216,90,48,0.10)', border: '0.5px solid rgba(216,90,48,0.55)',
          fontSize: '13px', lineHeight: '1.6', color: 'rgba(255,255,255,0.9)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {msg.content}
        </div>
        {onRetry && !streaming && (
          <button
            onClick={onRetry}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '6px 13px', borderRadius: '6px',
              border: '0.5px solid rgba(216,90,48,0.6)', background: 'transparent',
              color: '#E07A50', fontSize: '10px', letterSpacing: '0.1em', fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(216,90,48,0.12)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <IconRefresh size={13} stroke={1.8} /> TAP TO RETRY
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="animate-fadeIn"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}
    >
      {/* Attachment preview bubble(s) — above the message they were sent with. */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '6px', maxWidth: '88%', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
          {msg.attachments.map((a, idx) => <AttachmentChip key={idx} att={a} cfg={cfg} />)}
        </div>
      )}
      {!hideBubble && (
      <div className="msg-bubble" style={{
        // User turns stay as compact right-aligned bubbles; Spectre's replies render full-width
        // (no bubble chrome) like the Claude app, so tables / long answers use the whole column.
        maxWidth: editing ? '100%' : isUser ? '85%' : '100%',
        width: editing || !isUser ? '100%' : undefined,
        padding: isUser ? '10px 14px' : '2px 2px',
        borderRadius: isUser ? '12px 12px 2px 12px' : '0',
        background: isUser ? cfg.dim : 'transparent',
        border: isUser ? `0.5px solid ${cfg.border}` : 'none',
        fontSize: '13px',
        lineHeight: '1.68',
        color: isUser ? accentHex : 'rgba(255,255,255,0.88)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <textarea
              value={draft}
              autoFocus
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === 'Escape') setEditing(false) }}
              rows={Math.min(8, draft.split('\n').length + 1)}
              style={{ background: 'rgba(0,0,0,0.25)', border: `0.5px solid ${cfg.border}`, borderRadius: '6px', padding: '8px', color: '#fff', fontSize: '13px', fontFamily: 'inherit', outline: 'none', resize: 'vertical', lineHeight: 1.6 }}
            />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setEditing(false)} style={{ padding: '5px 12px', borderRadius: '5px', border: `0.5px solid ${cfg.border}`, background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>CANCEL</button>
              <button onClick={saveEdit} style={{ padding: '5px 14px', borderRadius: '5px', border: 'none', background: accentHex, color: '#03030A', fontSize: '9px', letterSpacing: '0.1em', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>SAVE & SEND</button>
            </div>
          </div>
        ) : msg.role === 'assistant' ? (
          // Reading / searching / thinking surface in the status indicator below the thread
          // (not inside the bubble), so an in-progress assistant turn is just an empty bubble
          // with the streaming cursor until real text arrives.
          // PERF: while THIS bubble is actively streaming, render the growing text as plain
          // pre-wrapped text (the bubble already sets white-space:pre-wrap) instead of running
          // the full markdown + KaTeX parse on every token. It snaps into rendered markdown the
          // instant the stream finishes (streaming flips false → memo re-render). This removes
          // the O(n²) per-token markdown re-parse that made long replies visibly lag.
          (streaming && isLast)
            ? <>{msg.content}</>
            : <MarkdownRenderer content={msg.content} accent={accentHex} />
        ) : msg.content}
        {!editing && msg.role === 'assistant' && streaming && isLast && (
          <span style={{
            display: 'inline-block',
            width: '6px',
            height: '13px',
            background: accentHex,
            marginLeft: '3px',
            verticalAlign: 'text-bottom',
            animation: 'pulse-active 0.8s ease-in-out infinite',
          }} />
        )}
      </div>
      )}
      {/* Proactive save chip (save-intent Layer 3): substantial reply, no save action this
          turn → offer to capture it. Click = the brief confirmation; saves through the
          verified createDocument pipeline. Ephemeral display state, never persisted. */}
      {!editing && !isUser && msg.saveOffer && (
        <div className="animate-fadeIn" style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '6px', flexWrap: 'wrap' }}>
          {!msg.saveOffer.targets ? (
            <button
              onClick={() => onSaveOffer?.(msg)}
              title={`Save "${msg.saveOffer.title}"`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 12px',
                borderRadius: '6px', border: `0.5px solid ${accentHex}88`, background: cfg.dim,
                color: accentHex, fontSize: '9px', letterSpacing: '0.12em', fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              💾 SAVE TO {(msg.saveOffer.targetName ?? 'NOTEBOOKS').toUpperCase()}
            </button>
          ) : (
            <>
              <span style={{ fontSize: '9px', letterSpacing: '0.12em', fontWeight: 700, color: 'rgba(255,255,255,0.45)' }}>💾 SAVE TO:</span>
              {msg.saveOffer.targets.map(t => (
                <button
                  key={t.id}
                  onClick={() => onSaveOffer?.(msg, t.id)}
                  style={{
                    padding: '5px 12px', borderRadius: '6px', border: `0.5px solid ${accentHex}88`,
                    background: cfg.dim, color: accentHex, fontSize: '9px', letterSpacing: '0.12em',
                    fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {t.name.toUpperCase()}
                </button>
              ))}
            </>
          )}
          <button
            onClick={() => onSaveOfferDismiss?.(msg)}
            aria-label="Dismiss save offer"
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', fontSize: '10px', cursor: 'pointer', fontFamily: 'inherit', padding: '2px 4px' }}
          >
            ✕
          </button>
        </div>
      )}
      {!editing && (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px',
        flexDirection: isUser ? 'row-reverse' : 'row',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '9px', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em' }}>
          {fromVoice && <IconMicrophone size={10} stroke={1.6} style={{ opacity: 0.6 }} />}
          {isUser ? (USER_NAME ? USER_NAME.toUpperCase() : 'YOU') : 'SPECTRE'}
        </span>
        {msg.content && (
          <button
            className="msg-copy"
            onClick={copy}
            aria-label="Copy message"
            title="Copy"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', padding: '0',
              fontSize: '9px', letterSpacing: '0.08em',
              color: copied ? accentHex : 'rgba(255,255,255,0.4)',
              opacity: copied || hover ? 1 : 0,
              transition: 'opacity 0.18s, color 0.18s',
            }}
            onMouseEnter={e => { if (!copied) e.currentTarget.style.color = 'rgba(255,255,255,0.75)' }}
            onMouseLeave={e => { if (!copied) e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
          >
            {copied ? (
              <span>Copied!</span>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        )}
        {isUser && canEdit && onEdit && !streaming && (
          <button
            className="msg-copy"
            onClick={beginEdit}
            aria-label="Edit message"
            title="Edit & regenerate"
            style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'rgba(255,255,255,0.4)', opacity: hover ? 1 : 0, transition: 'opacity 0.18s, color 0.18s' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
          >
            <IconPencil size={13} stroke={1.7} />
          </button>
        )}
        {!isUser && canRetry && onRetry && !streaming && (
          <button
            className="msg-copy"
            onClick={onRetry}
            aria-label="Regenerate response"
            title="Retry"
            style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'rgba(255,255,255,0.4)', opacity: hover ? 1 : 0, transition: 'opacity 0.18s, color 0.18s' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.75)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
          >
            <IconRefresh size={13} stroke={1.7} />
          </button>
        )}
      </div>
      )}
    </div>
  )
}

// PERF: ChatMessage is mapped over the entire conversation. Because the chat `input` state
// (and every other piece of state) lives in the single ~10k-line page component, ANY keystroke
// re-rendered the parent and, with an unmemoized child, re-rendered + re-formatted every message
// bubble — the dominant source of the typing lag in long chats (e.g. a busy project Hand), and it
// also made streaming re-render the whole history on every token. Memoizing skips bubbles whose
// render-affecting props are unchanged: on a keystroke nothing here changes, so all bubbles skip;
// while streaming only the last (changed) bubble re-renders. The inline onEdit/onRetry callbacks
// are intentionally excluded from the comparison — they don't affect output and the positional
// index they close over is stable for a given bubble (the messages array reference changes, and
// with it msg identity, whenever messages are inserted/removed/edited). Research bubbles are
// never skipped: their Open-Notebook/elapsed-timer state isn't captured by msg identity.
const ChatMessage = memo(ChatMessageBase, (prev, next) => {
  // Never memo-skip a live research card — it renders the rich ResearchPanel (live timer +
  // Open-Notebook readiness gating) whose visible state isn't fully captured by msg identity.
  if (next.msg.kind === 'research' || next.msg.content?.startsWith?.(RESEARCH_MSG_PREFIX)) return false
  return (
    prev.msg === next.msg &&
    prev.isLast === next.isLast &&
    prev.streaming === next.streaming &&
    prev.searching === next.searching &&
    prev.deepThinking === next.deepThinking &&
    prev.cfg === next.cfg &&
    prev.accentHex === next.accentHex &&
    prev.fromVoice === next.fromVoice &&
    prev.canEdit === next.canEdit &&
    prev.canRetry === next.canRetry
  )
})

// `normalizeMath` (shared with the Docu-scape converters) rewrites Spectre's LaTeX
// delimiters into the $…$ / $$…$$ forms remark-math understands — see lib/notebookMd.ts.
function MarkdownRenderer({ content, accent }: { content: string; accent: string }) {
  return (
    <div className="spectre-md" style={{ '--md-accent': accent } as React.CSSProperties}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          ul: ({ children }) => <ul>{children}</ul>,
          li: ({ children }) => (
            <li style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <span style={{ color: accent, flexShrink: 0, marginTop: '2px', fontSize: '12px' }}>—</span>
              <span style={{ flex: 1 }}>{children}</span>
            </li>
          ),
          code: ({ children, className }) => (
            <code className={className} style={className ? undefined : {
              background: `color-mix(in srgb, ${accent} 15%, transparent)`,
              border: `0.5px solid color-mix(in srgb, ${accent} 35%, transparent)`,
              borderRadius: '3px', padding: '1px 5px',
              fontSize: '11px', fontFamily: 'monospace', color: accent,
            }}>
              {children}
            </code>
          ),
          blockquote: ({ children }) => <blockquote style={{ borderLeftColor: accent }}>{children}</blockquote>,
          hr: () => <hr style={{ borderTop: `0.5px solid color-mix(in srgb, ${accent} 30%, transparent)` }} />,
          table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
        }}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    </div>
  )
}

// A draggable Arm tile on the bento grid. The 6-dot grip (top-left) owns the drag
// listeners so a tap on the tile body still navigates into the Arm. The grip is
// hover-revealed on desktop and always visible on touch (see globals.css .arm-grip).
// A ⋮ menu (top-right, hover-reveal) exposes "Edit name" and "Delete arm".
function SortableArmTile({ node, accentHex, cfg, onNavigate, onDelete, onRename, children }: {
  node: NodeMeta
  accentHex: string
  cfg: OrbCfg
  onNavigate: () => void
  onDelete?: () => void
  onRename?: () => void
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: node.id })
  const downRef = useRef<{ x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const style: React.CSSProperties = {
    ...panelStyleStatic(cfg, { padding: '16px', cursor: 'pointer', transition: transition ?? 'border-color 0.2s', position: 'relative' }),
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 5 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="arm-tile"
      onMouseDown={e => { downRef.current = { x: e.clientX, y: e.clientY } }}
      onClick={e => {
        const s = downRef.current
        if (s && (e.clientX - s.x) ** 2 + (e.clientY - s.y) ** 2 > 25) return  // was a drag
        onNavigate()
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = accentHex }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = cfg.border }}
    >
      <button
        ref={setActivatorNodeRef}
        className="arm-grip"
        aria-label="Drag to reorder"
        onClick={e => e.stopPropagation()}
        {...attributes}
        {...listeners}
        style={{
          position: 'absolute', top: '8px', left: '8px', zIndex: 2,
          background: 'none', border: 'none', padding: '2px',
          color: 'rgba(255,255,255,0.5)', cursor: 'grab', display: 'flex',
          touchAction: 'none',
        }}
      >
        <IconGripVertical size={14} stroke={1.6} />
      </button>
      {/* ⋮ context menu — top-right, hover-revealed */}
      {(onDelete || onRename) && (
        <div ref={menuRef} style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 10 }} className="arm-grip">
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
            aria-label="Arm options"
            style={{ background: 'none', border: 'none', padding: '3px 5px', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '14px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
          >
            ⋮
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: '4px',
              background: 'rgba(8,12,30,0.97)', border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '7px', overflow: 'hidden', minWidth: '130px',
            }}>
              {onRename && (
                <button
                  onClick={e => { e.stopPropagation(); setMenuOpen(false); onRename() }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.03em' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  Edit name
                </button>
              )}
              {onDelete && (
                <button
                  onClick={e => { e.stopPropagation(); setMenuOpen(false); onDelete() }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', color: '#F87171', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.03em' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  Delete arm
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

// Lightweight rename modal — single input, Esc/outside-click to cancel.
function RenameModal({ label, initialName, accentHex, cfg, onSave, onClose }: {
  label: string; initialName: string; accentHex: string; cfg: OrbCfg
  onSave: (name: string) => void; onClose: () => void
}) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 40) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={e => e.stopPropagation()} className="animate-fadeIn" style={{ width: '100%', maxWidth: '360px', background: '#0A0E1A', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', letterSpacing: '0.2em', color: accentHex, fontWeight: 700 }}>{label}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', display: 'flex' }}><IconX size={16} stroke={1.6} /></button>
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onSave(name.trim()); } }}
          style={{ background: 'rgba(255,255,255,0.03)', border: `0.5px solid ${cfg.border}`, borderRadius: '6px', padding: '10px 12px', color: '#fff', fontSize: '14px', fontFamily: 'inherit', outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: '6px', border: '0.5px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => { if (name.trim()) onSave(name.trim()) }} style={{ padding: '8px 16px', borderRadius: '6px', border: `0.5px solid ${accentHex}55`, background: `${accentHex}14`, color: accentHex, fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer' }}>Save</button>
        </div>
      </div>
    </div>
  )
}

// Quiet detail panel for custom Arms / Hands (no bespoke widget). Shows the node's
// icon, name, template, and current Spectre primer.
function GenericNodeDetail({ node, accentHex, cfg }: { node: NodeMeta; accentHex: string; cfg: OrbCfg }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <div style={{ width: '40px', height: '40px', borderRadius: '8px', border: `0.5px solid ${cfg.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: accentHex }}>
          <Ti name={node.icon} size={22} color={accentHex} />
        </div>
        <div>
          <div style={{ fontSize: '15px', color: 'rgba(255,255,255,0.92)', fontWeight: 600 }}>{node.name}</div>
          <div style={{ fontSize: '10px', color: accentHex, letterSpacing: '0.12em', opacity: 0.7 }}>
            {(node.level === 'arm' ? 'ARM' : 'HAND')} · {(node.template).toUpperCase()}
          </div>
        </div>
      </div>
      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
        {node.primer?.trim() || TEMPLATE_PRIMERS[node.template] || 'No primer set yet — Spectre will use general context here. Edit the primer from the conversations panel.'}
      </div>
    </div>
  )
}

// CSS layout label component — used on all panels
function WidgetLabel({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '10px', letterSpacing: '0.18em',
      color: accent, fontWeight: 700, marginBottom: '12px', opacity: 0.8,
    }}>
      {children}
    </div>
  )
}

function ProgressSlider({ value, onChange, accent }: { value: number; onChange: (v: number) => void; accent: string }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const compute = (clientX: number) => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    onChangeRef.current(Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * 100))
  }

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setIsDragging(true); compute(e.clientX)
    const onMove = (ev: MouseEvent) => compute(ev.clientX)
    const onUp = () => { setIsDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation(); setIsDragging(true); compute(e.touches[0].clientX)
    const onMove = (ev: TouchEvent) => compute(ev.touches[0].clientX)
    const onEnd = () => { setIsDragging(false); document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onEnd) }
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd)
  }

  const active = isHovered || isDragging
  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown} onTouchStart={onTouchStart}
      onClick={e => e.stopPropagation()}
      onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}
      style={{ position: 'relative', height: active ? '4px' : '2px', background: 'rgba(255,255,255,0.07)', borderRadius: '4px', cursor: 'ew-resize', transition: 'height 0.15s ease' }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${value}%`, background: accent, borderRadius: '4px', transition: isDragging ? 'none' : 'width 0.9s ease' }} />
      <div style={{ position: 'absolute', top: '50%', left: `${value}%`, transform: 'translate(-50%, -50%)', width: active ? 10 : 6, height: active ? 10 : 6, borderRadius: '50%', background: accent, boxShadow: active ? `0 0 6px ${accent}` : 'none', transition: 'width 0.15s, height 0.15s, box-shadow 0.15s', pointerEvents: 'none' }} />
    </div>
  )
}

type OrbCfg = (typeof MODE_CONFIG)[Mode]

function OrbRings({ cfg, active, listening, mode, size, voiceMode = false, voicePhase }: { cfg: OrbCfg; active: boolean; listening: boolean; mode: Mode; size: number; voiceMode?: boolean; voicePhase?: VoicePhase }) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'thinking' | 'speaking' | 'reconfiguring'>('idle')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const coreRef    = useRef<HTMLDivElement>(null)
  const ring1Ref   = useRef<HTMLDivElement>(null)
  const ring2Ref   = useRef<HTMLDivElement>(null)
  const activeRef  = useRef(active)
  const phaseRef   = useRef(phase)
  activeRef.current = active
  phaseRef.current  = phase

  const p = (frac: number) => Math.round(size * frac)
  const s = (n: number): React.CSSProperties => ({ position: 'absolute', top: n, right: n, bottom: n, left: n })

  useEffect(() => {
    // Voice mode drives the phase explicitly via the state machine.
    if (voicePhase) {
      setPhase(voicePhase === 'transcribing' ? 'thinking' : voicePhase)
      return
    }
    if (listening) { setPhase('listening'); return }
    if (active) {
      setPhase('thinking')
      const t = setTimeout(() => { if (activeRef.current) setPhase('speaking') }, 1500)
      return () => clearTimeout(t)
    }
    setPhase('idle')
  }, [active, listening, voicePhase])

  useEffect(() => {
    const el = wrapperRef.current
    if (!el || size <= 100) return
    // Voice mode speaking: expressive figure-8 wobble with larger amplitude
    if (voiceMode && phase === 'speaking') {
      const spd = 0.0014; const amp = 9; let frame: number; const t0 = performance.now()
      const tick = (now: number) => {
        const t = (now - t0) * spd
        el.style.transform = `translate(${(Math.sin(t) * amp).toFixed(2)}px,${(Math.sin(2 * t) * amp * 0.5).toFixed(2)}px)`
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(frame)
    }
    // Voice mode processing: figure-8 drift speeds up while Spectre is thinking.
    if (voiceMode && phase === 'thinking') {
      const spd = 0.0022; const amp = 5; let frame: number; const t0 = performance.now()
      const tick = (now: number) => {
        const t = (now - t0) * spd
        el.style.transform = `translate(${(Math.sin(t) * amp).toFixed(2)}px,${(Math.sin(2 * t) * amp * 0.6).toFixed(2)}px)`
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(frame)
    }
    if (phase !== 'idle') { el.style.transition = 'transform 0.7s cubic-bezier(0.4,0,0.2,1)'; el.style.transform = 'translate(0,0)'; return }
    const spd = mode === 'Abstract' ? 0.00024 : mode === 'Creative' ? 0.00068 : 0.00048
    const amp = 3.2; let frame: number; const t0 = performance.now()
    const tick = (now: number) => {
      const t = (now - t0) * spd
      el.style.transform = `translate(${(Math.sin(t) * amp).toFixed(2)}px,${(Math.sin(2 * t) * amp * 0.6).toFixed(2)}px)`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase, mode, size, voiceMode])

  useEffect(() => {
    const core = coreRef.current; if (!core) return
    if (phase !== 'idle') { core.style.transition = 'transform 0.55s cubic-bezier(0.4,0,0.2,1)'; core.style.transform = 'translate(0,0)'; return }
    const max = size > 100 ? 8 : 3; let tid: ReturnType<typeof setTimeout>
    const look = () => {
      if (!coreRef.current) return
      const dart = Math.random() < 0.2
      const reach = dart ? max : max * 0.55
      const x = ((Math.random() - 0.5) * 2 * reach).toFixed(1)
      const y = ((Math.random() - 0.5) * 2 * reach * 0.7).toFixed(1)
      if (dart) {
        coreRef.current.style.transition = 'transform 0.11s cubic-bezier(0.1,0,0.5,1)'
        coreRef.current.style.transform = `translate(${x}px,${y}px)`
        setTimeout(() => { if (coreRef.current) { coreRef.current.style.transition = 'transform 2s cubic-bezier(0.4,0,0.2,1)'; coreRef.current.style.transform = 'translate(0,0)' } }, 150 + Math.random() * 250)
      } else {
        coreRef.current.style.transition = `transform ${(0.9 + Math.random() * 1.5).toFixed(2)}s cubic-bezier(0.4,0,0.2,1)`
        coreRef.current.style.transform = `translate(${x}px,${y}px)`
      }
      tid = setTimeout(look, 2000 + Math.random() * 6000)
    }
    tid = setTimeout(look, 1000 + Math.random() * 2500)
    return () => clearTimeout(tid)
  }, [phase, size])

  useEffect(() => {
    let tid: ReturnType<typeof setTimeout>; let restoreTid: ReturnType<typeof setTimeout>
    const blink = () => {
      if (phaseRef.current !== 'idle') { tid = setTimeout(blink, 3000); return }
      const el = coreRef.current
      if (el) {
        el.style.transition = 'opacity 0.04s ease-in'; el.style.opacity = '0.04'
        restoreTid = setTimeout(() => { if (coreRef.current) { coreRef.current.style.transition = 'opacity 0.14s ease-out'; coreRef.current.style.opacity = '1' } }, 80)
      }
      tid = setTimeout(blink, 8000 + Math.random() * 12000)
    }
    tid = setTimeout(blink, 6000 + Math.random() * 8000)
    return () => { clearTimeout(tid); clearTimeout(restoreTid) }
  }, [])

  useEffect(() => {
    if (phase !== 'idle') return
    const slow = mode === 'Abstract' ? 1.4 : mode === 'Creative' ? 0.9 : 1
    let tid: ReturnType<typeof setTimeout>
    const vary = () => {
      const ring = Math.random() < 0.5 ? ring1Ref.current : ring2Ref.current
      if (ring) {
        if (Math.random() < 0.5) {
          ring.style.animationDirection = 'reverse'
          setTimeout(() => { if (ring) ring.style.animationDirection = '' }, 1000 + Math.random() * 1000)
        } else {
          ring.style.animationDuration = `${(4 + Math.random() * 5) * slow}s`
          setTimeout(() => { if (ring) ring.style.animationDuration = `${(ring === ring1Ref.current ? 22 : 16) * slow}s` }, 1200 + Math.random() * 800)
        }
      }
      tid = setTimeout(vary, 10000 + Math.random() * 12000)
    }
    tid = setTimeout(vary, 8000 + Math.random() * 10000)
    return () => clearTimeout(tid)
  }, [phase, mode])

  const slow     = mode === 'Abstract' ? 1.4 : mode === 'Creative' ? 0.9 : 1
  const isListen = phase === 'listening'
  const isThink  = phase === 'thinking'
  const isSpeak  = phase === 'speaking'
  const isReconfig = phase === 'reconfiguring'
  // Voice failover paints the orb amber and slows the rings (deliberate, technical).
  const accent = isReconfig ? '#F59E0B' : cfg.accent
  const glow   = isReconfig ? 'rgba(245,158,11,0.5)' : cfg.glow
  const ringScale = isListen ? 'scale(0.88)' : isSpeak ? 'scale(1.05)' : 'scale(1)'
  const ringAlpha = voiceMode
    ? { r1: 0.42, r2: 0.62, r3: 0.82 }
    : mode === 'Abstract' ? { r1: 0.13, r2: 0.27, r3: 0.42 } : { r1: 0.28, r2: 0.48, r3: 0.68 }
  const coreBg = isThink
    ? `radial-gradient(circle at 36% 32%, rgba(255,255,255,0.95) 0%, #E0F2FE 18%, #93C5FD88 48%, transparent 72%)`
    : isListen
    ? `radial-gradient(circle at 36% 32%, rgba(255,255,255,1) 0%, ${accent} 14%, ${accent}cc 44%, transparent 70%)`
    : `radial-gradient(circle at 36% 32%, rgba(255,255,255,0.92) 0%, ${accent} 20%, ${accent}88 48%, transparent 72%)`
  const coreGlow = isThink
    ? `0 0 ${p(0.18)}px rgba(224,242,254,0.55), 0 0 ${p(0.36)}px rgba(147,197,253,0.35), 0 0 ${p(0.6)}px rgba(147,197,253,0.15)`
    : isListen
    ? `0 0 ${p(voiceMode ? 0.35 : 0.25)}px ${glow}, 0 0 ${p(voiceMode ? 0.65 : 0.5)}px ${glow}, 0 0 ${p(voiceMode ? 1.0 : 0.8)}px ${glow}55`
    : isSpeak
    ? `0 0 ${p(voiceMode ? 0.3 : 0.18)}px ${glow}, 0 0 ${p(voiceMode ? 0.55 : 0.36)}px ${glow}88, 0 0 ${p(voiceMode ? 0.85 : 0.6)}px ${glow}44`
    : `0 0 ${p(0.18)}px ${glow}, 0 0 ${p(0.36)}px ${glow}88, 0 0 ${p(0.6)}px ${glow}33`
  // Listening in voice mode breathes inward (gentle inward pulse). Speaking spins the rings faster.
  const coreAnim = isReconfig ? 'pulse-reconfig 2.4s ease-in-out infinite'
    : isListen ? (voiceMode ? 'pulse-listening 2.2s ease-in-out infinite' : 'none')
    : isThink ? 'pulse-thinking 1.4s cubic-bezier(0.4,0,0.6,1) infinite'
    : isSpeak ? `pulse-speaking ${voiceMode ? '0.35s' : '0.6s'} cubic-bezier(0.4,0,0.6,1) infinite`
    : 'pulse-glow 3s ease-in-out infinite'
  // Reconfiguring slows the rings to a deliberate crawl; speaking spins them faster.
  const ringSpeed = isReconfig ? 1.8 : voiceMode && isSpeak ? 0.42 : 1

  return (
    <div ref={wrapperRef} style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', inset: 0, transform: ringScale, transition: 'transform 0.85s cubic-bezier(0.4,0,0.2,1)' }}>
        <div style={{ position: 'absolute', top: -8, right: -8, bottom: -8, left: -8, borderRadius: '50%', border: `0.5px solid ${accent}`, opacity: 0, animation: `ping-slow ${3.5 * slow}s ease-out infinite` }} />
        <div ref={ring1Ref} style={{ ...s(0), borderRadius: '50%', border: `0.5px solid ${accent}`, opacity: ringAlpha.r1, animation: `spin-slow ${22 * slow * ringSpeed}s linear infinite` }} />
        <div ref={ring2Ref} style={{ ...s(p(0.1)), borderRadius: '50%', border: `0.5px dashed ${accent}`, opacity: ringAlpha.r2, animation: `spin-reverse ${16 * slow * ringSpeed}s linear infinite` }} />
        <div style={{ ...s(p(0.18)), borderRadius: '50%', border: `0.8px solid ${accent}`, opacity: ringAlpha.r3, animation: `spin-slow ${10 * slow * ringSpeed}s linear infinite` }} />
      </div>
      <div ref={coreRef} style={{ ...s(p(0.28)), willChange: 'transform, opacity' }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: coreBg, boxShadow: coreGlow, animation: coreAnim, transformOrigin: 'center', transition: 'background 0.55s ease, box-shadow 0.55s ease' }} />
        <div style={{ position: 'absolute', top: p(0.16), right: p(0.16), bottom: p(0.16), left: p(0.16), borderRadius: '50%', background: 'rgba(255,255,255,0.92)', boxShadow: '0 0 6px 2px rgba(255,255,255,0.8)' }} />
      </div>
    </div>
  )
}

/* ── Expanded folder views ────────────────────────────────── */

// Full browsable month calendar — the schedule folder's Layer 2 (Google Calendar
// rebuilt in The Diagram aesthetic). Month grid + click-a-day detail panel.
// ═══ Calendar event editor (full gcal-parity control inside the Diagram, so a
// Spectre calendar mistake is the user's to fix) ═══════════════════════════════════════
// Create / edit / delete a single event. Timed or all-day; title, date, times, location.
// Writes straight to POST /api/calendar (create|update|delete) — the same server path
// Spectre uses — then onSaved() refreshes. Editing a recurring instance touches only that
// instance (honest note shown).
function pad2(n: number): string { return String(n).padStart(2, '0') }
function dateInputStr(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function timeInputStr(d: Date): string { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

function EventEditor({ initial, dayHint, accentHex, cfg, onClose, onSaved }: {
  initial: CalendarEvent | null            // null = create
  dayHint: Date                            // seed date for a new event
  accentHex: string
  cfg: OrbCfg
  onClose: () => void
  onSaved: () => void
}) {
  const seedStart = initial ? evDate(initial.start) : (() => { const d = new Date(dayHint); d.setHours(9, 0, 0, 0); return d })()
  const seedEnd = initial ? evDate(initial.end) : (() => { const d = new Date(dayHint); d.setHours(10, 0, 0, 0); return d })()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [allDay, setAllDay] = useState(initial?.allDay ?? false)
  const [dateStr, setDateStr] = useState(dateInputStr(seedStart))
  const [startT, setStartT] = useState(timeInputStr(seedStart))
  const [endT, setEndT] = useState(timeInputStr(seedEnd))
  const [location, setLocation] = useState(initial?.location ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const write = async (op: 'create' | 'update' | 'delete') => {
    setBusy(true); setErr(null)
    let body: { op: string; eventId?: string; event?: Record<string, unknown> }
    if (op === 'delete') {
      body = { op, eventId: initial!.id }
    } else {
      if (!title.trim()) { setErr('Give it a title.'); setBusy(false); return }
      let event: Record<string, unknown>
      if (allDay) {
        const next = new Date(`${dateStr}T00:00:00`); next.setDate(next.getDate() + 1)
        event = { title: title.trim(), allDay: true, start: dateStr, end: dateInputStr(next), location: location.trim() }
      } else {
        const s = new Date(`${dateStr}T${startT}:00`)
        const e = new Date(`${dateStr}T${endT}:00`)
        if (!(e.getTime() > s.getTime())) { setErr('End must be after start.'); setBusy(false); return }
        event = { title: title.trim(), allDay: false, start: s.toISOString(), end: e.toISOString(), location: location.trim() }
      }
      body = op === 'update' ? { op, eventId: initial!.id, event } : { op, event }
    }
    try {
      const r = await fetch('/api/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) { setErr('Google rejected that — check the times.'); setBusy(false); return }
      onSaved(); onClose()
    } catch { setErr('Could not reach the calendar.'); setBusy(false) }
  }

  const field: React.CSSProperties = { background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '8px 11px', fontSize: '13px', color: 'rgba(255,255,255,0.9)', outline: 'none', colorScheme: 'dark' }
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 97, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,4,12,0.62)', backdropFilter: 'blur(6px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 92vw)', display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(10,14,32,0.98)', border: `0.5px solid ${accentHex}55`, borderRadius: '15px', padding: '20px 22px', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', letterSpacing: '0.14em', color: accentHex, fontWeight: 700 }}>{initial ? 'EDIT EVENT' : 'NEW EVENT'}</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}><IconX size={16} /></button>
        </div>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" autoFocus style={{ ...field, fontSize: '15px', fontWeight: 600 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
          <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} style={{ accentColor: accentHex }} /> All day
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)} style={{ ...field, flex: 1 }} />
          {!allDay && (
            <>
              <input type="time" value={startT} onChange={e => setStartT(e.target.value)} style={{ ...field, width: '104px' }} />
              <span style={{ alignSelf: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '12px' }}>→</span>
              <input type="time" value={endT} onChange={e => setEndT(e.target.value)} style={{ ...field, width: '104px' }} />
            </>
          )}
        </div>
        <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Location (optional)" style={field} />
        {initial?.recurringEventId && <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.4)' }}>↻ Part of a repeating series — this changes only this occurrence.</div>}
        {err && <div style={{ fontSize: '11.5px', color: '#F08A6A' }}>{err}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginTop: '2px' }}>
          <button onClick={() => void write(initial ? 'update' : 'create')} disabled={busy}
            style={{ fontSize: '12px', fontWeight: 700, color: '#08101f', background: accentHex, border: 'none', borderRadius: '9px', padding: '9px 18px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{initial ? 'Save' : 'Create'}</button>
          <div style={{ flex: 1 }} />
          {initial && <button onClick={() => void write('delete')} disabled={busy} style={{ fontSize: '12px', color: '#F08A6A', background: 'transparent', border: '0.5px solid rgba(240,138,106,0.4)', borderRadius: '9px', padding: '9px 14px', cursor: 'pointer' }}>Delete</button>}
          <button onClick={onClose} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>, document.body)
}

function CalendarView({
  monthEvents, viewMonth, setViewMonth, selectedDay, setSelectedDay, gcalConnected, accentHex, cfg, onChanged,
}: {
  monthEvents: CalendarEvent[]
  viewMonth: Date
  setViewMonth: (d: Date) => void
  selectedDay: Date
  setSelectedDay: (d: Date) => void
  gcalConnected: boolean
  accentHex: string
  cfg: OrbCfg
  onChanged: () => void
}) {
  // Editor + context-menu + drag state (calendar control).
  const [editing, setEditing] = useState<{ ev: CalendarEvent | null; day: Date } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ ev: CalendarEvent; x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // Deep-work sessions for the drilled-in day ("how long a piece of work took as a
  // portion of a scheduled block"). Landed sessions only; fetched per day.
  const [daySessions, setDaySessions] = useState<{ id: string; label: string; started_at: number; ended_at: number | null }[]>([])
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true) }
  }, [ctxMenu])
  // Move an event to a different day (drag-drop), preserving time-of-day. Recurring
  // instances shift only that occurrence. Self-catching → onChanged reconciles.
  const moveEventToDay = async (ev: CalendarEvent, target: Date) => {
    const s = evDate(ev.start), e = evDate(ev.end)
    const dayDelta = Math.round((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() - new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()) / 86_400_000)
    if (dayDelta === 0) return
    const ns = new Date(s); ns.setDate(ns.getDate() + dayDelta)
    const ne = new Date(e); ne.setDate(ne.getDate() + dayDelta)
    const event = ev.allDay
      ? { title: ev.title, allDay: true, start: dateInputStr(ns), end: dateInputStr(ne), location: ev.location ?? '' }
      : { title: ev.title, allDay: false, start: ns.toISOString(), end: ne.toISOString(), location: ev.location ?? '' }
    try {
      await fetch('/api/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'update', eventId: ev.id, event }) })
      onChanged()
    } catch { /* the grid re-fetches on the next poll regardless */ }
  }
  const today = new Date()
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const firstWeekday = new Date(year, month, 1).getDay()
  const gridStart = new Date(year, month, 1 - firstWeekday)
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })

  // Group events by day. Multi-day events are anchored to their start day.
  const byDay = new Map<string, CalendarEvent[]>()
  for (const e of monthEvents) {
    const k = dayKey(evDate(e.start))
    const arr = byDay.get(k) ?? []
    arr.push(e)
    byDay.set(k, arr)
  }
  const dayEvents = (d: Date) => (byDay.get(dayKey(d)) ?? []).slice().sort(sortEvents)
  const selectedEvents = dayEvents(selectedDay)

  // month grid ⇄ single-day drill-down
  const [view, setView] = useState<'month' | 'day'>('month')
  useEffect(() => {
    if (view !== 'day') return
    let dead = false
    ;(async () => {
      try {
        const r = await fetch(`/api/focus?date=${dateInputStr(selectedDay)}`)
        const d = await r.json()
        if (!dead) setDaySessions((d.sessions ?? []).filter((s: { ended_at: number | null }) => s.ended_at))
      } catch { if (!dead) setDaySessions([]) }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedDay])

  const navMonth = (delta: number) => setViewMonth(new Date(year, month + delta, 1))
  const goToday = () => { setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDay(new Date()) }
  const openDay = (d: Date) => {
    setSelectedDay(new Date(d))
    if (d.getMonth() !== month) setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setView('day')
  }

  const navBtn = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        fontSize: '13px', color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.03)',
        border: `0.5px solid ${cfg.border}`, borderRadius: '8px', width: '30px', height: '30px',
        cursor: 'pointer', lineHeight: 1,
      }}
      onMouseEnter={e => { e.currentTarget.style.color = accentHex; e.currentTarget.style.borderColor = `${accentHex}66` }}
      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; e.currentTarget.style.borderColor = cfg.border }}
    >{label}</button>
  )

  // ── Day drill-down view ──────────────────────────────────────────────────
  if (view === 'day' && gcalConnected) {
    const isToday = sameDay(selectedDay, today)
    return (
      <div key="day" className="animate-cal-drill-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
          <button
            onClick={() => setView('month')}
            aria-label="Back to month"
            style={{
              fontSize: '17px', color: 'rgba(255,255,255,0.65)', background: 'rgba(255,255,255,0.03)',
              border: `0.5px solid ${cfg.border}`, borderRadius: '9px', width: '34px', height: '34px',
              cursor: 'pointer', lineHeight: 1, flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = accentHex; e.currentTarget.style.borderColor = `${accentHex}66` }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.65)'; e.currentTarget.style.borderColor = cfg.border }}
          >‹</button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            <span style={{ fontSize: '10px', letterSpacing: '0.14em', color: accentHex, fontWeight: 600 }}>
              {selectedDay.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()}{isToday ? ' · TODAY' : ''}
            </span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>
              {selectedDay.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          <button onClick={() => setEditing({ ev: null, day: selectedDay })} title="Add an event this day"
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', color: accentHex, background: `${accentHex}16`, border: `0.5px solid ${accentHex}55`, borderRadius: '9px', padding: '7px 12px', cursor: 'pointer' }}>
            <IconPlus size={13} /> NEW
          </button>
        </div>

        {selectedEvents.length === 0 ? (
          <div onClick={() => setEditing({ ev: null, day: selectedDay })} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.04em', padding: '24px 0', textAlign: 'center', cursor: 'pointer' }}>
            No events scheduled this day. <span style={{ color: accentHex }}>Tap to add one.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {selectedEvents.map(e => {
              const desc = e.description ? e.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
              return (
                <div key={e.id}
                  onClick={() => setEditing({ ev: e, day: selectedDay })}
                  onContextMenu={ev => { ev.preventDefault(); setCtxMenu({ ev: e, x: ev.clientX, y: ev.clientY }) }}
                  title="Click to edit · right-click for options"
                  style={{
                  display: 'flex', gap: '14px', alignItems: 'stretch', cursor: 'pointer',
                  background: 'rgba(255,255,255,0.025)', border: `0.5px solid ${cfg.border}`,
                  borderRadius: '12px', padding: '14px 16px', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={ev => { ev.currentTarget.style.borderColor = `${accentHex}66` }}
                  onMouseLeave={ev => { ev.currentTarget.style.borderColor = cfg.border }}
                >
                  <div style={{ width: '3px', borderRadius: '2px', background: e.color ?? accentHex, flexShrink: 0, boxShadow: `0 0 7px ${(e.color ?? accentHex)}99` }} />
                  <div style={{ minWidth: '104px', flexShrink: 0, fontSize: '12px', fontVariantNumeric: 'tabular-nums', color: 'rgba(255,255,255,0.55)', paddingTop: '1px', lineHeight: 1.5 }}>
                    {e.allDay ? 'All day' : (
                      <>
                        <div>{fmt12fromDate(evDate(e.start))}</div>
                        <div style={{ color: 'rgba(255,255,255,0.3)' }}>{fmt12fromDate(evDate(e.end))}</div>
                      </>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.92)', fontWeight: 600 }}>{e.title}</div>
                    {e.location && (
                      <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.45)', marginTop: '4px' }}>📍 {e.location}</div>
                    )}
                    {desc && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)', marginTop: '8px', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{desc}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {/* DEEP WORK — the day's tracked focus sessions, laid against the schedule so
            "3:10–4:25 deep work" reads as a portion of the scheduled block. */}
        {daySessions.length > 0 && (
          <div style={{ marginTop: '22px' }}>
            <div style={{ fontSize: '9.5px', letterSpacing: '0.24em', color: '#38BDF8', fontWeight: 700, marginBottom: '8px' }}>DEEP WORK — TRACKED</div>
            <div style={{ background: 'rgba(56,189,248,0.05)', border: '0.5px solid rgba(56,189,248,0.25)', borderRadius: '12px', padding: '12px 16px' }}>
              {daySessions.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 0' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums', minWidth: '118px', flexShrink: 0 }}>
                    {fmt12fromDate(new Date(s.started_at))} – {fmt12fromDate(new Date(s.ended_at!))}
                  </span>
                  <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                  <span style={{ fontSize: '10.5px', color: '#38BDF8', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtFocusMs((s.ended_at ?? 0) - s.started_at)}</span>
                </div>
              ))}
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '6px', borderTop: '0.5px solid rgba(56,189,248,0.2)', paddingTop: '6px' }}>
                total {fmtFocusMs(daySessions.reduce((a, s) => a + ((s.ended_at ?? 0) - s.started_at), 0))} in deep focus this day
              </div>
            </div>
          </div>
        )}
        {editing && <EventEditor initial={editing.ev} dayHint={editing.day} accentHex={accentHex} cfg={cfg} onClose={() => setEditing(null)} onSaved={onChanged} />}
        {ctxMenu && <CalCtxMenu ctx={ctxMenu} accentHex={accentHex} cfg={cfg} onEdit={() => { setEditing({ ev: ctxMenu.ev, day: selectedDay }); setCtxMenu(null) }} onDelete={async () => { const id = ctxMenu.ev.id; setCtxMenu(null); try { await fetch('/api/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', eventId: id }) }); onChanged() } catch { /* poll reconciles */ } }} />}
      </div>
    )
  }

  // ── Month grid view ──────────────────────────────────────────────────────
  return (
    <div key="month" className="animate-cal-drill-back">
      {/* ── Header: month nav ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '17px', fontWeight: 600, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.01em' }}>
            {CAL_MONTHS[month]} <span style={{ color: accentHex }}>{year}</span>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={goToday}
            style={{
              fontSize: '10px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)',
              background: 'rgba(255,255,255,0.03)', border: `0.5px solid ${cfg.border}`,
              borderRadius: '8px', padding: '0 12px', height: '30px', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = accentHex }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)' }}
          >TODAY</button>
          {navBtn('‹', () => navMonth(-1))}
          {navBtn('›', () => navMonth(1))}
        </div>
      </div>

      {!gcalConnected ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '40px 0', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em' }}>
            Connect your Google Calendar to see your real schedule.
          </div>
          <button
            onClick={() => { window.location.href = '/api/auth/google' }}
            style={{
              fontSize: '12px', letterSpacing: '0.04em', color: accentHex,
              background: `${accentHex}14`, border: `0.5px solid ${accentHex}66`,
              borderRadius: '10px', padding: '10px 18px', cursor: 'pointer',
            }}
          >Connect Google Calendar</button>
        </div>
      ) : (
        <>
          {/* ── Weekday header ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
            {CAL_WEEKDAYS.map(w => (
              <div key={w} style={{ fontSize: '9px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '2px 0' }}>
                {w.toUpperCase()}
              </div>
            ))}
          </div>

          {/* ── Month grid ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' }}>
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === month
              const isToday = sameDay(d, today)
              const isSelected = sameDay(d, selectedDay)
              const evs = dayEvents(d)
              return (
                <div
                  key={i}
                  onClick={() => openDay(d)}
                  onContextMenu={e => { e.preventDefault(); setEditing({ ev: null, day: new Date(d) }) }}
                  onDragOver={e => { if (dragId) { e.preventDefault(); e.currentTarget.style.background = `${accentHex}22` } }}
                  onDragLeave={e => { e.currentTarget.style.background = isSelected ? `${accentHex}1a` : inMonth ? 'rgba(255,255,255,0.018)' : 'transparent' }}
                  onDrop={e => {
                    e.preventDefault(); e.currentTarget.style.background = isSelected ? `${accentHex}1a` : inMonth ? 'rgba(255,255,255,0.018)' : 'transparent'
                    const ev = monthEvents.find(x => x.id === dragId); setDragId(null)
                    if (ev) void moveEventToDay(ev, d)
                  }}
                  title="Click to open · right-click to add · drag an event here to move it"
                  style={{
                    minHeight: '76px', padding: '5px 5px 4px', borderRadius: '8px', cursor: 'pointer',
                    background: isSelected ? `${accentHex}1a` : inMonth ? 'rgba(255,255,255,0.018)' : 'transparent',
                    border: isSelected ? `0.5px solid ${accentHex}88` : `0.5px solid ${inMonth ? 'rgba(255,255,255,0.05)' : 'transparent'}`,
                    display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = inMonth ? 'rgba(255,255,255,0.018)' : 'transparent' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <span style={{
                      fontSize: '11px', fontVariantNumeric: 'tabular-nums', lineHeight: 1,
                      width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: '50%',
                      background: isToday ? accentHex : 'transparent',
                      color: isToday ? '#05070f' : inMonth ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.22)',
                      fontWeight: isToday ? 700 : 400,
                      boxShadow: isToday ? `0 0 8px ${accentHex}aa` : 'none',
                    }}>{d.getDate()}</span>
                  </div>
                  {evs.slice(0, 3).map(e => (
                    <div key={e.id}
                      draggable
                      onDragStart={ev => { ev.stopPropagation(); setDragId(e.id) }}
                      onDragEnd={() => setDragId(null)}
                      onClick={ev => { ev.stopPropagation(); setEditing({ ev: e, day: new Date(d) }) }}
                      onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); setCtxMenu({ ev: e, x: ev.clientX, y: ev.clientY }) }}
                      style={{
                      display: 'flex', alignItems: 'center', gap: '3px',
                      background: e.allDay ? `${e.color ?? accentHex}33` : 'transparent',
                      borderRadius: '3px', padding: e.allDay ? '1px 3px' : '0 1px', minWidth: 0,
                      opacity: dragId === e.id ? 0.4 : 1, cursor: 'grab',
                    }}>
                      <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: e.color ?? accentHex, flexShrink: 0 }} />
                      <span style={{
                        fontSize: '9px', color: inMonth ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {!e.allDay && <span style={{ color: 'rgba(255,255,255,0.4)', marginRight: '3px' }}>{fmt12fromDate(evDate(e.start)).replace(':00', '')}</span>}
                        {e.title}
                      </span>
                    </div>
                  ))}
                  {evs.length > 3 && (
                    <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.35)', paddingLeft: '2px' }}>+{evs.length - 3} more</span>
                  )}
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: '14px', fontSize: '10px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.04em', textAlign: 'center' }}>
            Tap a day to open it · drag events to move them · right-click a day to add
          </div>
        </>
      )}
      {editing && <EventEditor initial={editing.ev} dayHint={editing.day} accentHex={accentHex} cfg={cfg} onClose={() => setEditing(null)} onSaved={onChanged} />}
      {ctxMenu && <CalCtxMenu ctx={ctxMenu} accentHex={accentHex} cfg={cfg} onEdit={() => { setEditing({ ev: ctxMenu.ev, day: evDate(ctxMenu.ev.start) }); setCtxMenu(null) }} onDelete={async () => { const id = ctxMenu.ev.id; setCtxMenu(null); try { await fetch('/api/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'delete', eventId: id }) }); onChanged() } catch { /* poll reconciles */ } }} />}
    </div>
  )
}

// Right-click menu for a calendar event (edit / delete), portaled at the cursor.
function CalCtxMenu({ ctx, accentHex, cfg, onEdit, onDelete }: {
  ctx: { ev: CalendarEvent; x: number; y: number }
  accentHex: string; cfg: OrbCfg
  onEdit: () => void
  onDelete: () => void
}) {
  return createPortal(
    <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 170), top: Math.min(ctx.y, window.innerHeight - 110), zIndex: 98, minWidth: '156px', background: 'rgba(10,14,32,0.98)', border: `0.5px solid ${cfg.border}`, borderRadius: '9px', overflow: 'hidden', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
      <div style={{ padding: '8px 12px', fontSize: '11px', color: 'rgba(255,255,255,0.55)', borderBottom: `0.5px solid ${cfg.border}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ctx.ev.title}</div>
      <button onClick={onEdit} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)', fontSize: '12.5px', cursor: 'pointer' }}
        onMouseEnter={e => { e.currentTarget.style.background = `${accentHex}18` }} onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
        <IconPencil size={13} /> Edit / move
      </button>
      <button onClick={onDelete} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'none', border: 'none', color: '#F08A6A', fontSize: '12.5px', cursor: 'pointer' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(240,138,106,0.1)' }} onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
        <IconTrash size={13} /> Delete
      </button>
    </div>, document.body)
}

// A compact 7-day sparkline bar chart for one Oura metric. 7 bars (one per day,
// oldest→newest); today (last) is brighter. Missing days render as a stub bar.
// Bars use a DYNAMIC baseline (not 0) so values that cluster close together still
// show visible differences; a min–max label below gives the absolute context.
function OuraSparkline({ label, values, fmt, unit, accentHex, cfg }: {
  label: string; values: (number | null)[]; fmt: (v: number) => string; unit: string; accentHex: string; cfg: OrbCfg
}) {
  const nums = values.filter((v): v is number => v != null)
  const minVal = nums.length ? Math.min(...nums) : 0
  const maxVal = nums.length ? Math.max(...nums) : 1
  const range = maxVal - minVal
  // Baseline sits below the smallest value (clamped ≥ 0 — no negative health
  // metrics). Shortest bar ≈ 23% tall, tallest 100%, so deltas are amplified.
  const baseline = Math.max(0, minVal - range * 0.3)
  const denom = maxVal - baseline
  const barPct = (v: number) => (denom > 0 ? Math.max(8, ((v - baseline) / denom) * 100) : 100)
  const card: React.CSSProperties = { background: 'rgba(255,255,255,0.02)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '14px' }
  return (
    <div style={card}>
      <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', marginBottom: '10px' }}>{label.toUpperCase()}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '46px' }}>
        {values.map((v, i) => {
          const today = i === values.length - 1
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', justifyContent: 'flex-end', height: '100%' }}>
              <div
                style={{
                  width: '100%',
                  height: v == null ? '2px' : `${barPct(v)}%`,
                  background: v == null ? 'rgba(255,255,255,0.06)' : today ? accentHex : `${accentHex}55`,
                  borderRadius: '3px', transition: 'height 0.6s ease',
                }}
                title={v == null ? 'no data' : fmt(v)}
              />
              <span style={{ fontSize: '8px', color: today ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums' }}>{v == null ? '–' : fmt(v)}</span>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: '8px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.04em', marginTop: '7px', fontVariantNumeric: 'tabular-nums' }}>
        {nums.length ? `${fmt(minVal)} – ${fmt(maxVal)} ${unit}` : 'no data'}
      </div>
    </div>
  )
}

// Premium health dashboard for the body folder — live Oura data: today's four
// headline scores, four 7-day sparkline trends, and the readiness contributors.
// Connect/Reconnect CTA when the ring isn't linked. No fabricated values — any
// missing metric shows "--" (the dashboard never invents a 0).
function ExpandedBodyStats({ oura, connected, error, accentHex, cfg }: { oura: OuraSnapshot | null; connected: boolean; error: string | null; accentHex: string; cfg: OrbCfg }) {
  const [showContrib, setShowContrib] = useState(true)
  if (!connected) {
    const reconnect = error === 'auth_expired'
    return (
      <div>
        <WidgetLabel accent={accentHex}>BODY STATS</WidgetLabel>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', padding: '48px 0', textAlign: 'center' }}>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em' }}>
            {reconnect
              ? 'Your Oura connection expired. Reconnect to resume live sleep, readiness, HRV, and heart-rate data.'
              : 'Connect your Oura Ring to see live sleep, readiness, HRV, and heart rate.'}
          </div>
          <button
            onClick={() => { window.location.href = '/api/oura/auth' }}
            style={{ fontSize: '12px', letterSpacing: '0.04em', color: accentHex, background: `${accentHex}14`, border: `0.5px solid ${accentHex}66`, borderRadius: '10px', padding: '10px 18px', cursor: 'pointer' }}
          >{reconnect ? 'Reconnect Oura Ring' : 'Connect Oura Ring'}</button>
        </div>
      </div>
    )
  }
  if (!oura) {
    return (
      <div>
        <WidgetLabel accent={accentHex}>BODY STATS</WidgetLabel>
        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', padding: '40px 0', textAlign: 'center' }}>Syncing Oura data…</div>
      </div>
    )
  }

  const tiles = ouraCards(oura)
  const trendsByLabel: Record<string, (number | null)[]> = {
    Sleep: ouraSeries(oura, 'sleep_score'),
    Readiness: ouraSeries(oura, 'readiness_score'),
    HRV: ouraSeries(oura, 'average_hrv'),
    'Resting HR': ouraSeries(oura, 'average_heart_rate'),
  }
  // 7-day sparkline series, with the spec's unit conversions.
  const hrvSeries = ouraSeries(oura, 'average_hrv')
  const hrSeries = ouraSeries(oura, 'average_heart_rate')
  const sleepHrsSeries = oura.days.map(d => (d.total_sleep_duration != null ? +(d.total_sleep_duration / 3600).toFixed(1) : null))
  const remMinSeries = oura.days.map(d => (d.rem_sleep_duration != null ? Math.round(d.rem_sleep_duration / 60) : null))
  // Readiness contributors — the five the spec calls for, in order, from today.
  const today = ouraToday(oura)
  const CONTRIB_KEYS = ['activity_balance', 'hrv_balance', 'resting_heart_rate', 'sleep_balance', 'body_temperature']
  const contributors: [string, number][] = today?.contributors
    ? CONTRIB_KEYS
        .map(k => [k, today.contributors![k]] as [string, number | null | undefined])
        .filter((e): e is [string, number] => typeof e[1] === 'number')
    : []
  const pretty = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const card: React.CSSProperties = { background: 'rgba(255,255,255,0.02)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '16px' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <WidgetLabel accent={accentHex}>BODY — OURA RING</WidgetLabel>
        <span style={{ fontSize: '9px', letterSpacing: '0.08em', color: error || oura.fromYesterday ? '#F59E0B' : 'rgba(255,255,255,0.3)', paddingBottom: '8px' }}>
          {error ? 'SYNC FAILED · SHOWING LAST DATA' : ouraSyncedLabel(oura).toUpperCase()}
        </span>
      </div>

      {/* Today's headline scores */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {tiles.map((t, i) => {
          const trend = t.value != null ? ouraTrend(t.value, trendsByLabel[t.label] ?? []) : ''
          return (
            <div key={i} style={card}>
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.12em', marginBottom: '10px' }}>{t.label.toUpperCase()}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', marginBottom: t.bar ? '10px' : '4px' }}>
                <span style={{ fontSize: '42px', color: accentHex, fontWeight: 700, lineHeight: 1 }}>{t.value ?? '--'}</span>
                {t.value != null && <span style={{ fontSize: '14px', color: `${accentHex}88`, fontWeight: 600 }}>{t.unit}</span>}
              </div>
              {t.bar && (
                <div style={{ height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '3px', marginBottom: '8px' }}>
                  <div style={{ height: '100%', width: `${t.value ?? 0}%`, background: accentHex, borderRadius: '3px', transition: 'width 0.8s ease' }} />
                </div>
              )}
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.02em' }}>{trend || ' '}</div>
            </div>
          )
        })}
      </div>

      {/* 7-day sparkline trends */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <OuraSparkline label="HRV (7d)" values={hrvSeries} fmt={v => `${v}`} unit="ms" accentHex={accentHex} cfg={cfg} />
        <OuraSparkline label="Heart Rate (7d)" values={hrSeries} fmt={v => `${v}`} unit="bpm" accentHex={accentHex} cfg={cfg} />
        <OuraSparkline label="Sleep (7d hrs)" values={sleepHrsSeries} fmt={v => v.toFixed(1)} unit="hrs" accentHex={accentHex} cfg={cfg} />
        <OuraSparkline label="REM (7d min)" values={remMinSeries} fmt={v => `${v}`} unit="min" accentHex={accentHex} cfg={cfg} />
      </div>

      {/* Readiness contributors (collapsible) */}
      {contributors.length > 0 && (
        <div style={card}>
          <button
            onClick={() => setShowContrib(s => !s)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontFamily: 'inherit', marginBottom: showContrib ? '12px' : 0 }}
          >
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.12em' }}>READINESS CONTRIBUTORS</span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', transform: showContrib ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
          </button>
          {showContrib && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
            {contributors.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', width: '150px', flexShrink: 0 }}>{pretty(k)}</span>
                <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.07)', borderRadius: '2px' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, v))}%`, background: accentHex, borderRadius: '2px', opacity: 0.8, transition: 'width 0.6s ease' }} />
                </div>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', width: '28px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(v)}</span>
              </div>
            ))}
          </div>
          )}
        </div>
      )}
    </div>
  )
}

// Projects landing — full-width cards, one per Hand under Projects. Each shows the
// Hand name + icon + a freshly generated AI activity summary (no progress/phase). A
// dashed "+ Add project" tile at the bottom is the only way to create project Hands.
function ProjectsLanding({
  hands, summaries, spent, accentHex, cfg, onHandClick, onAddProject, onDeleteHand, onRenameHand,
}: {
  hands: NodeMeta[]; summaries: Record<string, string>; spent: Record<string, number>; accentHex: string; cfg: OrbCfg
  onHandClick: (hand: NodeMeta) => void
  onAddProject: () => void
  onDeleteHand: (hand: NodeMeta) => void
  onRenameHand: (hand: NodeMeta) => void
}) {
  const [menuId, setMenuId] = useState<string | null>(null)
  useEffect(() => {
    if (!menuId) return
    const close = () => setMenuId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuId])
  return (
    <div style={{ maxWidth: '880px', margin: '0 auto' }}>
      <WidgetLabel accent={accentHex}>PROJECTS</WidgetLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {hands.map(hand => {
          const rawSummary = summaries[hand.id] ?? hand.summary ?? 'Loading summary…'
          const summary = stripMarkdown(rawSummary)
          return (
            <div
              key={hand.id}
              onClick={() => onHandClick(hand)}
              onMouseEnter={e => { e.currentTarget.style.borderColor = accentHex; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = cfg.border; e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
              className="project-card"
              style={{ position: 'relative', background: 'rgba(255,255,255,0.02)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '22px 24px', cursor: 'pointer', transition: 'border-color 0.2s, background 0.2s' }}
            >
              {/* ⋮ rename / delete menu — hover-revealed, top-right. */}
              <div className="project-card-menu" style={{ position: 'absolute', top: '12px', right: '14px', zIndex: 5 }}>
                <button
                  onClick={e => { e.stopPropagation(); setMenuId(menuId === hand.id ? null : hand.id) }}
                  aria-label="Project options"
                  style={{ background: 'none', border: 'none', padding: '3px 6px', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '16px', lineHeight: 1 }}
                >⋮</button>
                {menuId === hand.id && (
                  <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, marginTop: '4px', background: 'rgba(8,12,30,0.97)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '7px', overflow: 'hidden', minWidth: '130px' }}>
                    <button
                      onClick={() => { setMenuId(null); onRenameHand(hand) }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.03em' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                    >Rename</button>
                    <button
                      onClick={() => { setMenuId(null); onDeleteHand(hand) }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'none', border: 'none', color: '#F87171', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.03em' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                    >Delete</button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                <div style={{ width: '44px', height: '44px', borderRadius: '10px', border: `0.5px solid ${cfg.border}`, background: cfg.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: accentHex }}>
                  <Ti name={hand.icon} size={24} color={accentHex} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '19px', color: 'rgba(255,255,255,0.95)', fontWeight: 700, marginBottom: '7px', paddingRight: '24px' }}>{hand.name}</div>
                  <div style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.5)', lineHeight: '1.6' }}>{summary}</div>
                  {(spent[hand.id] ?? 0) >= 60_000 && (
                    <div style={{ fontSize: '10.5px', color: '#38BDF8', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <IconBolt size={11} color="#38BDF8" /> {(() => { const s = Math.floor(spent[hand.id] / 60000); const h = Math.floor(s / 60); return h ? `${h}h ${s % 60}m` : `${s}m` })()} of focused work tracked
                    </div>
                  )}
                </div>
                <IconArrowRight size={20} stroke={1.6} color={accentHex} style={{ flexShrink: 0, marginTop: '4px', opacity: 0.7 }} />
              </div>
            </div>
          )
        })}
        {hands.length === 0 && (
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.04em', padding: '12px 0' }}>
            No projects yet — add one below.
          </div>
        )}
        <button
          onClick={onAddProject}
          onMouseEnter={e => { e.currentTarget.style.borderColor = accentHex; e.currentTarget.style.color = accentHex }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            padding: '18px', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.14)',
            background: 'transparent', color: 'rgba(255,255,255,0.4)',
            fontSize: '11px', letterSpacing: '0.14em', fontWeight: 700, fontFamily: 'inherit',
            cursor: 'pointer', transition: 'border-color 0.2s, color 0.2s',
          }}
        >
          <IconPlus size={15} stroke={1.8} /> ADD PROJECT
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCU-SCAPE — Notebooks library + TipTap editor + ghost text + thought bubbles
// ═══════════════════════════════════════════════════════════════════════════════

// ── Ghost-text extension ──────────────────────────────────────────────────────────
// Renders an inline, dimmed AI continuation after the cursor as a ProseMirror widget
// decoration. React (NotebookEditor) drives it: on a typing pause it fetches a
// completion and dispatches a `ghostText` meta to show it; Tab accepts (insert as real
// text), Escape/any edit dismisses. Suggestion text lives in the extension storage.
const ghostKey = new PluginKey('ghostText')
const GhostText = Extension.create({
  name: 'ghostText',
  addStorage() { return { text: '' as string } },
  addProseMirrorPlugins() {
    const ext = this
    return [
      new Plugin({
        key: ghostKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(ghostKey)
            if (meta && typeof meta.text === 'string') {
              ext.storage.text = meta.text
              if (!meta.text) return DecorationSet.empty
              const pos = tr.selection.head
              const widget = Decoration.widget(pos, () => {
                const span = document.createElement('span')
                span.className = 'nb-ghost'
                span.textContent = meta.text
                return span
              }, { side: 1 })
              return DecorationSet.create(tr.doc, [widget])
            }
            if (tr.docChanged) { ext.storage.text = ''; return DecorationSet.empty }
            return old.map(tr.mapping, tr.doc)
          },
        },
        props: { decorations(state) { return ghostKey.getState(state) } },
      }),
    ]
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const text = this.storage.text as string
        if (text) {
          this.editor.chain().focus().insertContent(text).run()
          this.editor.view.dispatch(this.editor.state.tr.setMeta(ghostKey, { text: '' }))
          return true
        }
        return false   // let default Tab behaviour run (e.g. task-list indent)
      },
      Escape: () => {
        if (this.storage.text as string) {
          this.editor.view.dispatch(this.editor.state.tr.setMeta(ghostKey, { text: '' }))
          return true
        }
        return false
      },
    }
  },
})

// Thought-bubble pattern detection — runs after each Enter on the text typed so far.
// Returns the first matching suggestion (or null). Suppressed patterns are skipped.
type ThoughtPattern = { key: string; label: string; question: string; apply: (e: Editor) => void }
function detectThoughtPattern(text: string, suppressed: Record<string, number>): ThoughtPattern | null {
  const now = Date.now()
  const ok = (k: string) => !suppressed[k] || suppressed[k] < now
  const lines = text.split('\n')
  const recent = lines.slice(-6)
  const candidates: ThoughtPattern[] = []
  // TODO / Action → task list
  if (/\b(TODO|Action:)/i.test(recent.join('\n'))) {
    candidates.push({ key: 'task', label: 'a task list', question: 'Convert to task list?', apply: e => e.chain().focus().toggleTaskList().run() })
  }
  // ≥2 lines starting with - or • → bullet list
  if (recent.filter(l => /^\s*[-•]\s+/.test(l)).length >= 2) {
    candidates.push({ key: 'bullet', label: 'a bullet list', question: 'Convert to bullet list?', apply: e => e.chain().focus().toggleBulletList().run() })
  }
  // "Name: value" pattern on ≥2 lines → table
  if (recent.filter(l => /^[^:\n]{1,40}:\s+\S+/.test(l)).length >= 2) {
    candidates.push({ key: 'table', label: 'a table', question: 'Format as table?', apply: e => e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() })
  }
  // A line ending in ":" followed by an item → numbered list
  if (recent.some((l, i) => /:\s*$/.test(l) && recent[i + 1] && recent[i + 1].trim().length > 0)) {
    candidates.push({ key: 'ordered', label: 'a numbered list', question: 'Create numbered list?', apply: e => e.chain().focus().toggleOrderedList().run() })
  }
  // 200+ words and no headings → add headings
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  if (words >= 200 && !lines.some(l => /^#{1,6}\s/.test(l))) {
    candidates.push({ key: 'headings', label: 'section headings', question: 'Add section headings?', apply: e => e.chain().focus().toggleHeading({ level: 2 }).run() })
  }
  return candidates.find(c => ok(c.key)) ?? null
}

// The rich-text document editor (TipTap). Opening a notebook mounts this full-height in
// the right panel (or 80% in focus mode). Autosaves the TipTap JSON 1.5s after typing.
// Upload an inline editor image to the notebook's vault folder (source='notebook' →
// the-diagram-files/projects/<node>/notebooks/), returning the served raw URL to embed.
// Ensures a real extension so the stored file_type maps to a correct image MIME on serve.
async function uploadNotebookImage(nodeId: string, file: File): Promise<string | null> {
  try {
    let name = file.name
    if (!/\.[a-z0-9]+$/i.test(name)) {
      const ext = (file.type.split('/')[1] || 'png').split('+')[0]   // image/svg+xml → svg
      name = `pasted-image-${Date.now()}.${ext}`
    }
    const form = new FormData()
    form.append('node_id', nodeId)
    form.append('source', 'notebook')
    form.append('file', file, name)
    const res = await fetch('/api/files/upload', { method: 'POST', body: form })
    const data = await res.json()
    if (data.file?.id) return `/api/files/${data.file.id}/raw`
  } catch { /* offline — image just isn't inserted */ }
  return null
}

// ── Math nodes (KaTeX) — render LaTeX inside Docu-scape documents ─────────────────
// Two atom nodes carrying a `latex` attribute; a NodeView renders it with KaTeX (the same
// engine as the chat panel). markdownToTiptap/migrateDocMath produce these nodes from
// $…$ / $$…$$, and tiptapToMarkdown serializes them back, so math round-trips to the vault
// + export. A render failure falls back to showing the raw LaTeX rather than throwing.
function renderKatexInto(dom: HTMLElement, latex: string, displayMode: boolean) {
  try { katex.render(latex || '', dom, { throwOnError: false, displayMode }) }
  catch { dom.textContent = latex || '' }
}
const InlineMath = TiptapNodeExt.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { latex: { default: '' } } },
  parseHTML() { return [{ tag: 'span[data-inline-math]', getAttrs: el => ({ latex: (el as HTMLElement).getAttribute('data-inline-math') || '' }) }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-inline-math': String(node.attrs.latex ?? ''), class: 'nb-math-inline' }), String(node.attrs.latex ?? '')]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'nb-math-inline'
      dom.setAttribute('data-inline-math', String(node.attrs.latex ?? ''))
      renderKatexInto(dom, String(node.attrs.latex ?? ''), false)
      return { dom }
    }
  },
})
const MathBlock = TiptapNodeExt.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() { return { latex: { default: '' } } },
  parseHTML() { return [{ tag: 'div[data-math-block]', getAttrs: el => ({ latex: (el as HTMLElement).getAttribute('data-math-block') || '' }) }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': String(node.attrs.latex ?? ''), class: 'nb-math-block' })]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'nb-math-block'
      renderKatexInto(dom, String(node.attrs.latex ?? ''), true)
      return { dom }
    }
  },
})

// Font size — TipTap has no built-in font-size control, so this registers a `fontSize`
// attribute on the textStyle mark (applied via setMark('textStyle', { fontSize })). It renders
// inline (style="font-size:…") and parses back, so sizes persist in the document JSON. Markdown
// has no font size, so it does NOT round-trip to the .md vault mirror/export (same as text color).
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: element => element.style.fontSize || null,
          renderHTML: attributes => (attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {}),
        },
      },
    }]
  },
})

function NotebookEditor({
  nodeId, notebook, onClose, onSave, focusMode, onToggleFocus, onReady, onTeardown, onContent,
  onGhostRequest, onThoughtConfirm, cfg, readOnly = false,
}: {
  nodeId: string
  notebook: NotebookMeta
  onClose: () => void
  onSave: (id: string, json: string) => void
  focusMode: boolean
  onToggleFocus: () => void
  onReady: (api: { id: string; insertMarkdown: (md: string, mode: 'append' | 'replace') => void }) => void
  onTeardown: () => void
  onContent: (id: string, title: string, markdown: string) => void
  // Ghost text + thought-bubble confirmation route through Spectre (project-aware) — both
  // assembled by the page (composeBase + /api/spectre). Return '' / false to suppress.
  onGhostRequest: (paragraph: string, docMarkdown: string) => Promise<string>
  onThoughtConfirm: (paragraph: string, label: string) => Promise<boolean>
  cfg: OrbCfg
  readOnly?: boolean   // openNotebook(mode:'view') — render the document non-editable
}) {
  const [, setTick] = useState(0)
  const [saved, setSaved] = useState(false)
  const [bubble, setBubble] = useState<{ x: number; y: number; q: string; key: string; apply: (e: Editor) => void } | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [showSizes, setShowSizes] = useState(false)
  const saveTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostReqRef = useRef(0)
  const bubbleReqRef = useRef(0)   // guards against stale thought-bubble confirmations
  const bubbleTidRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressRef = useRef<Record<string, number>>({})
  const spectreWritingRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Ghost-suggestions toggle. Persisted per-user in localStorage (default ON to preserve
  // existing behavior). When OFF, the onUpdate ghost branch returns before any /api/spectre
  // call — no tokens spent, clean plain writing. A ref mirrors it so the editor's onUpdate
  // closure (created once per notebook.id) always reads the live value.
  const [ghostOn, setGhostOn] = useState(() => {
    try { return localStorage.getItem('diagram_ghost_suggestions') !== 'off' } catch { return true }
  })
  const ghostOnRef = useRef(ghostOn)
  useEffect(() => { ghostOnRef.current = ghostOn }, [ghostOn])
  const toggleGhost = () => setGhostOn(prev => {
    const next = !prev
    try { localStorage.setItem('diagram_ghost_suggestions', next ? 'on' : 'off') } catch { /* private mode */ }
    // Turning off: drop any in-flight request and clear the visible suggestion immediately.
    if (!next && editor) {
      ghostReqRef.current++
      if (ghostTidRef.current) clearTimeout(ghostTidRef.current)
      editor.view.dispatch(editor.state.tr.setMeta(ghostKey, { text: '' }))
    }
    return next
  })

  const initialContent: TiptapDoc = (() => {
    // migrateDocMath splits any literal LaTeX in already-stored docs into math nodes so
    // documents written before math rendering existed still render (idempotent on new docs).
    try { return notebook.content ? migrateDocMath(JSON.parse(notebook.content)) : { type: 'doc', content: [{ type: 'paragraph' }] } }
    catch { return { type: 'doc', content: [{ type: 'paragraph' }] } }
  })()

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit,
      Highlight.configure({ multicolor: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow, TableHeader, TableCell,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle, Color, FontSize,
      Image.configure({ HTMLAttributes: { loading: 'lazy' } }),
      InlineMath,
      MathBlock,
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start writing, or ask Spectre to begin a draft…' }),
      GhostText,
    ],
    content: initialContent,
    editorProps: {
      attributes: { class: 'nb-prose' },
      // Paste an image (Ctrl+V) → upload to the notebook vault folder + embed inline.
      handlePaste: (view, event) => {
        if (!view.editable) return false
        const items = Array.from(event.clipboardData?.items ?? [])
        const imgs = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'))
        if (!imgs.length) return false
        event.preventDefault()
        const files = imgs.map(it => it.getAsFile()).filter((f): f is File => !!f)
        void handleImageFiles(files)
        return true
      },
      // Drag-drop image file(s) → upload + embed inline at the drop position.
      handleDrop: (view, event) => {
        if (!view.editable) return false
        const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void handleImageFiles(files, pos)
        return true
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter') {
          // After the newline applies, check the text for a structural suggestion, then
          // confirm with Spectre (project-aware) before surfacing the bubble.
          setTimeout(() => {
            if (!editor) return
            const found = detectThoughtPattern(editor.getText(), suppressRef.current)
            if (!found) { setBubble(null); return }
            const recent = editor.getText().split('\n').slice(-6).join('\n')
            const reqAt = ++bubbleReqRef.current
            onThoughtConfirm(recent, found.label).then(yes => {
              if (!yes || reqAt !== bubbleReqRef.current || !editor) return
              try {
                const coords = editor.view.coordsAtPos(editor.state.selection.head)
                const rect = wrapRef.current?.getBoundingClientRect()
                const x = rect ? coords.left - rect.left + 20 : 20
                const y = rect ? coords.bottom - rect.top + 20 : 20
                setBubble({ x, y, q: found.question, key: found.key, apply: found.apply })
                if (bubbleTidRef.current) clearTimeout(bubbleTidRef.current)
                bubbleTidRef.current = setTimeout(() => setBubble(null), 8000)
              } catch { /* coords unavailable */ }
            }).catch(() => {})
          }, 0)
        }
        return false
      },
    },
    onUpdate: ({ editor: ed }) => {
      // Autosave (debounced) + keep the primer's open-notebook content fresh.
      if (saveTidRef.current) clearTimeout(saveTidRef.current)
      saveTidRef.current = setTimeout(() => {
        onSave(notebook.id, JSON.stringify(ed.getJSON()))
        onContent(notebook.id, notebook.title, tiptapToMarkdown(ed.getJSON() as TiptapDoc))
        setSaved(true)
        setTimeout(() => setSaved(false), 1600)
      }, 1500)
      setTick(t => t + 1)
      // Ghost text: 700ms after the last keystroke, ask Spectre (project-aware, via
      // /api/spectre with the document context) for a continuation. The reqId guard drops
      // any response that arrives after the user has typed again (acts as cancellation).
      if (ghostTidRef.current) clearTimeout(ghostTidRef.current)
      if (spectreWritingRef.current) return
      if (!ghostOnRef.current) return   // ghost suggestions disabled — skip the API call entirely
      const reqId = ++ghostReqRef.current
      ghostTidRef.current = setTimeout(() => {
        const para = ed.state.selection.$head.parent.textContent
        if (para.trim().length < 20) return
        onGhostRequest(para, tiptapToMarkdown(ed.getJSON() as TiptapDoc)).then(completion => {
          // Only show if nothing changed since the request fired and the editor is focused.
          if (reqId === ghostReqRef.current && completion && ed.isFocused) {
            const sep = /\s$/.test(para) ? '' : ' '
            ed.view.dispatch(ed.state.tr.setMeta(ghostKey, { text: sep + completion }))
          }
        }).catch(() => {})
      }, 700)
    },
  }, [notebook.id])

  // Upload pasted/dropped image(s) to the notebook's vault folder, then embed each inline.
  // Inserting a node fires onUpdate → the normal debounced autosave persists it.
  const handleImageFiles = async (files: File[], pos?: number) => {
    if (!editor || !editor.isEditable) return
    if (typeof pos === 'number') editor.commands.focus(pos)
    for (const file of files) {
      const src = await uploadNotebookImage(nodeId, file)
      if (!src || !editor) continue
      editor.chain().focus().insertContent({ type: 'image', attrs: { src, alt: file.name } }).run()
    }
  }

  // Register the live-write API for Spectre's writeToNotebook, and report initial content.
  useEffect(() => {
    if (!editor) return
    const api = {
      id: notebook.id,
      insertMarkdown: (md: string, mode: 'append' | 'replace') => {
        spectreWritingRef.current = true
        const doc = markdownToTiptap(md)
        if (mode === 'replace') editor.chain().focus().setContent(doc).run()
        else editor.chain().focus('end').insertContent(doc.content).run()
        onSave(notebook.id, JSON.stringify(editor.getJSON()))
        onContent(notebook.id, notebook.title, tiptapToMarkdown(editor.getJSON() as TiptapDoc))
        setTimeout(() => { spectreWritingRef.current = false }, 200)
      },
    }
    onReady(api)
    onContent(notebook.id, notebook.title, tiptapToMarkdown(editor.getJSON() as TiptapDoc))
    const cb = () => setTick(t => t + 1)
    editor.on('selectionUpdate', cb)
    return () => {
      editor.off('selectionUpdate', cb)
      // Flush a pending autosave so a focus-mode toggle (which remounts the editor) or
      // closing the notebook never drops the last <1.5s of edits.
      if (saveTidRef.current) { clearTimeout(saveTidRef.current); onSave(notebook.id, JSON.stringify(editor.getJSON())) }
      onTeardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, notebook.id])

  useEffect(() => () => {
    if (saveTidRef.current) clearTimeout(saveTidRef.current)
    if (ghostTidRef.current) clearTimeout(ghostTidRef.current)
    if (bubbleTidRef.current) clearTimeout(bubbleTidRef.current)
  }, [])

  // Keep TipTap's editability in sync when Spectre re-opens the same doc in view↔edit.
  useEffect(() => { editor?.setEditable(!readOnly) }, [editor, readOnly])

  const exportMarkdown = () => {
    if (!editor) return
    const md = `# ${notebook.title}\n\n${tiptapToMarkdown(editor.getJSON() as TiptapDoc)}\n`
    const slug = notebook.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'notebook'
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${slug}.md`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const words = editor ? editor.storage.characterCount.words() : 0
  const chars = editor ? editor.storage.characterCount.characters() : 0
  const readMin = Math.max(1, Math.ceil(words / 200))
  // Current font size of the selection (defaults to the page's 15px base when unset).
  const curFontSize = editor?.getAttributes('textStyle')?.fontSize as string | undefined
  const curSize = curFontSize ? parseInt(curFontSize, 10) : 15

  const ToolBtn = ({ icon, on, active, title }: { icon: React.ReactNode; on: () => void; active?: boolean; title: string }) => (
    <button
      onMouseDown={e => { e.preventDefault(); on() }}
      title={title}
      className="nb-toolbtn"
      style={{
        width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        background: active ? EDITOR_BLUE : 'transparent', color: active ? '#fff' : 'rgba(255,255,255,0.6)',
      }}
    >{icon}</button>
  )
  const Sep = () => <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)', margin: '0 4px', flexShrink: 0 }} />

  // Read-only (view mode): a minimal toolbar — no formatting controls, just back +
  // a VIEW tag + focus toggle. The full editing toolbar renders only when editable.
  if (readOnly) {
    return (
      <div ref={wrapRef} className="nb-editor-root animate-fadeIn" style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'rgba(8,12,30,0.6)' }}>
        <div className="nb-toolbar" style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          padding: '6px 10px', background: 'rgba(8,12,30,0.92)', borderBottom: `0.5px solid ${cfg.border}`,
        }}>
          <button onMouseDown={e => { e.preventDefault(); onClose() }} title="Back to library" className="nb-toolbtn"
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: NB_TEAL }}>
            <IconArrowLeft size={17} stroke={1.8} />
          </button>
          <span style={{ flex: 1, fontSize: 12, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notebook.title}</span>
          <span style={{ fontSize: 9, letterSpacing: '0.12em', color: NB_TEAL, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: NB_TEAL_TINT }}>VIEW</span>
          <ToolBtn icon={focusMode ? <IconMinimize size={16} stroke={1.7} /> : <IconMaximize size={16} stroke={1.7} />} on={onToggleFocus} active={focusMode} title="Focus mode" />
        </div>
        <div className="nb-editor-print" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <EditorContent editor={editor} />
        </div>
        <div className="nb-statsbar" style={{
          display: 'flex', gap: 16, flexShrink: 0, padding: '5px 14px', fontSize: 10, letterSpacing: '0.06em',
          color: 'rgba(255,255,255,0.4)', background: 'rgba(8,12,30,0.92)', borderTop: `0.5px solid ${cfg.border}`,
        }}>
          <span>{words} words</span><span>{chars} chars</span><span>{readMin} min read</span>
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="nb-editor-root animate-fadeIn" style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'rgba(8,12,30,0.6)' }}>
      {/* Toolbar */}
      <div className="nb-toolbar" style={{
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', flexShrink: 0,
        padding: '6px 10px', background: 'rgba(8,12,30,0.92)', borderBottom: `0.5px solid ${cfg.border}`,
      }}>
        <button onMouseDown={e => { e.preventDefault(); onClose() }} title="Back to library" className="nb-toolbtn"
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: NB_TEAL }}>
          <IconArrowLeft size={17} stroke={1.8} />
        </button>
        <Sep />
        <ToolBtn icon={<IconArrowBackUp size={16} stroke={1.7} />} on={() => editor?.chain().focus().undo().run()} title="Undo" />
        <ToolBtn icon={<IconArrowForwardUp size={16} stroke={1.7} />} on={() => editor?.chain().focus().redo().run()} title="Redo" />
        <Sep />
        <ToolBtn icon={<IconBold size={16} stroke={1.9} />} on={() => editor?.chain().focus().toggleBold().run()} active={editor?.isActive('bold')} title="Bold" />
        <ToolBtn icon={<IconItalic size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleItalic().run()} active={editor?.isActive('italic')} title="Italic" />
        <ToolBtn icon={<IconUnderline size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleUnderline().run()} active={editor?.isActive('underline')} title="Underline" />
        <ToolBtn icon={<IconStrikethrough size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleStrike().run()} active={editor?.isActive('strike')} title="Strikethrough" />
        <ToolBtn icon={<IconHighlight size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleHighlight().run()} active={editor?.isActive('highlight')} title="Highlight" />
        <div style={{ position: 'relative' }}>
          <ToolBtn icon={<IconPalette size={16} stroke={1.7} />} on={() => setShowColors(s => !s)} active={showColors} title="Text color" />
          {showColors && (
            <div style={{ position: 'absolute', top: 32, left: 0, zIndex: 30, display: 'flex', gap: 4, padding: 6, borderRadius: 8, background: 'rgba(8,12,30,0.98)', border: `0.5px solid ${cfg.border}` }}>
              {NOTEBOOK_COLORS.map(c => (
                <button key={c} onMouseDown={e => { e.preventDefault(); editor?.chain().focus().setColor(c).run(); setShowColors(false) }}
                  style={{ width: 18, height: 18, borderRadius: 4, border: 'none', cursor: 'pointer', background: c }} />
              ))}
              <button onMouseDown={e => { e.preventDefault(); editor?.chain().focus().unsetColor().run(); setShowColors(false) }}
                style={{ width: 18, height: 18, borderRadius: 4, border: '0.5px solid rgba(255,255,255,0.3)', cursor: 'pointer', background: 'transparent', color: '#fff', fontSize: 11 }}>×</button>
            </div>
          )}
        </div>
        <Sep />
        {/* Font size — Google-Docs-style dropdown; applies a fontSize mark to the selection. */}
        <div style={{ position: 'relative' }}>
          <button onMouseDown={e => { e.preventDefault(); setShowSizes(s => !s) }} title="Font size" className="nb-toolbtn"
            style={{ height: 28, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '0 7px', borderRadius: 6, border: `0.5px solid ${showSizes ? EDITOR_BLUE : 'rgba(255,255,255,0.16)'}`, cursor: 'pointer', background: 'transparent', color: 'rgba(255,255,255,0.72)', fontSize: 12, fontFamily: 'inherit' }}>
            {curSize}<span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
          </button>
          {showSizes && (
            <div style={{ position: 'absolute', top: 32, left: 0, zIndex: 30, display: 'flex', flexDirection: 'column', padding: 4, borderRadius: 8, background: 'rgba(8,12,30,0.98)', border: `0.5px solid ${cfg.border}`, maxHeight: 244, overflowY: 'auto', minWidth: 58 }}>
              {[10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48].map(sz => (
                <button key={sz} onMouseDown={e => { e.preventDefault(); editor?.chain().focus().setMark('textStyle', { fontSize: `${sz}px` }).run(); setShowSizes(false) }}
                  style={{ padding: '5px 12px', textAlign: 'left', border: 'none', cursor: 'pointer', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', background: sz === curSize ? 'rgba(14,165,233,0.18)' : 'transparent', color: sz === curSize ? EDITOR_BLUE : 'rgba(255,255,255,0.82)' }}>{sz}</button>
              ))}
            </div>
          )}
        </div>
        <Sep />
        <ToolBtn icon={<IconH1 size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} active={editor?.isActive('heading', { level: 1 })} title="Heading 1" />
        <ToolBtn icon={<IconH2 size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} active={editor?.isActive('heading', { level: 2 })} title="Heading 2" />
        <ToolBtn icon={<IconH3 size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} active={editor?.isActive('heading', { level: 3 })} title="Heading 3" />
        <Sep />
        <ToolBtn icon={<IconList size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleBulletList().run()} active={editor?.isActive('bulletList')} title="Bullet list" />
        <ToolBtn icon={<IconListNumbers size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleOrderedList().run()} active={editor?.isActive('orderedList')} title="Numbered list" />
        <ToolBtn icon={<IconListCheck size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleTaskList().run()} active={editor?.isActive('taskList')} title="Task list" />
        <Sep />
        <ToolBtn icon={<IconAlignLeft size={16} stroke={1.7} />} on={() => editor?.chain().focus().setTextAlign('left').run()} active={editor?.isActive({ textAlign: 'left' })} title="Align left" />
        <ToolBtn icon={<IconAlignCenter size={16} stroke={1.7} />} on={() => editor?.chain().focus().setTextAlign('center').run()} active={editor?.isActive({ textAlign: 'center' })} title="Align center" />
        <ToolBtn icon={<IconAlignRight size={16} stroke={1.7} />} on={() => editor?.chain().focus().setTextAlign('right').run()} active={editor?.isActive({ textAlign: 'right' })} title="Align right" />
        <Sep />
        <ToolBtn icon={<IconLineDashed size={16} stroke={1.7} />} on={() => editor?.chain().focus().setHorizontalRule().run()} title="Horizontal rule" />
        <ToolBtn icon={<IconCode size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleCodeBlock().run()} active={editor?.isActive('codeBlock')} title="Code block" />
        <ToolBtn icon={<IconBlockquote size={16} stroke={1.7} />} on={() => editor?.chain().focus().toggleBlockquote().run()} active={editor?.isActive('blockquote')} title="Blockquote" />
        <ToolBtn icon={<IconTable size={16} stroke={1.7} />} on={() => editor?.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run()} title="Insert table" />
        <Sep />
        <ToolBtn icon={<IconFileText size={16} stroke={1.7} />} on={exportMarkdown} title="Download Markdown" />
        <ToolBtn icon={<IconPrinter size={16} stroke={1.7} />} on={() => window.print()} title="Download PDF (print)" />
        <div style={{ flex: 1 }} />
        {saved && <span style={{ fontSize: 10, letterSpacing: '0.08em', color: NB_TEAL, marginRight: 6 }}>SAVED</span>}
        <ToolBtn icon={<IconSparkles size={16} stroke={1.7} />} on={toggleGhost} active={ghostOn} title={`Ghost suggestions ${ghostOn ? 'on' : 'off'}`} />
        <ToolBtn icon={focusMode ? <IconMinimize size={16} stroke={1.7} /> : <IconMaximize size={16} stroke={1.7} />} on={onToggleFocus} active={focusMode} title="Focus mode" />
      </div>

      {/* Writing surface */}
      <div className="nb-editor-print" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <EditorContent editor={editor} />
      </div>

      {/* Stats bar */}
      <div className="nb-statsbar" style={{
        display: 'flex', gap: 16, flexShrink: 0, padding: '5px 14px', fontSize: 10, letterSpacing: '0.06em',
        color: 'rgba(255,255,255,0.4)', background: 'rgba(8,12,30,0.92)', borderTop: `0.5px solid ${cfg.border}`,
      }}>
        <span>{words} words</span><span>{chars} chars</span><span>{readMin} min read</span>
      </div>

      {/* Thought bubble */}
      {bubble && (
        <div className="nb-bubble animate-fadeIn" style={{ position: 'absolute', left: Math.max(8, bubble.x), top: bubble.y, zIndex: 40, maxWidth: 200 }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', marginBottom: 8 }}>{bubble.q}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onMouseDown={e => { e.preventDefault(); if (editor) bubble.apply(editor); setBubble(null) }}
              style={{ flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', cursor: 'pointer', background: EDITOR_BLUE, color: '#fff', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }}>Yes</button>
            <button onMouseDown={e => { e.preventDefault(); suppressRef.current[bubble.key] = Date.now() + 5 * 60 * 1000; setBubble(null) }}
              style={{ flex: 1, padding: '4px 0', borderRadius: 6, border: '0.5px solid rgba(255,255,255,0.15)', cursor: 'pointer', background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: 11, fontFamily: 'inherit' }}>No</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Creation modal for a folder or notebook (Title + color + emoji). Inside a folder, only
// the Notebook option is offered (folders never nest — the 2-level cap).
function NotebookCreationModal({ parentId, forcedType, onCreate, onClose }: {
  parentId: string
  forcedType?: 'folder' | 'notebook'
  onCreate: (opts: { title: string; type: 'folder' | 'notebook'; color: string; icon: string }) => void
  onClose: () => void
}) {
  // Folders and documents can both be created at any level (the + dropdown picks the type).
  const type: 'folder' | 'notebook' = forcedType ?? 'notebook'
  const [title, setTitle] = useState('')
  const submit = () => { if (title.trim()) { onCreate({ title: title.trim(), type, color: '', icon: '' }); onClose() } }
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 320, padding: 20, borderRadius: 12, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 11, color: NB_TEAL, letterSpacing: '0.1em', fontWeight: 700 }}>
          {type === 'folder' ? 'NEW FOLDER' : 'NEW DOCUMENT'}
        </div>
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() }}
          placeholder={type === 'folder' ? 'Folder name' : 'Document title'}
          style={{ background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 14, fontFamily: 'inherit', outline: 'none' }} />
        <button onClick={submit} disabled={!title.trim()} style={{ marginTop: 4, padding: '9px 0', borderRadius: 8, border: 'none', cursor: title.trim() ? 'pointer' : 'default', background: title.trim() ? NB_TEAL : 'rgba(255,255,255,0.08)', color: title.trim() ? '#04120c' : 'rgba(255,255,255,0.3)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'inherit' }}>CREATE</button>
      </div>
    </div>
  )
}

// The Docu-scape library: NOTEBOOKS (type='folder' — containers) hold DOCUMENTS
// (type='notebook' — pages with content). Grid (state 1) + open-notebook view (state 2).
// Full file management: drag-to-move/merge, multi-select, context menus, duplicate,
// rename (inline + double-click), delete-with-confirm, and keyboard shortcuts.
function NotebookLibrary({
  nodeId, notebooks, folderId, setFolderId, onOpen, onCreate, onRename, onDelete, onColor, onMove, onReorder, onMerge, onDuplicate, cfg,
}: {
  nodeId: string
  notebooks: NotebookMeta[]
  folderId: string
  setFolderId: (id: string) => void
  onOpen: (nb: NotebookMeta) => void
  onCreate: (opts: { title: string; type: 'folder' | 'notebook'; color: string; icon: string }, parentId: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onColor: (id: string, color: string) => void
  onMove: (id: string, parentId: string) => void
  onReorder: (parentId: string, orderedIds: string[]) => void
  onMerge: (srcId: string, targetId: string, folderName: string) => void
  onDuplicate: (id: string) => void
  cfg: OrbCfg
}) {
  // `creating` holds the type being created (null = closed). At top level the + button is
  // a dropdown (New Document = a 'notebook', New Notebook = a 'folder'); inside a Notebook
  // only Documents can be added.
  const [creating, setCreating] = useState<'folder' | 'notebook' | null>(null)
  const [createMenu, setCreateMenu] = useState(false)
  // Drag-to-merge: dropping one Document onto another (top level) offers to bundle them
  // into a new Notebook. Two-step modal: confirm, then name.
  const [merge, setMerge] = useState<{ srcId: string; targetId: string; step: 'confirm' | 'name' } | null>(null)
  const [mergeName, setMergeName] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; sub: 'move' | 'color' | null } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  // Multi-select (Shift / Cmd / Ctrl click, Cmd+A). Bulk actions apply to every id here.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selMove, setSelMove] = useState(false)
  // Notebook (folder) being hovered as a drop target → teal highlight.
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Pending soft-delete confirmation (ids). Set from a menu, the toolbar, or a keystroke.
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null)
  const dragId = useRef<string | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const items = notebooks.filter(n => n.parent_id === folderId)
  const folders = notebooks.filter(n => n.type === 'folder')
  // Live child count for a folder card (documents + subfolders directly inside it).
  const childCount = (fid: string) => notebooks.filter(n => n.parent_id === fid).length
  // Is `id` a descendant of `ancestorId`? Guards folder moves against cycles.
  const isDescendantOf = (id: string, ancestorId: string): boolean => {
    let cur = notebooks.find(n => n.id === id)?.parent_id
    while (cur) { if (cur === ancestorId) return true; cur = notebooks.find(n => n.id === cur)?.parent_id }
    return false
  }

  // Selection resets whenever the level changes (entering/leaving a Notebook).
  useEffect(() => { setSelected(new Set()) }, [folderId])

  // The context menu is portaled to <body> (so it escapes the panel's transformed,
  // overflow-clipped ancestors). Close it on any outside pointer-down or on scroll.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null) }
    const onScroll = () => setMenu(null)
    // Defer attach so the opening right-click's own mousedown doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      window.addEventListener('scroll', onScroll, true)
    }, 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); window.removeEventListener('scroll', onScroll, true) }
  }, [menu])

  const clearSel = () => setSelected(new Set())
  const toggleSel = (id: string) => setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })

  const openMenu = (e: React.MouseEvent, id: string) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY, sub: null }) }
  const startRename = (nb: NotebookMeta) => { setRenaming(nb.id); setRenameVal(nb.title); setMenu(null) }
  const commitRename = (id: string) => { if (renameVal.trim()) onRename(id, renameVal.trim()); setRenaming(null) }

  // Dropping onto a card: Document→Notebook moves inside; Document→Document (top level)
  // bundles into a new Notebook; anything else reorders within the current level.
  const handleDropOnCard = (targetId: string) => {
    const src = dragId.current; dragId.current = null; setDragOverId(null)
    if (!src || src === targetId) return
    const srcNb = notebooks.find(n => n.id === src)
    const targetNb = notebooks.find(n => n.id === targetId)
    if (!srcNb || !targetNb) return
    // Drop onto a folder → move inside it (documents AND folders nest). Block moving a folder
    // into its own descendant (would orphan the subtree).
    if (targetNb.type === 'folder') {
      if (srcNb.type === 'folder' && isDescendantOf(targetId, src)) return
      onMove(src, targetId); return
    }
    if (folderId === '' && srcNb.type === 'notebook' && targetNb.type === 'notebook') {
      setMergeName(''); setMerge({ srcId: src, targetId, step: 'confirm' }); return
    }
    const ids = items.map(i => i.id)
    const from = ids.indexOf(src), to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    onReorder(folderId, ids)
  }

  // Dropping on empty grid space: a Document dragged out of a Notebook returns to top level.
  const handleDropOnGrid = () => {
    const src = dragId.current; dragId.current = null; setDragOverId(null)
    if (!src) return
    const srcNb = notebooks.find(n => n.id === src)
    if (srcNb?.type === 'notebook' && folderId !== '' && srcNb.parent_id !== '') onMove(src, '')
  }

  // Keyboard shortcuts — only while the grid is focused, never while typing in an input.
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(new Set(items.map(i => i.id))); return }
    if (e.key === 'Escape') { clearSel(); setMenu(null); return }
    if (selected.size === 0) return
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setConfirmDel(Array.from(selected)); return }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); selected.forEach(id => onDuplicate(id)); clearSel(); return }
    if ((e.key === 'F2' || e.key === 'Enter') && selected.size === 1) {
      const nb = notebooks.find(n => n.id === Array.from(selected)[0]); if (nb) startRename(nb)
    }
  }

  const moveSelected = (parentId: string) => {
    selected.forEach(id => {
      const nb = notebooks.find(n => n.id === id)
      if (!nb) return
      if (nb.type === 'folder' && parentId !== '' && (id === parentId || isDescendantOf(parentId, id))) return
      onMove(id, parentId)
    })
    clearSel(); setSelMove(false)
  }

  const card = (nb: NotebookMeta): React.ReactNode => {
    const isFolder = nb.type === 'folder'
    const isSel = selected.has(nb.id)
    const isDropTarget = dragOverId === nb.id
    let preview = ''
    if (!isFolder) { try { preview = nb.content ? tiptapPreview(JSON.parse(nb.content), 100) : '' } catch { preview = '' } }
    return (
      <div
        key={nb.id}
        draggable
        onDragStart={() => { dragId.current = nb.id }}
        onDragEnd={() => { setDragOverId(null) }}
        onDragOver={e => {
          e.preventDefault()
          const src = dragId.current
          // Highlight a folder as a drop target for any item, except a folder dropped into its own descendant.
          if (isFolder && src && src !== nb.id && !(notebooks.find(n => n.id === src)?.type === 'folder' && isDescendantOf(nb.id, src))) setDragOverId(nb.id)
        }}
        onDragLeave={() => { if (dragOverId === nb.id) setDragOverId(null) }}
        onDrop={e => { e.stopPropagation(); handleDropOnCard(nb.id) }}
        onClick={e => {
          if (renaming === nb.id) return
          if (e.shiftKey || e.metaKey || e.ctrlKey) { e.stopPropagation(); toggleSel(nb.id); gridRef.current?.focus(); return }
          // Plain click opens — delayed so a double-click (rename) can cancel it.
          if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null }
          clickTimer.current = setTimeout(() => { clickTimer.current = null; clearSel(); isFolder ? setFolderId(nb.id) : onOpen(nb) }, 200)
        }}
        onContextMenu={e => openMenu(e, nb.id)}
        onTouchStart={() => { longPressRef.current = setTimeout(() => setMenu({ id: nb.id, x: 0, y: 0, sub: null }), 550) }}
        onTouchEnd={() => { if (longPressRef.current) clearTimeout(longPressRef.current) }}
        className="nb-card"
        style={{
          width: 140, height: 124, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: 12,
          borderRadius: 10, cursor: 'pointer',
          border: (isDropTarget || isSel) ? `1.5px solid ${NB_TEAL}` : `0.5px solid ${cfg.border}`,
          background: isSel ? 'rgba(29,158,117,0.12)' : isDropTarget ? 'rgba(29,158,117,0.08)' : 'rgba(255,255,255,0.02)',
          position: 'relative', overflow: 'hidden', transition: 'transform 0.12s, border-color 0.12s, background 0.12s',
        }}
      >
        {isFolder ? (
          <IconFolder size={30} stroke={1.4} color={NB_TEAL} />
        ) : (
          <IconFileText size={28} stroke={1.3} color="rgba(255,255,255,0.45)" />
        )}
        {!isFolder && preview && (
          <div style={{ fontSize: 9, lineHeight: 1.4, color: 'rgba(255,255,255,0.3)', overflow: 'hidden', maxHeight: 38, flex: 1 }}>{preview}</div>
        )}
        {!isFolder && !preview && <div style={{ flex: 1 }} />}
        {renaming === nb.id ? (
          <input autoFocus value={renameVal} onClick={e => e.stopPropagation()} onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(nb.id)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(nb.id); if (e.key === 'Escape') setRenaming(null) }}
            style={{ background: 'rgba(0,0,0,0.4)', border: `0.5px solid ${NB_TEAL}`, borderRadius: 5, padding: '3px 5px', color: '#fff', fontSize: 12, fontFamily: 'inherit', outline: 'none', width: '100%' }} />
        ) : (
          <div onDoubleClick={e => { e.stopPropagation(); if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null } startRename(nb) }}
            style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{nb.title}</div>
        )}
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>
          {isFolder ? `${childCount(nb.id)} item${childCount(nb.id) === 1 ? '' : 's'}` : relativeTime(nb.updated_at)}
        </div>
      </div>
    )
  }

  const toolbarBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: NB_TEAL, fontSize: 10, letterSpacing: '0.06em', fontWeight: 700, fontFamily: 'inherit', padding: '2px 4px' }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px', background: NB_TEAL_TINT, position: 'relative' }}
      onClick={() => { if (menu) setMenu(null); if (createMenu) setCreateMenu(false); if (selMove) setSelMove(false) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {folderId ? (() => {
          // Walk up parent_id to build the breadcrumb path root → current folder.
          const path: NotebookMeta[] = []
          let c: string = folderId
          while (c) { const f = notebooks.find(n => n.id === c); if (!f) break; path.unshift(f); c = f.parent_id }
          const parentOfCurrent = path.length >= 2 ? path[path.length - 2].id : ''
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' }}>
              <button onClick={() => setFolderId(parentOfCurrent)} title="Up one level" style={{ background: 'none', border: 'none', cursor: 'pointer', color: NB_TEAL, display: 'flex', flexShrink: 0 }}><IconArrowLeft size={15} stroke={1.8} /></button>
              <button onClick={() => setFolderId('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.45)', fontWeight: 700, fontFamily: 'inherit', flexShrink: 0 }}>DOCUMENTS</button>
              {path.map((f, i) => (
                <span key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>›</span>
                  <button onClick={() => setFolderId(f.id)} title={f.title} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, letterSpacing: '0.08em', color: i === path.length - 1 ? NB_TEAL : 'rgba(255,255,255,0.55)', fontWeight: 700, fontFamily: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120, flexShrink: i === path.length - 1 ? 1 : 0 }}>{f.title.toUpperCase()}</button>
                </span>
              ))}
            </div>
          )
        })() : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <IconFolder size={14} stroke={1.7} color={NB_TEAL} />
            <span style={{ fontSize: 10, letterSpacing: '0.2em', fontWeight: 700, color: 'rgba(255,255,255,0.55)' }}>DOCUMENTS</span>
          </div>
        )}
        {selected.size > 0 ? (
          /* Bulk-action toolbar — visible whenever cards are selected. */
          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontWeight: 700, letterSpacing: '0.06em' }}>{selected.size} SELECTED</span>
            <button style={toolbarBtn} onClick={() => { selected.forEach(id => onDuplicate(id)); clearSel() }}>DUPLICATE</button>
            <div style={{ position: 'relative' }}>
              <button style={toolbarBtn} onClick={() => setSelMove(v => !v)}>MOVE ▾</button>
              {selMove && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 25, minWidth: 150, maxHeight: 220, overflowY: 'auto', borderRadius: 8, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', padding: '4px 0' }}>
                  <div style={{ padding: '7px 12px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }} onClick={() => moveSelected('')}>↑ Top level</div>
                  {folders.map(f => <div key={f.id} style={{ padding: '7px 12px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }} onClick={() => moveSelected(f.id)}>{f.title}</div>)}
                  {folders.length === 0 && <div style={{ padding: '7px 12px', fontSize: 12, color: 'rgba(255,255,255,0.3)', fontFamily: 'inherit' }}>No folders</div>}
                </div>
              )}
            </div>
            <button style={{ ...toolbarBtn, color: '#F87171' }} onClick={() => setConfirmDel(Array.from(selected))}>DELETE</button>
            <button style={{ ...toolbarBtn, color: 'rgba(255,255,255,0.5)' }} onClick={clearSel}>✕</button>
          </div>
        ) : (
          /* New ▾ dropdown — document or folder, at any level (folders nest). */
          <div style={{ position: 'relative' }}>
            <button onClick={() => setCreateMenu(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: NB_TEAL, fontSize: 10, letterSpacing: '0.08em', fontWeight: 700, fontFamily: 'inherit' }}>
              <IconPlus size={13} stroke={1.8} /> NEW <IconChevronDown size={11} stroke={2} />
            </button>
            {createMenu && (
              <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20, minWidth: 150, borderRadius: 8, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', overflow: 'hidden', padding: '4px 0' }}>
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'rgba(255,255,255,0.85)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'inherit' }}
                  onClick={() => { setCreateMenu(false); setCreating('notebook') }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }} onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
                  <IconFileText size={14} stroke={1.4} color="rgba(255,255,255,0.55)" /> New document
                </div>
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'rgba(255,255,255,0.85)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'inherit' }}
                  onClick={() => { setCreateMenu(false); setCreating('folder') }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }} onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
                  <IconFolder size={14} stroke={1.4} color={NB_TEAL} /> New folder
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown}
        onClick={e => { if (e.target === e.currentTarget) clearSel() }}
        onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); handleDropOnGrid() }}
        className="nb-grid animate-fadeIn" key={folderId} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 12, alignContent: 'flex-start', outline: 'none' }}>
        {items.length === 0 ? (
          <div onClick={() => setCreating('notebook')} style={{ flex: 1, minHeight: 140, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, border: '1.5px dashed rgba(29,158,117,0.35)', borderRadius: 10, cursor: 'pointer' }}>
            <IconNotebook size={26} stroke={1.4} color={NB_TEAL} style={{ opacity: 0.7 }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em' }}>{folderId ? 'Drop documents here or click + New Document' : 'Create your first document'}</span>
            <span style={{ fontSize: 10, color: NB_TEAL, letterSpacing: '0.1em', fontWeight: 700 }}>+ NEW DOCUMENT</span>
          </div>
        ) : items.map(card)}
      </div>

      {creating && <NotebookCreationModal parentId={folderId} forcedType={creating} onCreate={opts => onCreate(opts, folderId)} onClose={() => setCreating(null)} />}

      {/* Drag-to-merge prompt: confirm, then name the new Notebook. */}
      {merge && (() => {
        const srcNb = notebooks.find(n => n.id === merge.srcId)
        const targetNb = notebooks.find(n => n.id === merge.targetId)
        return (
          <div onMouseDown={() => setMerge(null)} style={{ position: 'absolute', inset: 0, zIndex: 65, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: 320, padding: 22, borderRadius: 12, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {merge.step === 'confirm' ? (
                <>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
                    Create a folder with <strong style={{ color: '#fff' }}>{srcNb?.title}</strong> and <strong style={{ color: '#fff' }}>{targetNb?.title}</strong>?
                  </div>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button onClick={() => setMerge(null)} style={{ padding: '8px 16px', borderRadius: 6, border: '0.5px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>No</button>
                    <button onClick={() => { setMergeName('New Folder'); setMerge({ ...merge, step: 'name' }) }} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: NB_TEAL, color: '#04120c', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>Yes</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.04em' }}>Name this folder</div>
                  <input autoFocus value={mergeName} onChange={e => setMergeName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && mergeName.trim()) { onMerge(merge.srcId, merge.targetId, mergeName.trim()); setMerge(null) } if (e.key === 'Escape') setMerge(null) }}
                    placeholder="Folder name"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: 14, fontFamily: 'inherit', outline: 'none' }} />
                  <button onClick={() => { if (mergeName.trim()) { onMerge(merge.srcId, merge.targetId, mergeName.trim()); setMerge(null) } }} disabled={!mergeName.trim()}
                    style={{ padding: '9px 0', borderRadius: 8, border: 'none', cursor: mergeName.trim() ? 'pointer' : 'default', background: mergeName.trim() ? NB_TEAL : 'rgba(255,255,255,0.08)', color: mergeName.trim() ? '#04120c' : 'rgba(255,255,255,0.3)', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'inherit' }}>CREATE FOLDER</button>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* Delete confirmation (single, bulk, or a Notebook + its Documents). */}
      {confirmDel && (() => {
        const hasFolder = confirmDel.some(id => notebooks.find(n => n.id === id)?.type === 'folder')
        const only = confirmDel.length === 1 ? notebooks.find(n => n.id === confirmDel[0]) : null
        return (
          <div onMouseDown={() => setConfirmDel(null)} style={{ position: 'absolute', inset: 0, zIndex: 66, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ width: 320, padding: 22, borderRadius: 12, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <span style={{ fontSize: 11, letterSpacing: '0.2em', color: '#F87171', fontWeight: 700 }}>DELETE</span>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
                Delete {only ? <strong style={{ color: '#fff' }}>{only.title}</strong> : `${confirmDel.length} items`}?
                {hasFolder && <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>This will also delete all documents inside.</span>}
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setConfirmDel(null)} style={{ padding: '8px 16px', borderRadius: 6, border: '0.5px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { confirmDel.forEach(id => onDelete(id)); setConfirmDel(null); clearSel() }} style={{ padding: '8px 16px', borderRadius: 6, border: '0.5px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.12)', color: '#F87171', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>Delete</button>
              </div>
            </div>
          </div>
        )
      })()}

      {menu && typeof document !== 'undefined' && (() => {
        const nb = notebooks.find(n => n.id === menu.id); if (!nb) return null
        const isFolder = nb.type === 'folder'
        const itemStyle: React.CSSProperties = { padding: '7px 12px', fontSize: 12, color: 'rgba(255,255,255,0.8)', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }
        return createPortal((
          <div ref={menuRef} onClick={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()} style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 220), zIndex: 9999, minWidth: 150, borderRadius: 8, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', overflow: 'visible', padding: '4px 0', boxShadow: '0 8px 28px rgba(0,0,0,0.5)', fontFamily: 'inherit' }}>
            <div style={itemStyle} onClick={() => startRename(nb)}>Rename</div>
            <div style={{ ...itemStyle, position: 'relative' }} onClick={() => setMenu({ ...menu, sub: menu.sub === 'move' ? null : 'move' })}>
              Move to ›
              {menu.sub === 'move' && (() => {
                // Valid targets: any folder that isn't this item, its current parent, or — for a folder — its own descendant.
                const targets = folders.filter(f => f.id !== nb.id && f.id !== nb.parent_id && !(isFolder && isDescendantOf(f.id, nb.id)))
                return (
                  <div style={{ position: 'absolute', left: '100%', top: 0, minWidth: 140, maxHeight: 220, overflowY: 'auto', borderRadius: 8, background: 'rgba(10,14,32,0.99)', border: '0.5px solid rgba(255,255,255,0.12)', padding: '4px 0' }}>
                    {nb.parent_id !== '' && <div style={itemStyle} onClick={() => { onMove(nb.id, ''); setMenu(null) }}>↑ Top level</div>}
                    {targets.map(f => <div key={f.id} style={itemStyle} onClick={() => { onMove(nb.id, f.id); setMenu(null) }}>{f.title}</div>)}
                    {targets.length === 0 && nb.parent_id === '' && <div style={{ ...itemStyle, color: 'rgba(255,255,255,0.3)' }}>No folders</div>}
                  </div>
                )
              })()}
            </div>
            <div style={itemStyle} onClick={() => { onDuplicate(nb.id); setMenu(null) }}>Duplicate</div>
            <div style={{ ...itemStyle, color: '#F87171' }} onClick={() => { setConfirmDel([nb.id]); setMenu(null) }}>Delete</div>
          </div>
        ), document.body)
      })()}
    </div>
  )
}

// The right panel of a Project Hand workspace: SOURCES (top, amber — reference file
// uploads) over the NOTEBOOKS library/editor (bottom, teal — Docu-scape).
// File preview panel (Spectre's openFile action / clicking a Source row). Renders the
// previewed file inline — image via <img>, PDF embedded via <iframe>, text/markdown
// fetched + rendered — over the right panel. × returns to the normal Sources view.
const PREVIEW_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']
const PREVIEW_TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'text']
function FilePreview({ file, onClose, cfg }: { file: SourceFile; onClose: () => void; cfg: OrbCfg }) {
  const ext = (file.file_type || '').toLowerCase()
  const kind = ext === 'pdf' ? 'pdf' : PREVIEW_IMAGE_EXT.includes(ext) ? 'image' : PREVIEW_TEXT_EXT.includes(ext) ? 'text' : 'other'
  const rawUrl = `/api/files/${file.id}/raw`
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(kind === 'text')

  useEffect(() => {
    if (kind !== 'text') return
    let alive = true
    setLoading(true)
    fetch(`/api/files/${file.id}/content`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (alive) setText(typeof d.content === 'string' ? d.content : '(empty)') })
      .catch(() => { if (alive) setText('(Could not load this file.)') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [file.id, kind])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px', borderBottom: `0.5px solid ${cfg.border}`, flexShrink: 0, background: SRC_AMBER_TINT }}>
        <IconPaperclip size={14} stroke={1.7} color={SRC_AMBER} />
        <span style={{ flex: 1, fontSize: '12px', color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.filename}</span>
        <button
          onClick={onClose}
          aria-label="Close preview"
          title="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', display: 'flex', padding: '2px' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
        >
          <IconX size={16} stroke={1.8} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: kind === 'image' ? '16px' : 0, display: 'flex', flexDirection: 'column' }}>
        {kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={rawUrl} alt={file.filename} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', margin: 'auto', borderRadius: '6px' }} />
        )}
        {kind === 'pdf' && (
          <iframe src={rawUrl} title={file.filename} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
        )}
        {kind === 'text' && (
          loading
            ? <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', padding: '18px' }}>Loading…</span>
            : <pre style={{ margin: 0, padding: '18px', fontSize: '12px', lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' }}>{text}</pre>
        )}
        {kind === 'other' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '24px', textAlign: 'center' }}>
            <IconPaperclip size={28} stroke={1.4} color={SRC_AMBER} style={{ opacity: 0.7 }} />
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>{file.filename}</span>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>Full content available — ask me to read it.</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── The project map — constrained-lanes progress map (TASKS-PLAN §4) ────────────────
// A full-screen overlay. Layout is COMPUTED from each task's sparse (step, lane): steps sort
// into left-to-right columns, parallel tasks stack in a column. Drag reorders (fractional
// insert — one row written, never a renumber). v1 pan = native scroll, zoom = 3 discrete
// steps, phases = click-multi-select. Desktop-first; it's a planning surface.
type MapTask = {
  id: string; node_id: string; title: string; notes: string; status: string; is_archived: number
  step: number | null; lane: number; phase_id: string; due_at: string | null; block_event_id: string
  position: number; created_at: number
}
type MapPhase = { id: string; node_id: string; name: string; color: string; position: number }

const MAP_COL_W = 212, MAP_ROW_H = 100, MAP_CARD_W = 180, MAP_INBOX_W = 196, MAP_TOP = 46, MAP_ZOOMS = [0.62, 0.82, 1.04]
const MAP_TASKS_C = '#F59E0B', MAP_PROJ_C = '#A855F7'
const MAP_PHASE_PALETTE = ['#7F77DD', '#378ADD', '#1D9E75', '#D85A30', '#639922', '#C678DD']

function MapOverlay({ nodeId, nodeName, cfg, onClose, onChange }: {
  nodeId: string; nodeName: string; cfg: OrbCfg; onClose: () => void; onChange: () => void
}) {
  const [tasks, setTasks] = useState<MapTask[]>([])
  const [phases, setPhases] = useState<MapPhase[]>([])
  const [zoomIdx, setZoomIdx] = useState(1)
  const [hideDone, setHideDone] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [pop, setPop] = useState<{ id: string; x: number; y: number } | null>(null)
  const [phaseNaming, setPhaseNaming] = useState(false)
  const [phaseName, setPhaseName] = useState('')
  const [addTitle, setAddTitle] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const dragStartRef = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null)
  // Secretary chat (the map's docked direct-access bar) + the structural review queue.
  const [secMsgs, setSecMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [secInput, setSecInput] = useState('')
  const [secBusy, setSecBusy] = useState(false)
  const [secStatus, setSecStatus] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [proposal, setProposal] = useState<{ id: string; summary: string; actions: any[] } | null>(null)
  const [approved, setApproved] = useState<Set<number>>(new Set())
  const [reviewOpen, setReviewOpen] = useState(false)
  const secLogRef = useRef<HTMLDivElement>(null)
  // Recent-changes / undo surface — the durable safety valve for the auto-add tier.
  const [recentOpen, setRecentOpen] = useState(false)
  const [recent, setRecent] = useState<{ id: string; op: string; title: string; actor: string; created_at: number }[]>([])

  const load = useCallback(async () => {
    try {
      const [tr, pr, propr] = await Promise.all([
        fetch(`/api/tasks?node_id=${encodeURIComponent(nodeId)}&include_done=1`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/phases?node_id=${encodeURIComponent(nodeId)}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`/api/secretary/proposals?node_id=${encodeURIComponent(nodeId)}`, { cache: 'no-store' }).then(r => r.json()),
      ])
      if (Array.isArray(tr.tasks)) setTasks(tr.tasks)
      if (Array.isArray(pr.phases)) setPhases(pr.phases)
      if (propr.proposal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let acts: any[] = []
        try { acts = JSON.parse(propr.proposal.actions_json) } catch { /* corrupt */ }
        setProposal({ id: propr.proposal.id, summary: propr.proposal.summary, actions: acts })
        setApproved(new Set(acts.map((_, i) => i)))   // pre-checked (review-then-apply)
      } else setProposal(null)
    } catch { /* offline */ }
  }, [nodeId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (pop) setPop(null); else if (selected.size) setSelected(new Set()); else onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pop, selected.size])

  const reload = useCallback(async () => { await load(); onChange() }, [load, onChange])
  const batch = useCallback(async (ops: unknown[]) => {
    try { await fetch('/api/tasks/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) }) } catch { /* offline */ }
    reload()
  }, [reload])
  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>) => {
    try { await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }) } catch { /* offline */ }
    reload()
  }, [reload])
  const addTask = useCallback(async (title: string, relation: 'end' | 'inbox') => {
    const t = title.trim(); if (!t) return
    try {
      await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(relation === 'inbox' ? { title: t, node_id: nodeId } : { title: t, node_id: nodeId, step_relation: 'end' }),
      })
    } catch { /* offline */ }
    reload()
  }, [nodeId, reload])

  // ── Layout ────────────────────────────────────────────────────────────────────────
  const live = tasks.filter(t => !t.is_archived && t.status !== 'dropped' && (!hideDone || t.status !== 'done'))
  const mapTasks = live.filter(t => t.step !== null)
  const inbox = live.filter(t => t.step === null)
  const steps = [...new Set(mapTasks.map(t => t.step as number))].sort((a, b) => a - b)
  const colOf = new Map(steps.map((s, i) => [s, i]))
  const ncols = steps.length
  const maxLane = Math.max(0, ...mapTasks.map(t => t.lane))
  const canvasW = MAP_INBOX_W + Math.max(1, ncols) * MAP_COL_W + 60
  const canvasH = MAP_TOP + (maxLane + 1) * MAP_ROW_H + 40
  const xOf = (step: number) => MAP_INBOX_W + (colOf.get(step) ?? 0) * MAP_COL_W + (MAP_COL_W - MAP_CARD_W) / 2
  const yOf = (lane: number) => MAP_TOP + lane * MAP_ROW_H
  const zoom = MAP_ZOOMS[zoomIdx]
  const doneCount = tasks.filter(t => t.status === 'done' && !t.is_archived).length
  const totalCount = tasks.filter(t => t.status !== 'dropped' && !t.is_archived).length
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0

  // ── Drag (pointer events; drop zones hit-tested via elementFromPoint) ───────────────
  const onCardPointerDown = (e: React.PointerEvent, task: MapTask) => {
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      setSelected(s => { const n = new Set(s); n.has(task.id) ? n.delete(task.id) : n.add(task.id); return n })
      return
    }
    e.preventDefault()
    dragStartRef.current = { id: task.id, sx: e.clientX, sy: e.clientY, moved: false }
    const move = (ev: PointerEvent) => {
      const st = dragStartRef.current; if (!st) return
      if (!st.moved && Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < 6) return
      st.moved = true
      setDrag({ id: st.id, x: ev.clientX, y: ev.clientY })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const moved = dragStartRef.current?.moved
      dragStartRef.current = null
      setDrag(null)
      if (!moved) { setPop({ id: task.id, x: Math.min(ev.clientX, window.innerWidth - 240), y: Math.min(ev.clientY, window.innerHeight - 260) }); return }
      const zone = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-drop]') as HTMLElement | null
      if (!zone) return
      const drop = zone.dataset.drop
      if (drop === 'inbox') batch([{ op: 'unplace', id: task.id }])
      else if (drop === 'gap') batch([{ op: 'place', id: task.id, relation: zone.dataset.rel, anchor_id: zone.dataset.anchor || undefined }])
      else if (drop === 'parallel') batch([{ op: 'place', id: task.id, relation: 'parallel', anchor_id: zone.dataset.anchor }])
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const createPhase = async () => {
    const name = phaseName.trim(); if (!name || !selected.size) { setPhaseNaming(false); setPhaseName(''); return }
    try {
      const color = MAP_PHASE_PALETTE[phases.length % MAP_PHASE_PALETTE.length]
      const res = await fetch('/api/phases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId, name, color }) })
      const data = await res.json()
      if (data.phase?.id) await Promise.all([...selected].map(id => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase_id: data.phase.id }) })))
    } catch { /* offline */ }
    setPhaseNaming(false); setPhaseName(''); setSelected(new Set()); reload()
  }
  const deletePhase = async (id: string) => { try { await fetch(`/api/phases/${id}`, { method: 'DELETE' }) } catch { /* offline */ } reload() }

  // Direct Secretary chat — the docked bar. Optimistic echo (never dead air), NDJSON stream,
  // then reload so the map reflects whatever it did.
  const sendSecretary = async () => {
    const text = secInput.trim(); if (!text || secBusy) return
    const history = secMsgs.slice(-10)
    setSecMsgs(m => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setSecInput(''); setSecBusy(true); setSecStatus('Filing…')
    setTimeout(() => secLogRef.current?.scrollTo({ top: 1e6 }), 30)
    const setLast = (c: string) => setSecMsgs(m => { const n = [...m]; for (let i = n.length - 1; i >= 0; i--) if (n[i].role === 'assistant') { n[i] = { role: 'assistant', content: c }; break } return n })
    try {
      const res = await fetch('/api/secretary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, node_id: nodeId, history }) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let answer = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let ev: any; try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'text') { answer += ev.delta; setSecStatus(null); setLast(answer); secLogRef.current?.scrollTo({ top: 1e6 }) }
          else if (ev.type === 'status') setSecStatus(String(ev.label))
        }
      }
      setLast(answer || 'Done.')
    } catch (e) { setLast(`⚠️ ${e instanceof Error ? e.message : 'The Secretary is unreachable.'}`) }
    finally { setSecBusy(false); setSecStatus(null); reload() }
  }
  const applyProposal = async () => {
    if (!proposal) return
    try { await fetch('/api/secretary/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'apply', id: proposal.id, approved: [...approved] }) }) } catch { /* offline */ }
    setReviewOpen(false); reload()
  }
  const dismissProposal = async () => {
    if (!proposal) return
    try { await fetch('/api/secretary/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'dismiss', id: proposal.id }) }) } catch { /* offline */ }
    setReviewOpen(false); reload()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const describeAction = (a: any): string => {
    const rel = a.step_relation ? ` (${a.step_relation}${a.anchor_title ? ` "${a.anchor_title}"` : ''})` : ''
    if (a.op === 'create') return `Add "${a.title}"${rel}${a.phase ? ` · phase ${a.phase}` : ''}`
    if (a.op === 'move') return `Move a task${rel}`
    if (a.op === 'delete') return `Delete a task`
    if (a.op === 'merge') return `Merge ${(a.task_ids || []).length} tasks → "${a.into_title}"`
    if (a.op === 'set_phase') return `Label ${(a.task_ids || []).length} tasks · phase ${a.phase}`
    return a.op
  }

  const loadRecent = async () => {
    try { const r = await fetch(`/api/tasks/undo?node_id=${encodeURIComponent(nodeId)}&limit=14`, { cache: 'no-store' }).then(x => x.json()); if (Array.isArray(r.events)) setRecent(r.events) } catch { /* offline */ }
  }
  const undoEvent = async (eventId: string) => {
    try { await fetch('/api/tasks/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: eventId }) }) } catch { /* offline */ }
    await loadRecent(); reload()
  }
  const OP_VERB: Record<string, string> = { create: 'Added', complete: 'Completed', reopen: 'Reopened', move: 'Moved', assign: 'Scheduled', unassign: 'Unscheduled', drop: 'Deleted', archive: 'Archived', update: 'Edited' }

  const popTask = pop ? tasks.find(t => t.id === pop.id) : null

  return (
    <div onClick={onClose} className="animate-fadeIn"
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', flexDirection: 'column',
        background: 'radial-gradient(ellipse 70% 55% at 50% 20%, rgba(245,158,11,0.08), transparent 66%), radial-gradient(ellipse 60% 60% at 80% 85%, rgba(168,85,247,0.06), transparent 70%), radial-gradient(ellipse 80% 80% at 50% 50%, rgba(4,7,18,0.55) 30%, rgba(2,4,12,0.86) 100%)',
        backdropFilter: 'blur(22px) saturate(1.1)', WebkitBackdropFilter: 'blur(22px) saturate(1.1)' }}>
      {/* toolbar */}
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '16px 26px', flexShrink: 0, borderBottom: `0.5px solid ${cfg.border}` }}>
        <IconListCheck size={17} color={MAP_TASKS_C} />
        <span style={{ fontSize: '13px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.9)', fontWeight: 700, textTransform: 'uppercase' }}>{nodeName} · Map</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginLeft: '4px' }}>
          <div style={{ width: '120px', height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: MAP_TASKS_C, boxShadow: `0 0 8px ${MAP_TASKS_C}`, transition: 'width .4s' }} />
          </div>
          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', fontVariantNumeric: 'tabular-nums' }}>{doneCount}/{totalCount}</span>
        </div>
        <div style={{ flex: 1 }} />
        <input value={addTitle} onChange={e => setAddTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { addTask(addTitle, 'end'); setAddTitle('') } }}
          placeholder="＋ add a step…"
          style={{ width: '190px', background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${cfg.border}`, borderRadius: '7px', padding: '6px 11px', fontSize: '12px', color: 'rgba(255,255,255,0.85)', outline: 'none' }} />
        <div style={{ position: 'relative' }}>
          <button onClick={() => { setRecentOpen(o => { if (!o) loadRecent(); return !o }) }} title="Recent changes — undo"
            style={{ fontSize: '10px', letterSpacing: '0.06em', color: recentOpen ? MAP_TASKS_C : 'rgba(255,255,255,0.5)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '6px', padding: '5px 10px', cursor: 'pointer' }}>↶ RECENT</button>
          {recentOpen && (
            <div style={{ position: 'absolute', top: '32px', right: 0, width: '280px', maxHeight: '340px', overflowY: 'auto', zIndex: 85, background: 'rgba(10,14,32,0.98)', border: `0.5px solid ${cfg.border}`, borderRadius: '10px', padding: '8px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
              {recent.length === 0 && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', padding: '6px' }}>No changes yet.</div>}
              {recent.map(ev => (
                <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 4px' }}>
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.75)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: ev.actor === 'secretary' ? MAP_TASKS_C : 'rgba(255,255,255,0.4)' }}>{OP_VERB[ev.op] ?? ev.op}</span> {ev.title || '(task)'}
                  </span>
                  <span onClick={() => undoEvent(ev.id)} style={{ fontSize: '10px', fontWeight: 600, color: MAP_TASKS_C, cursor: 'pointer', flexShrink: 0 }}>undo</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setHideDone(h => !h)} title="Hide completed"
          style={{ fontSize: '10px', letterSpacing: '0.06em', color: hideDone ? MAP_TASKS_C : 'rgba(255,255,255,0.5)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '6px', padding: '5px 10px', cursor: 'pointer' }}>{hideDone ? 'SHOW DONE' : 'HIDE DONE'}</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', border: `0.5px solid ${cfg.border}`, borderRadius: '6px' }}>
          <button onClick={() => setZoomIdx(i => Math.max(0, i - 1))} disabled={zoomIdx === 0} style={{ width: '26px', height: '26px', color: zoomIdx === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)', background: 'transparent', border: 'none', cursor: zoomIdx === 0 ? 'default' : 'pointer', fontSize: '15px' }}>−</button>
          <button onClick={() => setZoomIdx(i => Math.min(MAP_ZOOMS.length - 1, i + 1))} disabled={zoomIdx === MAP_ZOOMS.length - 1} style={{ width: '26px', height: '26px', color: zoomIdx === MAP_ZOOMS.length - 1 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)', background: 'transparent', border: 'none', cursor: zoomIdx === MAP_ZOOMS.length - 1 ? 'default' : 'pointer', fontSize: '15px' }}>＋</button>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', color: 'rgba(255,255,255,0.7)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '7px', cursor: 'pointer' }}>✕</button>
      </div>

      {/* canvas — native scroll pan; the inner plane is CSS-scaled for zoom */}
      <div onClick={e => { e.stopPropagation(); setPop(null) }} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px' }}>
        <div style={{ width: canvasW * zoom, height: canvasH * zoom }}>
          <div style={{ position: 'relative', width: canvasW, height: canvasH, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
            {/* connector spine — a horizontal line linking consecutive step columns */}
            {ncols > 1 && (
              <svg width={canvasW} height={canvasH} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {steps.slice(0, -1).map((s, i) => {
                  const x1 = MAP_INBOX_W + i * MAP_COL_W + MAP_COL_W / 2
                  const x2 = MAP_INBOX_W + (i + 1) * MAP_COL_W + MAP_COL_W / 2
                  const y = MAP_TOP + MAP_ROW_H / 2 - 12
                  return <line key={s} x1={x1} y1={y} x2={x2} y2={y} stroke={`${MAP_TASKS_C}44`} strokeWidth={2} />
                })}
              </svg>
            )}

            {/* phase brackets */}
            {phases.map(p => {
              const members = mapTasks.filter(t => t.phase_id === p.id)
              if (!members.length) return null
              const cols = members.map(t => colOf.get(t.step as number) ?? 0)
              const minC = Math.min(...cols), maxC = Math.max(...cols)
              const x = MAP_INBOX_W + minC * MAP_COL_W + 6
              const w = (maxC - minC + 1) * MAP_COL_W - 12
              return (
                <div key={p.id} style={{ position: 'absolute', left: x, top: 6, width: w, height: MAP_TOP - 14, borderRadius: '7px', border: `1px solid ${p.color || MAP_PHASE_PALETTE[0]}66`, background: `${p.color || MAP_PHASE_PALETTE[0]}12`, display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px' }}>
                  <span style={{ fontSize: '10px', letterSpacing: '0.1em', color: p.color || MAP_PHASE_PALETTE[0], fontWeight: 700, textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span onClick={e => { e.stopPropagation(); deletePhase(p.id) }} title="Remove phase label" style={{ marginLeft: 'auto', fontSize: '12px', color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>×</span>
                </div>
              )
            })}

            {/* INBOX column — unplaced tasks (drop here to un-place; drag out to place) */}
            <div data-drop={drag ? 'inbox' : undefined} style={{ position: 'absolute', left: 8, top: MAP_TOP - 6, width: MAP_INBOX_W - 20, minHeight: canvasH - MAP_TOP, borderRadius: '11px', border: `1px dashed ${drag ? `${MAP_TASKS_C}66` : cfg.border}`, background: drag ? `${MAP_TASKS_C}0c` : 'rgba(255,255,255,0.015)', padding: '8px', zIndex: drag ? 6 : 1 }}>
              <div style={{ fontSize: '9px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', fontWeight: 700, marginBottom: '8px' }}>INBOX</div>
              {inbox.length === 0 && <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.25)', lineHeight: 1.5 }}>Unplaced tasks land here. Drag onto the map to sequence them.</div>}
              {inbox.map(t => (
                <div key={t.id} onPointerDown={e => onCardPointerDown(e, t)}
                  style={{ marginBottom: '7px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${cfg.border}`, cursor: 'grab', opacity: drag?.id === t.id ? 0.3 : 1 }}>
                  <span style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.82)', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</span>
                </div>
              ))}
            </div>

            {/* drag drop-zones (gaps between/around columns + parallel-into-column) */}
            {drag && (
              <>
                {Array.from({ length: ncols + 1 }).map((_, i) => {
                  const rel = i === 0 ? 'start' : i === ncols ? 'end' : 'after'
                  const anchor = i > 0 ? (mapTasks.find(t => t.step === steps[i - 1])?.id ?? '') : ''
                  const x = MAP_INBOX_W + i * MAP_COL_W - 14
                  return <div key={`g${i}`} data-drop="gap" data-rel={rel} data-anchor={anchor}
                    style={{ position: 'absolute', left: x, top: MAP_TOP - 6, width: 28, height: canvasH - MAP_TOP, zIndex: 7, borderRadius: '6px', background: 'transparent', outline: '1px dashed transparent' }}
                    onPointerEnter={e => { e.currentTarget.style.background = `${MAP_TASKS_C}22`; e.currentTarget.style.outlineColor = `${MAP_TASKS_C}88` }}
                    onPointerLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.outlineColor = 'transparent' }} />
                })}
                {steps.map(s => (
                  <div key={`p${s}`} data-drop="parallel" data-anchor={mapTasks.find(t => t.step === s)?.id ?? ''}
                    style={{ position: 'absolute', left: MAP_INBOX_W + (colOf.get(s) ?? 0) * MAP_COL_W + 20, top: MAP_TOP + (maxLane + 1) * MAP_ROW_H - 6, width: MAP_COL_W - 40, height: 40, zIndex: 7, borderRadius: '8px', outline: '1px dashed transparent' }}
                    onPointerEnter={e => { e.currentTarget.style.background = `${MAP_PROJ_C}22`; e.currentTarget.style.outlineColor = `${MAP_PROJ_C}88` }}
                    onPointerLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.outlineColor = 'transparent' }}>
                    <span style={{ fontSize: '8px', color: `${MAP_PROJ_C}cc`, letterSpacing: '0.08em', padding: '2px 6px' }}>∥ parallel</span>
                  </div>
                ))}
              </>
            )}

            {/* step number labels */}
            {steps.map((s, i) => (
              <div key={`lbl${s}`} style={{ position: 'absolute', left: MAP_INBOX_W + i * MAP_COL_W, top: MAP_TOP - 4, width: MAP_COL_W, textAlign: 'center', fontSize: '8.5px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.28)', fontWeight: 700 }}>STEP {i + 1}</div>
            ))}

            {/* task cards */}
            {mapTasks.map(t => {
              const isSel = selected.has(t.id)
              const done = t.status === 'done'
              const phase = phases.find(p => p.id === t.phase_id)
              return (
                <div key={t.id} onPointerDown={e => onCardPointerDown(e, t)}
                  style={{ position: 'absolute', left: xOf(t.step as number), top: yOf(t.lane), width: MAP_CARD_W, minHeight: MAP_ROW_H - 20,
                    borderRadius: '10px', padding: '10px 12px', cursor: 'grab', zIndex: drag?.id === t.id ? 0 : 3, opacity: drag?.id === t.id ? 0.3 : done ? 0.5 : 1,
                    background: isSel ? `${MAP_TASKS_C}1c` : 'rgba(14,18,38,0.94)', border: `1px solid ${isSel ? MAP_TASKS_C : phase ? `${phase.color}66` : cfg.border}`,
                    boxShadow: isSel ? `0 0 0 1px ${MAP_TASKS_C}, 0 8px 20px rgba(0,0,0,0.4)` : '0 6px 16px rgba(0,0,0,0.35)', transition: 'opacity .15s, border-color .15s' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                    <span data-nodrag onClick={() => patchTask(t.id, { status: done ? 'todo' : 'done' })}
                      style={{ width: '15px', height: '15px', flexShrink: 0, marginTop: '1px', border: `1.5px solid ${done ? MAP_TASKS_C : 'rgba(255,255,255,0.32)'}`, borderRadius: '4px', background: done ? MAP_TASKS_C : 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      {done && <IconCheck size={11} color="#0b0e1a" />}
                    </span>
                    {renaming?.id === t.id ? (
                      <input data-nodrag autoFocus value={renaming.value}
                        onChange={e => setRenaming({ id: t.id, value: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') { patchTask(t.id, { title: renaming.value }); setRenaming(null) } if (e.key === 'Escape') setRenaming(null) }}
                        onBlur={() => { if (renaming.value.trim()) patchTask(t.id, { title: renaming.value }); setRenaming(null) }}
                        style={{ flex: 1, background: 'rgba(0,0,0,0.3)', border: `0.5px solid ${MAP_TASKS_C}`, borderRadius: '5px', padding: '2px 6px', fontSize: '12px', color: '#fff', outline: 'none' }} />
                    ) : (
                      <span onDoubleClick={() => setRenaming({ id: t.id, value: t.title })}
                        style={{ flex: 1, fontSize: '12px', lineHeight: 1.35, color: 'rgba(255,255,255,0.9)', textDecoration: done ? 'line-through' : 'none' }}>{t.title}</span>
                    )}
                  </div>
                  {(t.due_at || t.block_event_id || ((t as { spent_ms?: number }).spent_ms ?? 0) >= 60_000) && (
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px', paddingLeft: '23px' }}>
                      {t.due_at && <span style={{ fontSize: '9px', color: MAP_TASKS_C }}>{t.due_at.includes('T') ? new Date(t.due_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' }) : t.due_at.slice(5)}</span>}
                      {t.block_event_id && <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)' }}>◧ scheduled</span>}
                      {/* Real time spent, accumulated from focus sessions. */}
                      {((t as { spent_ms?: number }).spent_ms ?? 0) >= 60_000 && (
                        <span title="Real time spent (focus sessions)" style={{ fontSize: '9px', color: '#38BDF8', fontVariantNumeric: 'tabular-nums' }}>⏱ {fmtFocusMs((t as { spent_ms?: number }).spent_ms!)}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* docked Secretary bar — direct access + the structural review banner */}
      <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0, borderTop: `0.5px solid ${cfg.border}`, padding: '10px 26px 12px', background: 'rgba(6,9,22,0.6)' }}>
        {proposal && (
          <div onClick={() => setReviewOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '9px', padding: '8px 12px', borderRadius: '9px', background: `${MAP_PROJ_C}14`, border: `0.5px solid ${MAP_PROJ_C}55`, cursor: 'pointer' }}>
            <span style={{ color: MAP_PROJ_C, fontSize: '13px' }}>◆</span>
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.85)', flex: 1 }}>The Secretary drafted {proposal.actions.length} change{proposal.actions.length === 1 ? '' : 's'} — {proposal.summary}</span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: MAP_PROJ_C, letterSpacing: '0.06em' }}>REVIEW →</span>
          </div>
        )}
        {secMsgs.length > 0 && (
          <div ref={secLogRef} style={{ maxHeight: '128px', overflowY: 'auto', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {secMsgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '78%', fontSize: '12px', lineHeight: 1.4, padding: '6px 11px', borderRadius: '10px', background: m.role === 'user' ? `${MAP_TASKS_C}18` : 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.86)', border: `0.5px solid ${m.role === 'user' ? `${MAP_TASKS_C}44` : cfg.border}` }}>
                {m.content || (secStatus && i === secMsgs.length - 1 ? <span style={{ color: 'rgba(255,255,255,0.4)' }}>{secStatus}</span> : '')}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '9px', letterSpacing: '0.12em', fontWeight: 700, color: MAP_TASKS_C, flexShrink: 0 }}>SECRETARY</span>
          <input value={secInput} onChange={e => setSecInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendSecretary() }}
            placeholder="Ask the Secretary to add, complete, or organize tasks…"
            style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${cfg.border}`, borderRadius: '9px', padding: '9px 13px', fontSize: '12.5px', color: 'rgba(255,255,255,0.9)', outline: 'none' }} />
          <button onClick={sendSecretary} disabled={secBusy || !secInput.trim()}
            style={{ fontSize: '12px', fontWeight: 600, color: secBusy || !secInput.trim() ? 'rgba(255,255,255,0.3)' : '#0b0e1a', background: secBusy || !secInput.trim() ? 'rgba(255,255,255,0.08)' : MAP_TASKS_C, border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: secBusy || !secInput.trim() ? 'default' : 'pointer' }}>Send</button>
        </div>
      </div>

      {/* structural review modal (Librarian-style: approve per action, apply) */}
      {reviewOpen && proposal && createPortal(
        <div onClick={() => setReviewOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,4,12,0.6)', backdropFilter: 'blur(6px)' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(520px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'rgba(10,14,32,0.98)', border: `0.5px solid ${MAP_PROJ_C}55`, borderRadius: '14px', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ padding: '16px 20px 12px', borderBottom: `0.5px solid ${cfg.border}` }}>
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.9)', fontWeight: 700, letterSpacing: '0.05em' }}>SECRETARY PROPOSAL</div>
              <div style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>{proposal.summary} · nothing changes until you apply.</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
              {proposal.actions.map((a, i) => (
                <div key={i} onClick={() => setApproved(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', cursor: 'pointer' }}>
                  <span style={{ width: '15px', height: '15px', flexShrink: 0, border: `1.5px solid ${approved.has(i) ? MAP_PROJ_C : 'rgba(255,255,255,0.3)'}`, borderRadius: '4px', background: approved.has(i) ? MAP_PROJ_C : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{approved.has(i) && <IconCheck size={11} color="#0b0e1a" />}</span>
                  <span style={{ fontSize: '12.5px', color: approved.has(i) ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.5)', flex: 1 }}>{describeAction(a)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 20px', borderTop: `0.5px solid ${cfg.border}` }}>
              <button onClick={applyProposal} disabled={approved.size === 0}
                style={{ fontSize: '12px', fontWeight: 700, color: approved.size ? '#0b0e1a' : 'rgba(255,255,255,0.3)', background: approved.size ? MAP_PROJ_C : 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '8px', padding: '9px 18px', cursor: approved.size ? 'pointer' : 'default' }}>Apply {approved.size}</button>
              <div style={{ flex: 1 }} />
              <button onClick={dismissProposal} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '9px 16px', cursor: 'pointer' }}>Dismiss</button>
              <button onClick={() => setReviewOpen(false)} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', background: 'transparent', border: 'none', cursor: 'pointer' }}>Close</button>
            </div>
          </div>
        </div>, document.body)}

      {/* selection → create phase pill */}
      {selected.size > 0 && (
        <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', bottom: '24px', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(12,16,34,0.97)', border: `0.5px solid ${MAP_TASKS_C}55`, borderRadius: '11px', padding: '9px 14px', boxShadow: '0 14px 34px rgba(0,0,0,0.55)', zIndex: 75 }}>
          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)' }}>{selected.size} selected</span>
          {phaseNaming ? (
            <input autoFocus value={phaseName} onChange={e => setPhaseName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createPhase(); if (e.key === 'Escape') { setPhaseNaming(false); setPhaseName('') } }}
              placeholder="Phase name…"
              style={{ width: '150px', background: 'rgba(255,255,255,0.06)', border: `0.5px solid ${MAP_TASKS_C}`, borderRadius: '6px', padding: '5px 9px', fontSize: '12px', color: '#fff', outline: 'none' }} />
          ) : (
            <button onClick={() => setPhaseNaming(true)} style={{ fontSize: '11px', fontWeight: 600, color: MAP_TASKS_C, background: `${MAP_TASKS_C}18`, border: `0.5px solid ${MAP_TASKS_C}55`, borderRadius: '7px', padding: '5px 11px', cursor: 'pointer' }}>Create phase</button>
          )}
          <button onClick={() => { setSelected(new Set()); setPhaseNaming(false) }} style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* drag ghost */}
      {drag && (() => { const t = tasks.find(x => x.id === drag.id); if (!t) return null; return (
        <div style={{ position: 'fixed', left: drag.x + 10, top: drag.y + 8, width: MAP_CARD_W, pointerEvents: 'none', zIndex: 90, padding: '10px 12px', borderRadius: '10px', background: 'rgba(14,18,38,0.98)', border: `1px solid ${MAP_TASKS_C}`, boxShadow: `0 12px 30px rgba(0,0,0,0.6), 0 0 14px -4px ${MAP_TASKS_C}`, fontSize: '12px', color: 'rgba(255,255,255,0.9)' }}>{t.title}</div>
      ) })()}

      {/* card popover (portaled to body so the scaled/scrolled canvas can't clip it) */}
      {pop && popTask && createPortal(
        <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left: pop.x, top: pop.y, width: '212px', zIndex: 95, background: 'rgba(10,14,32,0.98)', border: `0.5px solid ${cfg.border}`, borderRadius: '11px', padding: '7px', boxShadow: '0 16px 40px rgba(0,0,0,0.6)' }}>
          {[
            { label: popTask.status === 'done' ? 'Reopen' : 'Complete', fn: () => patchTask(popTask.id, { status: popTask.status === 'done' ? 'todo' : 'done' }) },
            { label: 'Rename', fn: () => { setRenaming({ id: popTask.id, value: popTask.title }); } },
            { label: 'Move to start', fn: () => batch([{ op: 'place', id: popTask.id, relation: 'start' }]) },
            { label: 'Move to end', fn: () => batch([{ op: 'place', id: popTask.id, relation: 'end' }]) },
            { label: 'Send to Inbox', fn: () => batch([{ op: 'unplace', id: popTask.id }]) },
            { label: 'Delete', fn: () => patchTask(popTask.id, { status: 'dropped' }), danger: true },
          ].map(item => (
            <div key={item.label} onClick={() => { item.fn(); setPop(null) }}
              style={{ fontSize: '12px', color: item.danger ? '#F87171' : 'rgba(255,255,255,0.82)', padding: '7px 9px', borderRadius: '6px', cursor: 'pointer' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>{item.label}</div>
          ))}
        </div>, document.body)}
    </div>
  )
}

function SourcesNotebooks({
  nodeId, files, onUpload, onDelete, cfg,
  notebooks, folderId, setFolderId, openNotebookId, onOpenNotebook, onCloseNotebook,
  onCreateNotebook, onRenameNotebook, onDeleteNotebook, onColorNotebook, onMoveNotebook,
  onReorderNotebooks, onMergeNotebooks, onDuplicateNotebook, onSaveNotebook, onEditorReady, onEditorTeardown, onEditorContent, onToggleFocus,
  onGhostRequest, onThoughtConfirm, readOnly = false, previewFileId = null, onOpenFile, onClosePreview,
}: {
  nodeId: string
  files: SourceFile[]
  onUpload: (nodeId: string, file: File) => Promise<boolean>
  onDelete: (nodeId: string, id: string) => void
  cfg: OrbCfg
  notebooks: NotebookMeta[]
  folderId: string
  setFolderId: (id: string) => void
  openNotebookId: string | null
  onOpenNotebook: (nb: NotebookMeta) => void
  onCloseNotebook: () => void
  onCreateNotebook: (opts: { title: string; type: 'folder' | 'notebook'; color: string; icon: string }, parentId: string) => void
  onRenameNotebook: (id: string, title: string) => void
  onDeleteNotebook: (id: string) => void
  onColorNotebook: (id: string, color: string) => void
  onMoveNotebook: (id: string, parentId: string) => void
  onReorderNotebooks: (parentId: string, orderedIds: string[]) => void
  onMergeNotebooks: (srcId: string, targetId: string, folderName: string) => void
  onDuplicateNotebook: (id: string) => void
  onSaveNotebook: (id: string, json: string) => void
  onEditorReady: (api: { id: string; insertMarkdown: (md: string, mode: 'append' | 'replace') => void }) => void
  onEditorTeardown: () => void
  onEditorContent: (id: string, title: string, markdown: string) => void
  onToggleFocus: () => void
  onGhostRequest: (paragraph: string, docMarkdown: string) => Promise<string>
  onThoughtConfirm: (paragraph: string, label: string) => Promise<boolean>
  readOnly?: boolean                        // openNotebook(mode:'view') → editor is read-only
  previewFileId?: string | null            // openFile → a Sources file previewed in-panel
  onOpenFile?: (id: string) => void
  onClosePreview?: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openNotebook = openNotebookId ? notebooks.find(n => n.id === openNotebookId) ?? null : null
  const previewFile = previewFileId ? files.find(f => f.id === previewFileId) ?? null : null

  // Editor view (state 3): the editor expands to the full panel; Sources slides away.
  if (openNotebook) {
    return (
      <div className="nb-editor-expand" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <NotebookEditor
          nodeId={nodeId}
          notebook={openNotebook}
          onClose={onCloseNotebook}
          onSave={onSaveNotebook}
          focusMode={false}
          onToggleFocus={onToggleFocus}
          onReady={onEditorReady}
          onTeardown={onEditorTeardown}
          onContent={onEditorContent}
          onGhostRequest={onGhostRequest}
          onThoughtConfirm={onThoughtConfirm}
          readOnly={readOnly}
          cfg={cfg}
        />
      </div>
    )
  }

  // File preview (openFile action): the previewed Sources file takes over the right panel
  // (image inline, PDF embedded, text rendered); × returns to the normal Sources view.
  if (previewFile) {
    return <FilePreview file={previewFile} onClose={() => onClosePreview?.()} cfg={cfg} />
  }

  const doUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setError(null)
    setUploading(true)
    for (const f of Array.from(fileList)) {
      const ok = await onUpload(nodeId, f)
      if (!ok) { setError(`Couldn't upload ${f.name}`); break }
    }
    setUploading(false)
  }

  const sectionHeader = (label: string, icon: React.ReactNode, color: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0 }}>
      <span style={{ color, display: 'flex' }}>{icon}</span>
      <span style={{ fontSize: '10px', letterSpacing: '0.2em', fontWeight: 700, color: 'rgba(255,255,255,0.55)' }}>{label}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* ── SOURCES (top 25%) ───────────────────────────────────── */}
      <div style={{ flex: '0 0 25%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px', padding: '18px 20px', background: SRC_AMBER_TINT, borderBottom: `0.5px solid ${cfg.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {sectionHeader('SOURCES', <IconPaperclip size={14} stroke={1.7} />, SRC_AMBER)}
          {files.length > 0 && (
            <button
              onClick={() => inputRef.current?.click()}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', cursor: 'pointer', color: SRC_AMBER, fontSize: '10px', letterSpacing: '0.08em', fontWeight: 700, fontFamily: 'inherit' }}
            >
              <IconPlus size={13} stroke={1.8} /> ADD SOURCE
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.md,.markdown,.csv,.tsv,.doc,.docx,image/*,text/*"
          style={{ display: 'none' }}
          onChange={e => { doUpload(e.target.files); e.target.value = '' }}
        />
        {files.length === 0 ? (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); doUpload(e.dataTransfer.files) }}
            style={{
              flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px',
              border: `1.5px dashed ${dragOver ? SRC_AMBER : 'rgba(239,159,39,0.4)'}`, borderRadius: '10px',
              background: dragOver ? 'rgba(239,159,39,0.12)' : 'transparent', cursor: 'pointer', transition: 'all 0.18s',
            }}
          >
            {uploading ? (
              <span style={{ fontSize: '11px', color: SRC_AMBER, letterSpacing: '0.06em' }}>Uploading…</span>
            ) : (
              <>
                <IconUpload size={20} stroke={1.5} color={SRC_AMBER} style={{ opacity: 0.8 }} />
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.04em' }}>Drop reference files here</span>
                <span style={{ fontSize: '10px', color: SRC_AMBER, letterSpacing: '0.1em', fontWeight: 700 }}>+ ADD SOURCE</span>
              </>
            )}
          </div>
        ) : (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); doUpload(e.dataTransfer.files) }}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '5px', borderRadius: '8px', outline: dragOver ? `1.5px dashed ${SRC_AMBER}` : 'none', outlineOffset: '2px' }}
          >
            {uploading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', fontSize: '11px', color: SRC_AMBER, letterSpacing: '0.04em' }}>
                <IconUpload size={14} stroke={1.6} /> Uploading…
              </div>
            )}
            {files.map(f => {
              const Icon = fileTypeIcon(f.file_type)
              return (
                <div
                  key={f.id}
                  className="source-row"
                  onClick={() => onOpenFile?.(f.id)}
                  title="Open preview"
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '7px', border: `0.5px solid ${cfg.border}`, background: 'rgba(255,255,255,0.02)', cursor: onOpenFile ? 'pointer' : 'default' }}
                >
                  <Icon size={16} stroke={1.6} color={SRC_AMBER} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: '12px', color: 'rgba(255,255,255,0.82)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</span>
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{relativeTime(f.created_at)}</span>
                  {f.size_bytes > 0 && <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: '42px', textAlign: 'right' }}>{fmtBytes(f.size_bytes)}</span>}
                  <button
                    className="source-del"
                    onClick={e => { e.stopPropagation(); onDelete(nodeId, f.id) }}
                    aria-label="Delete source"
                    title="Delete"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', display: 'flex', padding: '2px', flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#F87171' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}
                  >
                    <IconTrash size={14} stroke={1.6} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {error && <span style={{ fontSize: '10px', color: '#F87171', letterSpacing: '0.03em' }}>{error}</span>}
      </div>

      {/* ── NOTEBOOKS (bottom 75% — Docu-scape library) ──── */}
      <NotebookLibrary
        nodeId={nodeId}
        notebooks={notebooks}
        folderId={folderId}
        setFolderId={setFolderId}
        onOpen={onOpenNotebook}
        onCreate={onCreateNotebook}
        onRename={onRenameNotebook}
        onDelete={onDeleteNotebook}
        onColor={onColorNotebook}
        onMove={onMoveNotebook}
        onReorder={onReorderNotebooks}
        onMerge={onMergeNotebooks}
        onDuplicate={onDuplicateNotebook}
        cfg={cfg}
      />
    </div>
  )
}

// Short rising beep when a rest timer finishes (alongside the visual flash).
function playRestBeep() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    osc.connect(gain); gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.18, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
    osc.onended = () => ctx.close().catch(() => {})
  } catch { /* audio unavailable */ }
}

// Per-exercise rest countdown. Tap to start/restart; depletes a fill bar, then
// flashes electric blue + beeps at zero. Purely ephemeral gym state.
// Floating rest countdown: when the timer runs and the user is elsewhere in the
// Diagram, a corner chip keeps the clock visible. Own 1s tick (Home only re-renders per
// minute via the header clock).
function RestChip({ timer }: { timer: { endsAt: number; label: string; seconds: number } }) {
  const [, setTick] = useState(0)
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 500); return () => clearInterval(id) }, [])
  const remaining = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000))
  return (
    <div className="animate-fadeIn" style={{ position: 'fixed', left: '22px', bottom: '22px', zIndex: 74, display: 'flex', alignItems: 'center', gap: '9px', padding: '9px 14px', background: 'rgba(8,10,22,0.96)', border: `0.5px solid ${remaining === 0 ? '#F59E0B' : 'rgba(14,165,233,0.5)'}`, borderRadius: '11px', boxShadow: '0 10px 32px rgba(0,0,0,0.5)' }}>
      <IconBarbell size={14} color={remaining === 0 ? '#F59E0B' : '#38BDF8'} />
      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{timer.label}</span>
      <span style={{ fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: remaining === 0 ? '#F59E0B' : '#38BDF8' }}>{remaining === 0 ? 'GO!' : `${remaining}s`}</span>
    </div>
  )
}

// The rest timer renders the GLOBAL timer: the countdown lives in Home state +
// localStorage as an absolute endsAt, so navigating away and back never kills it — this
// instance shows the countdown only when the running timer is ITS exercise. The beep fires
// locally on zero; the phone push fires server-side (/api/rest-timer) regardless.
function RestTimer({ seconds, label: exLabel, timer, onStart, accentHex, cfg, big = false }: {
  seconds: number
  label: string
  timer: { endsAt: number; label: string; seconds: number } | null
  onStart: () => void
  accentHex: string; cfg: OrbCfg; big?: boolean
}) {
  const mine = !!timer && timer.label === exLabel
  const [, setTick] = useState(0)
  const firedRef = useRef(false)
  useEffect(() => {
    if (!mine) { firedRef.current = false; return }
    const id = setInterval(() => setTick(t => t + 1), 300)
    return () => clearInterval(id)
  }, [mine, timer?.endsAt])
  const remaining = mine ? Math.max(0, Math.ceil((timer!.endsAt - Date.now()) / 1000)) : null
  useEffect(() => {
    if (mine && remaining === 0 && !firedRef.current) { firedRef.current = true; playRestBeep() }
  }, [mine, remaining])

  const start = (e: React.MouseEvent) => { e.stopPropagation(); onStart() }
  const running = mine && remaining !== null
  const flash = running && remaining === 0
  const pct = running && timer!.seconds > 0 ? Math.max(0, (remaining! / timer!.seconds) * 100) : 100
  const label = !running ? `Rest ${fmtRest(seconds)}` : remaining === 0 ? 'GO!' : `${remaining}s`

  return (
    <button
      onClick={start}
      className={flash ? 'rest-flash' : undefined}
      title="Tap to start the rest timer"
      style={{
        position: 'relative', overflow: 'hidden',
        minWidth: big ? '130px' : '82px', height: big ? '42px' : '30px',
        borderRadius: big ? '10px' : '8px',
        border: `0.5px solid ${flash ? accentHex : `${accentHex}55`}`,
        background: flash ? undefined : 'rgba(14,165,233,0.08)',
        color: accentHex, fontFamily: 'inherit', cursor: 'pointer',
        fontSize: big ? '15px' : '11px', fontWeight: 600, letterSpacing: '0.03em',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      {running && (
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: `${accentHex}33`, transition: 'width 1s linear' }} />
      )}
      <span style={{ position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </button>
  )
}

// The gym arm — day navigator + workout blocks + per-set logging + rest timers,
// with a per-exercise detail subpage. Source of truth is the workouts map; every
// edit funnels through mutateWorkouts (which persists + re-derives PRs).
function WorkoutArm({
  workouts, exercises, viewDate, setViewDate, mutateWorkouts, openBlockRef, accentHex, cfg, restTimer, startRestTimer,
}: {
  workouts: WorkoutsMap
  exercises: ExercisesMap
  viewDate: Date
  setViewDate: (d: Date) => void
  mutateWorkouts: (updater: (prev: WorkoutsMap) => WorkoutsMap, immediate?: boolean) => void
  openBlockRef: React.MutableRefObject<string | null>
  accentHex: string
  cfg: OrbCfg
  restTimer: { endsAt: number; label: string; seconds: number } | null
  startRestTimer: (seconds: number, label: string) => void
}) {
  const [view, setView] = useState<'day' | 'block'>('day')
  const [openIdx, setOpenIdx] = useState(0)
  const [swapSel, setSwapSel] = useState<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const dk = isoDate(viewDate)
  const today = isoDate(new Date())
  const workout = workouts[dk]
  const rel = dk === today ? 'TODAY' : dk < today ? 'PAST' : 'PLANNED'

  // Tell Spectre exactly which exercise subpage (if any) is on screen.
  useEffect(() => {
    openBlockRef.current = view === 'block' && workout?.blocks[openIdx]
      ? workout.blocks[openIdx].exercise
      : null
  }, [view, openIdx, workout, openBlockRef])
  useEffect(() => () => { openBlockRef.current = null }, [openBlockRef])

  // ── Navigation ──
  const shiftDay = (delta: number) => {
    const d = new Date(viewDate); d.setDate(d.getDate() + delta)
    setViewDate(d); setView('day'); setSwapSel(null)
  }
  const goToday = () => { setViewDate(new Date()); setView('day'); setSwapSel(null) }
  const openBlock = (idx: number) => { setOpenIdx(idx); setView('block') }

  // ── Mutations (scoped to the viewed day) ──
  const setField = (blockIdx: number, setIdx: number, field: 'actualWeight' | 'actualReps', value: string) => {
    mutateWorkouts(prev => {
      const w = prev[dk]; if (!w) return prev
      const blocks = w.blocks.map((b, bi) => bi !== blockIdx ? b
        : { ...b, sets: b.sets.map((s, si) => si !== setIdx ? s : { ...s, [field]: value }) })
      return { ...prev, [dk]: { ...w, blocks } }
    })
  }
  const toggleDone = (blockIdx: number, setIdx: number) => {
    mutateWorkouts(prev => {
      const w = prev[dk]; if (!w) return prev
      const blocks = w.blocks.map((b, bi) => bi !== blockIdx ? b
        : { ...b, sets: b.sets.map((s, si) => {
            if (si !== setIdx) return s
            if (s.done) return { ...s, done: false }   // un-confirm → editable again, values kept
            // Confirming: lock this session's logged values permanently. If the lifter
            // left an input blank, commit the planned (ghost-hint) number so the confirmed
            // set is never empty. Planned values themselves are never mutated.
            return {
              ...s,
              actualWeight: s.actualWeight || s.plannedWeight,
              actualReps: s.actualReps || s.plannedReps,
              done: true,
            }
          }) })
      return { ...prev, [dk]: { ...w, blocks } }
    }, true)
  }
  const swapBlocks = (i: number, j: number) => {
    mutateWorkouts(prev => {
      const w = prev[dk]; if (!w) return prev
      const blocks = [...w.blocks]
      ;[blocks[i], blocks[j]] = [blocks[j], blocks[i]]
      return { ...prev, [dk]: { ...w, blocks } }
    }, true)
  }
  const moveBlock = (from: number, to: number) => {
    mutateWorkouts(prev => {
      const w = prev[dk]; if (!w) return prev
      const blocks = [...w.blocks]
      const [m] = blocks.splice(from, 1)
      blocks.splice(to, 0, m)
      return { ...prev, [dk]: { ...w, blocks } }
    }, true)
  }
  // Tap one handle to select, tap another to swap (mobile-friendly reorder).
  const onSwapTap = (idx: number) => {
    if (swapSel === null) { setSwapSel(idx); return }
    if (swapSel === idx) { setSwapSel(null); return }
    swapBlocks(swapSel, idx); setSwapSel(null)
  }

  // ── Shared styles ──
  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', border: `0.5px solid ${cfg.border}`,
    borderRadius: '6px', color: 'rgba(255,255,255,0.92)', fontSize: '14px', fontFamily: 'inherit',
    padding: '7px 4px', textAlign: 'center', outline: 'none', fontVariantNumeric: 'tabular-nums',
  }
  // A confirmed (✓-locked) set shows its logged value as solid text — no input, no
  // ghost/placeholder hint. Ghost hints only ever appear in EMPTY editable inputs.
  const confirmedStyle: React.CSSProperties = {
    fontSize: '14px', color: 'rgba(255,255,255,0.95)', fontWeight: 600,
    textAlign: 'center', fontVariantNumeric: 'tabular-nums',
  }
  const navBtnStyle: React.CSSProperties = {
    fontSize: '20px', color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.04)',
    border: `0.5px solid ${cfg.border}`, borderRadius: '10px', width: '40px', height: '40px',
    cursor: 'pointer', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  const setE1rm = (s: WorkoutSet): number | null => {
    const w = num(s.actualWeight), r = num(s.actualReps)
    return Number.isFinite(w) && Number.isFinite(r) && w > 0 && r > 0 ? epley(w, r) : null
  }

  // ── Block detail subpage ──
  if (view === 'block' && workout && workout.blocks[openIdx]) {
    const b = workout.blocks[openIdx]
    const rec = exercises[b.exercise.toLowerCase()]
    return (
      <div key="block" className="animate-wk-drill-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <button onClick={() => { setView('day'); setSwapSel(null) }} aria-label="Back to workout" style={{ ...navBtnStyle, fontSize: '18px' }}>‹</button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.14em', color: accentHex, fontWeight: 600 }}>EXERCISE</div>
            <div style={{ fontSize: '19px', fontWeight: 600, color: 'rgba(255,255,255,0.94)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.exercise}</div>
          </div>
        </div>

        {b.note && (
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', marginBottom: '14px', lineHeight: 1.5 }}>{b.note}</div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' }}>
          <RestTimer seconds={b.restSeconds} label={b.exercise} timer={restTimer} onStart={() => startRestTimer(b.restSeconds, b.exercise)} accentHex={accentHex} cfg={cfg} big />
          {rec && rec.sessions.length > 0 && (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.03em' }}>
              Best e1RM <span style={{ color: accentHex, fontWeight: 600 }}>{rec.bestE1rm}</span> · heaviest {rec.maxWeight}
              {/* Last time this lift was trained: the number to beat, right where the set is planned. */}
              {' · '}last <span style={{ color: accentHex, fontWeight: 600 }}>{rec.sessions[rec.sessions.length - 1].topWeight}×{rec.sessions[rec.sessions.length - 1].topReps}</span> ({rec.sessions[rec.sessions.length - 1].date.slice(5)})
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '28px 76px 1fr 1fr 64px 34px', gap: '8px', padding: '0 6px 6px', fontSize: '9px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em' }}>
          <span>SET</span><span>PLAN</span><span style={{ textAlign: 'center' }}>WEIGHT</span><span style={{ textAlign: 'center' }}>REPS</span><span style={{ textAlign: 'center' }}>e1RM</span><span style={{ textAlign: 'center' }}>✓</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          {b.sets.map((s, si) => {
            const e = setE1rm(s)
            return (
              <div key={si} style={{ display: 'grid', gridTemplateColumns: '28px 76px 1fr 1fr 64px 34px', gap: '8px', alignItems: 'center', padding: '8px 6px', background: s.done ? `${accentHex}12` : 'rgba(255,255,255,0.02)', border: `0.5px solid ${s.done ? `${accentHex}55` : 'transparent'}`, borderRadius: '8px' }}>
                <span style={{ fontSize: '13px', color: accentHex, fontWeight: 600, textAlign: 'center' }}>{si + 1}</span>
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>{s.plannedWeight || '—'}×{s.plannedReps || '—'}</span>
                {s.done ? (
                  <>
                    <span style={confirmedStyle}>{s.actualWeight || '—'}</span>
                    <span style={confirmedStyle}>{s.actualReps || '—'}</span>
                  </>
                ) : (
                  <>
                    <input inputMode="decimal" value={s.actualWeight} placeholder={s.plannedWeight || 'wt'} onChange={e => setField(openIdx, si, 'actualWeight', e.target.value)} style={inputStyle} />
                    <input inputMode="decimal" value={s.actualReps} placeholder={s.plannedReps || 'reps'} onChange={e => setField(openIdx, si, 'actualReps', e.target.value)} style={inputStyle} />
                  </>
                )}
                <span style={{ fontSize: '12px', color: e ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.2)', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{e ?? '—'}</span>
                <button onClick={() => toggleDone(openIdx, si)} aria-label="Mark set done" style={{ width: '26px', height: '26px', margin: '0 auto', borderRadius: '7px', border: `0.5px solid ${s.done ? accentHex : cfg.border}`, background: s.done ? accentHex : 'transparent', color: s.done ? '#05070f' : 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '13px', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Day view ──
  const statTiles = (workout?.blocks ?? [])
    .map(b => exercises[b.exercise.toLowerCase()])
    .filter((rec): rec is ExerciseRecord => !!rec && rec.sessions.length > 0)
  const trendOf = (rec: ExerciseRecord): number => {
    if (rec.sessions.length < 2) return 0
    const a = rec.sessions[rec.sessions.length - 1].bestE1rm
    const p = rec.sessions[rec.sessions.length - 2].bestE1rm
    return a > p ? 1 : a < p ? -1 : 0
  }

  return (
    <div key="day" className="animate-wk-drill-back">
      {/* Header: day label + day navigator */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.14em', color: accentHex, fontWeight: 600 }}>
            {viewDate.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()} · {rel}
          </div>
          <div style={{ fontSize: '18px', fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>
            {viewDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {rel !== 'TODAY' && (
            <button onClick={goToday} style={{ fontSize: '10px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)', background: 'rgba(255,255,255,0.04)', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '0 12px', height: '40px', cursor: 'pointer' }}>TODAY</button>
          )}
          <button onClick={() => shiftDay(-1)} aria-label="Previous day" style={navBtnStyle}>‹</button>
          <button onClick={() => shiftDay(1)} aria-label="Next day" style={navBtnStyle}>›</button>
        </div>
      </div>

      {!workout || workout.blocks.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '46px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>No workout for this day.</div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.6, maxWidth: '280px' }}>
            Ask Spectre to build one — e.g. &ldquo;help me build today&apos;s workout.&rdquo;
          </div>
        </div>
      ) : (
        <>
          {/* Title / focus / notes */}
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '15px', color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>{workout.title}</div>
            {workout.focus && <div style={{ fontSize: '11px', color: accentHex, letterSpacing: '0.04em', marginTop: '3px', opacity: 0.85 }}>{workout.focus}</div>}
          </div>
          {workout.notes && (
            <div style={{ background: `color-mix(in srgb, ${accentHex} 7%, transparent)`, border: `0.5px solid color-mix(in srgb, ${accentHex} 26%, transparent)`, borderRadius: '8px', padding: '10px 13px', fontSize: '12px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, marginBottom: '16px', fontStyle: 'italic' }}>
              {workout.notes}
            </div>
          )}

          {/* Strength stats */}
          {statTiles.length > 0 ? (
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', marginBottom: '8px' }}>STRENGTH · est. 1RM (Epley)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
                {statTiles.map(rec => {
                  const t = trendOf(rec)
                  return (
                    <div key={rec.name} style={{ background: 'rgba(255,255,255,0.02)', border: `0.5px solid ${cfg.border}`, borderRadius: '8px', padding: '9px 11px' }}>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.name}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', marginTop: '3px' }}>
                        <span style={{ fontSize: '17px', fontWeight: 700, color: accentHex, fontVariantNumeric: 'tabular-nums' }}>{rec.bestE1rm}</span>
                        <span style={{ fontSize: '11px', color: t > 0 ? '#10B981' : t < 0 ? '#F59E0B' : 'rgba(255,255,255,0.3)' }}>{t > 0 ? '▲' : t < 0 ? '▼' : '—'}</span>
                      </div>
                      <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>PR {rec.maxWeight}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginBottom: '16px', fontStyle: 'italic' }}>
              Building your first session — strength history starts today.
            </div>
          )}

          {/* Workout blocks */}
          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.12em', marginBottom: '8px' }}>
            EXERCISES {swapSel !== null && <span style={{ color: accentHex }}>· tap another to swap</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {workout.blocks.map((b, bi) => (
              <div
                key={b.id}
                draggable
                onDragStart={() => setDragIdx(bi)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => { if (dragIdx !== null && dragIdx !== bi) moveBlock(dragIdx, bi); setDragIdx(null) }}
                onDragEnd={() => setDragIdx(null)}
                className={dragIdx === bi ? 'wk-block-dragging' : swapSel === bi ? 'wk-block-selected' : undefined}
                style={{ background: 'rgba(255,255,255,0.025)', border: `0.5px solid ${cfg.border}`, borderRadius: '12px', padding: '12px 13px' }}
              >
                {/* Block header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <span
                    onClick={() => onSwapTap(bi)}
                    title="Tap to select, then tap another exercise to swap (or drag)"
                    style={{ cursor: 'grab', color: swapSel === bi ? accentHex : 'rgba(255,255,255,0.3)', fontSize: '16px', lineHeight: 1, userSelect: 'none', padding: '4px 2px' }}
                  >≡</span>
                  <button
                    onClick={() => openBlock(bi)}
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.9)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.exercise}</span>
                      <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.25)' }}>›</span>
                    </div>
                    {b.note && <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.note}</div>}
                  </button>
                  <RestTimer seconds={b.restSeconds} label={b.exercise} timer={restTimer} onStart={() => startRestTimer(b.restSeconds, b.exercise)} accentHex={accentHex} cfg={cfg} />
                </div>

                {/* Sets */}
                <div style={{ display: 'grid', gridTemplateColumns: '22px 64px 1fr 1fr 30px', gap: '7px', padding: '0 2px 4px', fontSize: '8px', color: 'rgba(255,255,255,0.22)', letterSpacing: '0.08em' }}>
                  <span>#</span><span>PLAN</span><span style={{ textAlign: 'center' }}>WT</span><span style={{ textAlign: 'center' }}>REPS</span><span></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {b.sets.map((s, si) => (
                    <div key={si} style={{ display: 'grid', gridTemplateColumns: '22px 64px 1fr 1fr 30px', gap: '7px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: accentHex, fontWeight: 600, textAlign: 'center' }}>{si + 1}</span>
                      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.38)', fontVariantNumeric: 'tabular-nums' }}>{s.plannedWeight || '—'}×{s.plannedReps || '—'}</span>
                      {s.done ? (
                        <>
                          <span style={confirmedStyle}>{s.actualWeight || '—'}</span>
                          <span style={confirmedStyle}>{s.actualReps || '—'}</span>
                        </>
                      ) : (
                        <>
                          <input inputMode="decimal" value={s.actualWeight} placeholder={s.plannedWeight || 'wt'} onChange={e => setField(bi, si, 'actualWeight', e.target.value)} style={inputStyle} />
                          <input inputMode="decimal" value={s.actualReps} placeholder={s.plannedReps || 'reps'} onChange={e => setField(bi, si, 'actualReps', e.target.value)} style={inputStyle} />
                        </>
                      )}
                      <button onClick={() => toggleDone(bi, si)} aria-label="Mark set done" style={{ width: '24px', height: '24px', margin: '0 auto', borderRadius: '6px', border: `0.5px solid ${s.done ? accentHex : cfg.border}`, background: s.done ? accentHex : 'transparent', color: s.done ? '#05070f' : 'rgba(255,255,255,0.35)', cursor: 'pointer', fontSize: '12px', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}


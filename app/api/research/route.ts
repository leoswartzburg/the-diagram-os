import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { createNotebook } from '@/lib/conversations'
import { markdownToTiptap } from '@/lib/notebookMd'
import { syncNotebookToVault, getNotebooksPath, ensureNodeFolders, slug } from '@/lib/vault'
import { acquireResearch, releaseResearch, isAbortRequested, requestAbort, requestWindDown, isWindDownRequested, registerResearchController } from '@/lib/researchLock'
import { tavilySearch, isSearchConfigured } from '@/lib/search'
import { fetchPages, isPlaywrightUp, type PageLink } from '@/lib/fetchContent'
import { embedText } from '@/lib/vault'

// Deep research is its OWN pipeline — deliberately NOT routed through /api/spectre. It runs a
// MODEL-AGNOSTIC multi-agent loop (Claude OR local gpt-oss, selected via resolveModel/callLLM),
// searches the web with Tavily (lib/search.ts) + optional Playwright full-page fetch, streams
// progress over SSE, and writes the final report straight into a Docu-scape notebook via the same
// lib helpers the notebook routes use.
//
// There is ONE self-scaling pipeline: an orchestrator designs a dependency-aware multi-agent DAG,
// executed level-by-level. The caller DOES pick a tier — `mode` ∈ quick | deep | exhaustive
// (resolveMode → modeConfig/MODE_FEATURES) scales the caps (up to 16 agents) and the features
// (full-content fetch, link crawl, and the exhaustive saturation/continuation loop).
//
// ── ARCHITECTURE (adaptive redesign) ─────────────────────────────────────────────────────────────
// WHY: the previous pipeline oscillated between two failure modes that tuning could never fix.
// Loose caps let one blind, non-streaming search call run unobserved for 14+ minutes (873k tokens,
// $20+). Strict caps (a flat 30s wall-clock timeout) killed every LEGITIMATE web search — the API's
// server-side search loop routinely needs 20–90s — burning $2 for zero results and an empty report.
// Root cause: a fixed wall-clock timeout is the wrong primitive for an operation of unpredictable
// duration, and a non-streaming call gives no way to tell a productive 60s call from a hung one.
//
// THE THREE PRINCIPLES OF THIS DESIGN:
//  1. STREAM every search call; judge liveness by EVENT FLOW, not wall-clock. While events arrive
//     the call is working and may continue (up to a generous SEARCH_MAX_MS ceiling). A stream silent
//     for SEARCH_IDLE_MS is genuinely stalled → abort just that call. Sources stream to the circuit
//     board live, and a call that stalls late KEEPS everything it already delivered.
//  2. ADAPTIVE CHECKPOINTS, not rigid quotas: after every search the agent assesses what it actually
//     holds (ENOUGH_SUMMARIES/ENOUGH_SOURCES → stop early) and the run assesses live spend (the $
//     estimate includes the $0.01/search web-search fee). Past COST_SOFT_USD no NEW searches start;
//     at COST_HARD_USD the run stops and synthesizes what exists. Simple queries finish cheap;
//     complex ones scale up to the caps. Token caps (200k global / 40k agent) remain as backstops.
//  3. HONESTY GATES: if a whole level runs and not one search succeeds, stop burning agents and save
//     an explicit failure notice (zero further spend) — never synthesize model knowledge into
//     something that reads like research. The provenance note states exactly how many live searches
//     and unique sources back every report.
//
// STOP: the run-wide AbortController (lib/researchLock) chains into every streamed call — in-flight
// work dies in milliseconds. An aborted run SKIPS LLM synthesis and saves the deterministic
// raw-findings report instantly: STOP → saved notebook in <2s. Notebook creation keeps its disk +
// chat fallbacks; output is NEVER lost.
// COST EXPECTATIONS: narrow run (2 agents) ≈ $0.10–0.30 · broad run (5–6 agents) ≈ $0.60–1.50 ·
// hard ceiling $2.00. Compressed summaries are the only thing that accumulates between stages; raw
// web content never leaves its own call and never reaches synthesis.
// PROVENANCE: guaranteed "## References" (appended deterministically if the model drops it) + a
// provenance note with live-search counts; raw per-agent findings + each agent's own source URLs are
// written as a `sources-*.md` sidecar next to the report in the vault.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const client = new Anthropic()

// Planning, per-search compression, and gap analysis are cheap, structural steps → Haiku. The actual
// search agents and the synthesis use the model the client selected (Sonnet or Opus).
const HAIKU = 'claude-haiku-4-5'
// Web search is now Tavily (lib/search.ts) — model-agnostic, one REST call per query returns clean
// extracted content, so the old Anthropic native web_search tool + its streaming watchdog are gone.

// ── Token budgets ────────────────────────────────────────────────────────────────────────────────
// Per-call max_tokens caps (FIX B) and per-mode total caps (FIX C). When `used` comes within
// CAP_HEADROOM of the cap, the pipeline stops collecting and goes straight to synthesis.
const MAX_TOK = {
  plan: 300,        // orchestrator / fallback planner JSON
  search: 1000,     // a single search agent's findings digest (selected model)
  synth: 4000,      // final report (selected model)
} as const
// Single self-scaling pipeline → one total budget. When `used` comes within CAP_HEADROOM of the cap
// (i.e. ≥190k), the pipeline cancels any unfired agents and goes straight to synthesis.
const BUDGET_CAP = 200_000
const CAP_HEADROOM = 10_000
// Soft heads-up emitted once when usage crosses this — the run continues to the hard cap, but the
// user gets a cost warning first (≈$1.00 in tokens at 150k on Sonnet).
const SOFT_WARN = 150_000
const HARD_TIMEOUT_MS = 10 * 60 * 1000
// Per-agent hard token cap, metered separately from the global budget and checked around every
// search — one runaway agent can no longer eat the whole run (the 873k-token incident).
const AGENT_CAP = 40_000
// LLM calls (planning, compressions, synthesis) have small bounded outputs — a flat timeout with
// zero retries is safe and absolute for them (raised for the slower local model in limitsFor).
const PER_CALL_TIMEOUT_MS = 45_000
// Per-search ceiling (Tavily REST is fast — seconds; this only catches a pathologically slow crawl).
const SEARCH_MAX_MS = 25_000
// Live $ governors (Claude runs only; Infinity for local). Soft: stop launching NEW
// searches, finish in-flight work, synthesize. Hard: stop the run immediately and synthesize.
const COST_SOFT_USD = 1.20
const COST_HARD_USD = 2.00
// Adaptive "enough" thresholds — an agent stops searching early once it holds this much material.
const ENOUGH_SUMMARIES = 2
const ENOUGH_SOURCES = 5
// Synthesis is the one call that legitimately produces a long output (≤4k tokens — more than 30s on
// Opus), so it gets its own ceiling instead of PER_CALL_TIMEOUT_MS. It is the LAST call of a run
// (input = compressed summaries, cheap) so budget/timeout stops also get the full window — a STOP
// never reaches synthesis at all (aborted runs save the deterministic raw-findings report instead).
const SYNTH_TIMEOUT_MS = 90_000

type Source = { url: string; title: string }
// `ok` distinguishes a search call that actually completed (counts toward live-search provenance)
// from one that aborted/timed out/failed and returned empty.
type SearchResult = { summary: string; sources: Source[]; ok: boolean; links?: PageLink[] }
// Per-run provenance tracking: the deduped run-wide source list (feeds synthesis + References),
// each agent's own sources (feeds the findings sidecar), how many search calls succeeded vs were
// attempted (`searches`/`attempts` — drives the honesty gate + provenance note).
type RunTrack = { allSources: Source[]; byAgent: Map<number, Source[]>; searches: number; attempts: number; crawlLinks: PageLink[]; seenDomains: Set<string> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Emit = (event: Record<string, any>) => void

// ── Model abstraction (Claude ⇄ local gpt-oss) ───────────────────────────────────────────────────
// Every LLM step in the pipeline (orchestrate / digest / compress / synthesize) routes through this,
// so a LOCAL research run uses gpt-oss on llama-server with ZERO Claude calls — search is Tavily, the
// whole run is free. A Claude run is unchanged. Returns text + token usage (normalized across both
// backends so the budget meter works for either).
const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'
type LLMUsage = { input: number; output: number }
// gpt-oss has a 16k context; HIGH/MEDIUM reasoning on a large input can generate enough chain-of-
// thought to blow the window ("Context size has been exceeded"). Utility calls with big inputs
// (full-content digests, compressions) pass effort:'low' — they're extraction, not deep reasoning —
// and the input is char-capped so prompt + minimal reasoning + output stays well under 16k.
const LOCAL_INPUT_CHAR_CAP = 34000   // ≈ 9.5k tokens; leaves room for low-effort reasoning + output
async function callLLM(
  model: string,
  opts: { system: string; user: string; maxTokens: number; signal?: AbortSignal; timeout: number; effort?: 'low' | 'medium' | 'high' },
): Promise<{ text: string; usage: LLMUsage }> {
  if (model === 'local') {
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    opts.signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => ctrl.abort(), opts.timeout)
    try {
      // Hard input cap so a big digest can never exceed gpt-oss's context window.
      let user = opts.user
      if (opts.system.length + user.length > LOCAL_INPUT_CHAR_CAP) {
        user = user.slice(0, Math.max(2000, LOCAL_INPUT_CHAR_CAP - opts.system.length)) + '\n…[truncated to fit the local model]'
      }
      const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-oss-20b', stream: false, max_tokens: opts.maxTokens,
          temperature: 1.0, top_p: 1.0, reasoning_effort: opts.effort ?? 'medium',
          messages: [{ role: 'system', content: opts.system }, { role: 'user', content: user }],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`llama-server ${res.status}: ${await res.text().catch(() => '')}`)
      const data = await res.json()
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
      const u = data?.usage ?? {}
      return { text, usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await client.messages.create(
    { model, max_tokens: opts.maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }] },
    { signal: opts.signal, timeout: opts.timeout, maxRetries: 0 },
  )
  const u = resp?.usage ?? {}
  const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return { text: textOf(resp.content).trim(), usage: { input, output: u.output_tokens ?? 0 } }
}

// Per-run limits. LOCAL runs are gated by ELECTRICITY + TIME, not dollars — the hard cost caps are
// removed (cost ≈ $0) and the token/time backstops raised hugely, while the QUALITY structure (agent
// search caps, ENOUGH thresholds, adaptive synthesis) is identical for both. CLAUDE runs keep the
// original dollar guardrails.
type Limits = {
  budgetCap: number; softWarn: number; agentCap: number
  costSoft: number; costHard: number
  perCallTimeout: number; synthTimeout: number; hardTimeoutMs: number; searchMaxMs: number
}
// Limits scale with the research MODE. Quick = the original tuned caps. Deep raises everything for a
// longer, richer run. Exhaustive removes the practical ceilings — it's gated by SATURATION + Wind
// Down, not by caps; the numbers below are last-resort backstops so a truly stuck run can't burn
// forever. LOCAL runs cost ~$0 (gpt-oss + Tavily), so their dollar governors stay Infinity and
// they're gated by tokens/time/electricity instead.
function limitsFor(isLocal: boolean, mode: ResearchMode): Limits {
  const base: Limits = isLocal
    ? { budgetCap: 8_000_000, softWarn: 6_000_000, agentCap: 800_000, costSoft: Infinity, costHard: Infinity,
        perCallTimeout: 180_000, synthTimeout: 300_000, hardTimeoutMs: 40 * 60 * 1000, searchMaxMs: 25_000 }
    : { budgetCap: BUDGET_CAP, softWarn: SOFT_WARN, agentCap: AGENT_CAP, costSoft: COST_SOFT_USD, costHard: COST_HARD_USD,
        perCallTimeout: PER_CALL_TIMEOUT_MS, synthTimeout: SYNTH_TIMEOUT_MS, hardTimeoutMs: HARD_TIMEOUT_MS, searchMaxMs: SEARCH_MAX_MS }
  if (mode === 'quick') return base
  if (mode === 'deep') {
    return { ...base,
      budgetCap: base.budgetCap * 3, softWarn: base.softWarn * 3, agentCap: base.agentCap * 3,
      costSoft: isLocal ? Infinity : 5, costHard: isLocal ? Infinity : 7,
      synthTimeout: Math.max(base.synthTimeout, 240_000),
      hardTimeoutMs: isLocal ? 90 * 60 * 1000 : 45 * 60 * 1000 }
  }
  // exhaustive — fire-and-forget; saturation + Wind Down are the real exits.
  return { ...base,
    budgetCap: isLocal ? 500_000_000 : 30_000_000, softWarn: isLocal ? 400_000_000 : 25_000_000,
    agentCap: base.agentCap * 8,
    costSoft: isLocal ? Infinity : 40, costHard: isLocal ? Infinity : 60,
    perCallTimeout: Math.max(base.perCallTimeout, 180_000),
    synthTimeout: Math.max(base.synthTimeout, 300_000),
    hardTimeoutMs: isLocal ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000 }
}

// ── Research effort tiers ────────────────────────────────────────────────────────────────────────
// Quick   — Tavily snippets, ≤5 agents, ≤3 searches each. Fast answers (the original behavior).
// Deep    — Playwright FULL page content, ≤10 agents, ≤5 searches. Richer synthesis (20-40 min).
// Exhaust — Playwright + link crawl, agents-as-needed across an OUTER continuation loop, no practical
//           time limit; runs until knowledge SATURATES or the user hits Wind Down. Fire-and-forget.
type ResearchMode = 'quick' | 'deep' | 'exhaustive'
type ModeConfig = {
  mode: ResearchMode
  maxAgents: number       // orchestrator cap (per round)
  maxSearches: number     // per agent
  fullContent: boolean    // fetch full page text via Playwright (Deep/Exhaustive)
  crawl: boolean          // follow on-page links to seed further reading (Exhaustive)
  exhaustive: boolean     // outer continuation loop + saturation-driven auto-winddown
  digestTok: number       // per-search digest size (bigger when digesting full articles)
  orchTok: number         // orchestrator plan-JSON budget (scales with maxAgents so big plans don't truncate)
  noveltyThreshold: number
  saturationRounds: number
  lim: Limits
}
const MODE_FEATURES: Record<ResearchMode, Omit<ModeConfig, 'mode' | 'orchTok' | 'noveltyThreshold' | 'saturationRounds' | 'lim'>> = {
  quick:      { maxAgents: 5,  maxSearches: 3, fullContent: false, crawl: false, exhaustive: false, digestTok: 150 },
  deep:       { maxAgents: 10, maxSearches: 5, fullContent: true,  crawl: false, exhaustive: false, digestTok: 400 },
  exhaustive: { maxAgents: 16, maxSearches: 6, fullContent: true,  crawl: true,  exhaustive: true,  digestTok: 450 },
}
// Saturation: a round whose new findings add < NOVELTY_THRESHOLD semantic novelty (vs everything
// gathered so far, relative to the objective) is "low". SATURATION_ROUNDS consecutive low rounds →
// Exhaustive auto-winds-down. (Novelty 0 = fully redundant, 1 = entirely new ground.)
const NOVELTY_THRESHOLD = 0.15
const SATURATION_ROUNDS = 3
function modeConfig(mode: ResearchMode, isLocal: boolean): ModeConfig {
  const f = MODE_FEATURES[mode]
  // A full agent's plan entry is ~250 tokens of JSON; size the orchestrator output to fit the whole
  // plan (else a big Deep/Exhaustive plan truncates mid-JSON → unparseable → fallback to 3 agents).
  const orchTok = Math.min(4000, 700 + f.maxAgents * 280)
  return { mode, ...f, orchTok, noveltyThreshold: NOVELTY_THRESHOLD, saturationRounds: SATURATION_ROUNDS, lim: limitsFor(isLocal, mode) }
}
function resolveMode(raw: unknown): ResearchMode {
  return raw === 'deep' || raw === 'exhaustive' ? raw : 'quick'
}

// Running token meter shared across a run. `stopReason()` is the single gate the pipeline polls
// before AND after every search: it fires on abort, on the 10-min timeout, or when the budget is
// nearly exhausted. `signal` is the run-wide AbortController's signal — passed to every API call so
// /api/research/abort cancels in-flight calls instantly instead of waiting for them to complete.
// Cost estimate rates. Sonnet pricing — $3 / 1M input, $15 / 1M output — plus the web_search tool
// fee ($10 / 1,000 searches). The orchestrator/Haiku calls are cheaper and Opus dearer, so this is
// an upper-ish estimate, not a billing figure — but it now drives the COST governors, so it errs
// safe (over-estimating stops earlier, never later).
const COST_PER_INPUT_TOK = 0.000003
const COST_PER_OUTPUT_TOK = 0.000015
const COST_PER_WEB_SEARCH = 0.01

// `used` is the token cap meter (input+output+cache). `inTok`/`outTok`/`webSearches` feed the live
// cost estimate that the adaptive governors act on. `signal` is the run-wide AbortController's
// signal — chained into every API call so STOP cancels in-flight work in milliseconds.
type Budget = { used: number; inTok: number; outTok: number; webSearches: number; cap: number; deadline: number; sessionId: string; signal: AbortSignal; isLocal: boolean; lim: Limits; cfg: ModeConfig; pwUp: boolean }
function makeBudget(sessionId: string, signal: AbortSignal, isLocal: boolean, cfg: ModeConfig, pwUp: boolean): Budget {
  return { used: 0, inTok: 0, outTok: 0, webSearches: 0, cap: cfg.lim.budgetCap, deadline: Date.now() + cfg.lim.hardTimeoutMs, sessionId, signal, isLocal, lim: cfg.lim, cfg, pwUp }
}
// Add normalized token usage to a meter — works for the global Budget and the per-agent meter
// (`{ used }`). `used` drives the cap logic; inTok/outTok accumulate for the cost estimate.
function meterTokens(b: { used: number; inTok?: number; outTok?: number }, usage: LLMUsage) {
  b.used += usage.input + usage.output
  if (b.inTok !== undefined) b.inTok += usage.input
  if (b.outTok !== undefined) b.outTok += usage.output
}
// Live cost estimate. LOCAL runs cost ~$0 (no per-token billing; Tavily free tier) → the dollar
// governors are inert and the run is gated by tokens/time instead.
function estCostUsd(b: Budget): number {
  if (b.isLocal) return 0
  return b.inTok * COST_PER_INPUT_TOK + b.outTok * COST_PER_OUTPUT_TOK + b.webSearches * COST_PER_WEB_SEARCH
}
// Stream the running token total + cost to the client after every LLM call.
function emitTokens(b: Budget, emit: Emit, agentId?: number) {
  emit({ type: 'token_update', total: b.used, inputTokens: b.inTok, outputTokens: b.outTok, cost: estCostUsd(b), cap: b.cap, local: b.isLocal, ...(agentId != null ? { agentId } : {}) })
}
type StopReason = null | 'aborted' | 'budget' | 'timeout' | 'failed' | 'winddown'
function stopReason(b: Budget): StopReason {
  if (isAbortRequested(b.sessionId)) return 'aborted'
  if (Date.now() > b.deadline) return 'timeout'
  if (estCostUsd(b) >= b.lim.costHard) return 'budget'  // $ governor (Infinity for local → inert)
  if (b.used > b.cap - CAP_HEADROOM) return 'budget'    // token backstop (raised hugely for local)
  return null
}
// Soft budget: past this, no NEW searches start; in-flight work finishes and synthesis still runs.
function softStop(b: Budget): boolean {
  return estCostUsd(b) >= b.lim.costSoft || b.used >= b.lim.softWarn
}

// Pull the model from the request. The LOCAL selection (`local-gpt-oss`) maps to the `local`
// sentinel → the whole run uses gpt-oss + Tavily, no Claude. Else one of the two Claude variants.
function resolveModel(raw: unknown): string {
  if (raw === 'local-gpt-oss' || raw === 'local') return 'local'
  return raw === 'claude-opus-4-6' || raw === 'claude-sonnet-4-6' ? raw : 'claude-sonnet-4-6'
}

// ── Conversation context (session isolation fix) ────────────────────────────────────────────────
// The triggering chat session's recent messages, sent by the client with every research request so
// the planner is grounded in what was actually discussed. STRICT ISOLATION: this is the ONLY outside
// context that enters the pipeline, and it enters ONLY the planning calls (orchestrate/fallbackPlan)
// — never the search agents, never synthesis. No Mem0, no vault, no other sessions.
type HistoryMsg = { role: 'user' | 'assistant'; content: string }
const HISTORY_MAX_MSGS = 20
const HISTORY_MAX_CHARS = 2000 // per message — caps worst-case planner input at ~10k tokens

// Coerce the client-supplied history into ≤20 text-only turns. Anything malformed is dropped, so a
// bad payload degrades to "no context" (the previous behavior) rather than erroring.
function sanitizeHistory(raw: unknown): HistoryMsg[] {
  if (!Array.isArray(raw)) return []
  return raw
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_MAX_MSGS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, HISTORY_MAX_CHARS) }))
}

function formatHistory(history: HistoryMsg[]): string {
  return history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// Strip ```json fences / prose and parse a JSON array out of a planner reply. Returns [] on failure
// so a malformed planning turn degrades to "no extra queries" rather than throwing.
function parseJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(content: any[]): string {
  return (content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
}

// Final synthesis call (selected model). On a partial/early stop the prompt flips to acknowledge it.
// Caller picks the timeout (90s normal / 20s after a STOP) and whether the run's abort signal applies
// (it must NOT after a STOP — the signal is already aborted and the wind-down synthesis still has to
// run). A throw here is caught by runResearch, which saves the raw findings instead.
async function synthesize(model: string, systemPrompt: string, userText: string, b: Budget, opts: { signal?: AbortSignal; timeout: number }): Promise<string> {
  const r = await callLLM(model, { system: systemPrompt, user: userText, maxTokens: MAX_TOK.synth, signal: opts.signal, timeout: opts.timeout })
  meterTokens(b, r.usage)
  return r.text
}

// FIX 1 — the References section must always survive. The synthesis prompt asks for one, but the
// model can drop it (the Dayeh report had zero URLs). If it's missing and sources exist, append it
// deterministically from the deduped run-wide list — zero tokens, cannot be skipped.
function ensureReferences(report: string, sources: Source[]): string {
  if (!sources.length || /^##\s+(References|Sources)\b/mi.test(report)) return report
  return `${report}\n\n## References\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')}`
}

// FIX 3 — deterministic provenance stamp on every report: exactly how much live searching backs it.
// When NO searches completed, it says so loudly — a report built purely from model knowledge must
// never read as researched fact (the "verified publicly available records" fabrication class).
function provenanceNote(searches: number, sourceCount: number): string {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  if (!searches) {
    return `\n\n---\n*⚠ Provenance: no live web searches completed for this report — the content above is model knowledge, not verified research. Confirm independently before acting on it.*`
  }
  return `\n\n---\n*Provenance: compiled from ${searches} live web search${searches === 1 ? '' : 'es'} across ${sourceCount} unique source${sourceCount === 1 ? '' : 's'} on ${date}. Claims without a citation were not verified by live search — confirm independently before acting on them.*`
}

// FIX 2 — the traceability sidecar: every agent's directive, queries, the exact compressed summary
// synthesis received, and that agent's own source URLs. Written to the vault next to the report so
// every claim in a notebook can be traced back to the agent + URL that produced it.
function buildFindingsMd(query: string, plan: OrchPlan, summaries: Map<number, string>, track: RunTrack): string {
  const agents = plan.agents.map(a => {
    const srcs = track.byAgent.get(a.id) ?? []
    return `## Agent ${a.id} — ${a.name}\n**Directive:** ${a.directive}\n**Queries:** ${a.queries.join(' · ') || '(none)'}\n\n**Summary (as fed to synthesis):**\n${summaries.get(a.id) || '_(no findings)_'}\n\n**Sources:**\n${srcs.length ? srcs.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n') : '_(none — nothing this agent reported came from a live search)_'}`
  })
  return `---\ntitle: "Sources & Agent Findings: ${query.slice(0, 70).replace(/"/g, "'")}"\ncreated_by: spectre\ntype: research-findings\ndate: ${new Date().toISOString()}\n---\n\n# Raw agent findings — ${query.slice(0, 80)}\n\n**Plan reasoning:** ${plan.reasoning || '(none)'}\n**Live searches completed:** ${track.searches} · **Unique sources:** ${track.allSources.length}\n\n${agents.join('\n\n')}\n`
}

// Last-resort report when synthesis itself fails or times out: the labeled agent findings as plain
// markdown. Costs zero tokens and guarantees the run's output is never lost.
function rawFindingsReport(query: string, plan: OrchPlan, summaries: Map<number, string>, allSources: Source[], partial: boolean): string {
  const sections = plan.agents
    .filter(a => summaries.get(a.id))
    .map(a => `## ${a.name}\n_Directive: ${a.directive}_\n\n${summaries.get(a.id)}`)
  const refs = allSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')
  return `**${partial ? 'This research was stopped early. ' : ''}Synthesis was unavailable — these are the raw agent findings.**\n\n# Research findings: ${query}\n\n${sections.join('\n\n') || '_No findings were collected._'}\n\n## Sources\n${refs || '_None._'}`
}

const REPORT_FORMAT = `Produce a structured markdown report with:
- A "## Executive Summary" section (3-4 sentences).
- "## Key Findings" organized by theme.
- A detailed "##" section for each major angle.
- Sources cited inline as [1], [2], etc.
- A final "## References" section listing every source as a numbered markdown link.
PROVENANCE RULES (mandatory):
- Cite ONLY from the numbered "Discovered sources" list you are given — never invent a citation, URL, or source.
- Never claim a fact was "verified", "confirmed", or drawn from "official records" unless a provided source states it; never imply checks that were not performed.
- If an agent finding has no supporting source in the list, present it explicitly as unverified.
Write in clean markdown. Do not include any preamble before the report.`

// Build the synthesis system prompt; if the run was stopped early, prepend the partial directive.
function synthSystem(base: string, partial: boolean): string {
  if (partial) {
    return `You are a research synthesist. Synthesize a PARTIAL research report from these (incomplete) findings. At the very top, add a short note in bold that this research was stopped early and may be incomplete. ${REPORT_FORMAT}`
  }
  return `${base} ${REPORT_FORMAT}`
}

// Persist the finished report. Primary: a Docu-scape notebook. Fallback 1: a timestamped .md in the
// node's vault notebooks dir. Fallback 2 (handled by the caller via the 'fallback' SSE event): the
// full markdown is streamed to the client to drop into chat — output is NEVER lost.
// `findingsMd` (FIX 2) is the raw agent-findings sidecar, written FIRST and independently of the
// notebook outcome so sources stay traceable even when the report save degrades to a fallback.
async function saveReport(nodeId: string, topic: string, markdown: string, partial: boolean, b: Budget, emit: Emit, findingsMd?: string) {
  emit({ type: 'step', step: 'save' })
  if (findingsMd) {
    // Vault error policy: a sidecar write failure logs and no-ops — it never blocks the report.
    try {
      ensureNodeFolders(nodeId)
      const dir = getNotebooksPath(nodeId)
      if (dir) {
        const fname = `sources-${slug(topic).slice(0, 60)}-${Date.now()}.md`
        await writeFile(join(dir, fname), findingsMd, 'utf-8')
        console.log('[research] findings sidecar saved:', fname)
      }
    } catch (err) {
      console.error('[research] findings sidecar write failed (non-fatal):', err)
    }
  }
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const title = `${partial ? '[Partial] ' : ''}Research: ${topic.slice(0, 80)} — ${date}`

  // Primary — notebook.
  try {
    const content = JSON.stringify(markdownToTiptap(markdown))
    const notebook = createNotebook({ node_id: nodeId, title, type: 'notebook', parent_id: '', content, created_by: 'spectre' })
    void syncNotebookToVault(notebook.id)
    emit({ type: 'complete', notebookId: notebook.id, notebookTitle: notebook.title, tokens: b.used, cost: estCostUsd(b), partial })
    return
  } catch (err) {
    console.error('[research] createNotebook failed, trying disk fallback:', err)
  }

  // Fallback 1 — write the raw markdown straight to the vault as a timestamped .md.
  try {
    ensureNodeFolders(nodeId)
    const dir = getNotebooksPath(nodeId)
    if (dir) {
      const fname = `${slug(title)}-${Date.now()}.md`
      const frontmatter = `---\ntitle: "${title.replace(/"/g, "'")}"\ncreated_by: spectre\n---\n\n`
      await writeFile(join(dir, fname), frontmatter + markdown, 'utf-8')
      console.error('[research] saved report to disk fallback:', fname)
      // Still hand the client the full report so it lands somewhere visible in the UI.
      emit({ type: 'fallback', title, report: markdown, partial, savedToDisk: true })
      return
    }
  } catch (err) {
    console.error('[research] disk fallback failed:', err)
  }

  // Fallback 2 — stream the report to the client to post as a chat message.
  emit({ type: 'fallback', title, report: markdown, partial, savedToDisk: false })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DEEP RESEARCH — INTELLIGENT ORCHESTRATED DAG (the only pipeline)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// A Sonnet orchestrator designs a minimal, dependency-aware multi-agent plan (no overlap, parallel
// where possible, sequential only where one agent genuinely needs another's findings first). A DAG
// executor then runs it level-by-level (topological): same-level agents fire in parallel via
// Promise.all; later levels wait for and receive their dependencies' compressed findings. Every cost
// control of the cost overhaul carries through: ≤6 agents, adaptive ≤3 searches/agent, every search
// result Haiku-compressed before it accumulates, every agent summary ≤400 tok, running budget counter,
// at the cap we cancel unfired agents and synthesize what we have. Abort is polled between every step.

// The orchestrator is ALWAYS Sonnet — a focused structured-reasoning task where Opus adds cost without
// meaningful improvement, regardless of the user's model toggle (which still drives agents + synthesis).
const ORCHESTRATOR_MODEL = 'claude-sonnet-4-6'

const DAG = {
  MAX_AGENTS: 6,            // hard ceiling — truncate a larger plan before executing
  MAX_SEARCHES: 3,          // per agent — ceiling; the adaptive loop usually stops earlier
  ORCH_TOK: 1500,           // orchestrator plan JSON (900 still truncated broad plans → fallback)
  RESULT_COMPRESS_TOK: 150, // per-search-result Haiku compression
  RESULT_TRUNCATE_CHARS: 8000, // a search digest is cut to this BEFORE Haiku compression
  AGENT_SUMMARY_TOK: 400,   // an agent's final compressed summary (what dependents + synthesis receive)
} as const
// Budget gating is the shared stopReason() gate: it returns 'budget' once used > BUDGET_CAP - CAP_HEADROOM
// (i.e. ≥190k of the 200k cap), at which point runResearch cancels any unfired agents and synthesizes.

const ORCHESTRATOR_SYSTEM = `You are a research orchestration agent. Your job is to design the most efficient possible multi-agent research plan for a given query. Think carefully before deciding:

- How many agents does this query actually need? Use the minimum necessary. Simple queries may need 2. Complex interdisciplinary queries may need 5-6. Never create agents for the sake of it.

- What is each agent's specific, non-overlapping directive? Each agent should cover ground no other agent covers.

- Which agents are truly independent and can run in parallel?

- Which agents would produce better results if they received another agent's findings first? These are sequential dependencies.

- What 2-3 search queries should each agent start with? These should be precise and targeted, not broad.

Design for maximum information density with minimum token usage. Overlap between agents is waste. Dependencies should only exist when genuinely needed — not everything needs to be sequential.

Return ONLY valid JSON, no preamble. Schema:
{
  "reasoning": "Brief explanation of why this structure fits this query",
  "agents": [
    { "id": 1, "name": "Short display name", "directive": "Specific research goal for this agent", "queries": ["query 1", "query 2"], "dependencies": [], "receives_from": [] }
  ],
  "synthesis_focus": "What the synthesis agent should prioritize given this specific research goal"
}`

type OrchAgent = {
  id: number; name: string; directive: string; queries: string[]
  dependencies: number[]; receives_from: number[]
}
type OrchPlan = { reasoning: string; agents: OrchAgent[]; synthesis_focus: string }

// Parse a single JSON object out of an LLM reply (strips ```json fences / prose). null on failure.
function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

// Sanitize the orchestrator output: clamp to ≤6 agents, coerce every field, slice queries to ≤3, and
// drop self / dangling dependency ids. Returns null if there's nothing usable (→ caller falls back).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizePlan(raw: Record<string, unknown> | null, query: string, maxAgents: number = DAG.MAX_AGENTS, maxSearches: number = DAG.MAX_SEARCHES): OrchPlan | null {
  if (!raw || !Array.isArray((raw as any).agents) || (raw as any).agents.length === 0) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agents0 = ((raw as any).agents as any[]).slice(0, maxAgents).map((a, i) => ({
    id: typeof a?.id === 'number' ? a.id : i + 1,
    name: String(a?.name ?? `Agent ${i + 1}`).slice(0, 60),
    directive: String(a?.directive ?? query),
    queries: Array.isArray(a?.queries) ? a.queries.map(String).filter(Boolean).slice(0, maxSearches) : [query],
    dependencies: Array.isArray(a?.dependencies) ? a.dependencies.map(Number).filter((n: number) => Number.isFinite(n)) : [],
    receives_from: Array.isArray(a?.receives_from) ? a.receives_from.map(Number).filter((n: number) => Number.isFinite(n)) : [],
  }))
  const ids = new Set(agents0.map(a => a.id))
  const agents = agents0.map(a => ({
    ...a,
    queries: a.queries.length ? a.queries : [query],
    dependencies: a.dependencies.filter((d: number) => ids.has(d) && d !== a.id),
    receives_from: a.receives_from.filter((d: number) => ids.has(d) && d !== a.id),
  }))
  return {
    reasoning: String((raw as any).reasoning ?? ''),
    synthesis_focus: String((raw as any).synthesis_focus ?? 'a clear, comprehensive synthesis of all findings'),
    agents,
  }
}

// Topological grouping into execution levels: level 0 = no dependencies; level N = all deps in earlier
// levels. Cycle-safe — if a pass makes no progress (a dependency cycle), everything left is forced into
// the current level so the graph always executes. Returns e.g. [[1,2,3],[4,5],[6]].
function topoLevels(agents: OrchAgent[]): number[][] {
  const placed = new Map<number, number>()
  const remaining = new Set(agents.map(a => a.id))
  const byId = new Map(agents.map(a => [a.id, a]))
  const levels: number[][] = []
  let level = 0, guard = 0
  while (remaining.size && guard++ < agents.length + 2) {
    const here: number[] = []
    for (const id of remaining) {
      if (byId.get(id)!.dependencies.every(d => placed.has(d))) here.push(id)
    }
    const toPlace = here.length ? here : [...remaining]   // no progress → break the cycle
    levels[level] = toPlace.sort((a, b) => a - b)
    for (const id of toPlace) { placed.set(id, level); remaining.delete(id) }
    level++
  }
  return levels.filter(l => l && l.length)
}

// Run the Sonnet orchestrator → sanitized plan, or null on any failure (caller falls back).
// When the triggering session's history is present, it is injected so the plan is grounded in what
// was actually discussed — not a blind read of the raw query string (the session-isolation fix).
async function orchestrate(query: string, b: Budget, history: HistoryMsg[]): Promise<OrchPlan | null> {
  // The agent budget scales with mode: Quick uses the minimum, Deep/Exhaustive can fan out wider.
  const agentGuidance = `\n\nThis is a ${b.cfg.mode.toUpperCase()} research run — design up to ${b.cfg.maxAgents} agents (use as many as the breadth genuinely warrants; ${b.cfg.mode === 'quick' ? 'stay lean' : 'cover the topic thoroughly with non-overlapping directives'}).`
  const system = (history.length
    ? `${ORCHESTRATOR_SYSTEM}\n\nYou will be given recent conversation context from the chat session that triggered this research. You are a research planning agent: design a targeted research plan based on that conversation. Your agents must be specifically relevant to what was discussed — not generic. Ground every directive and search query in the specific entities, names, and goals from the conversation.`
    : ORCHESTRATOR_SYSTEM) + agentGuidance
  const user = history.length
    ? `Recent conversation context:\n${formatHistory(history)}\n\nBased on this conversation, design a research plan for: ${query}`
    : query
  try {
    // Orchestrator: Sonnet for Claude runs (structured-reasoning quality), gpt-oss for local runs.
    // effort:'low' on gpt-oss so its chain-of-thought doesn't consume the token budget the plan JSON
    // needs (medium reasoning was truncating big plans mid-JSON → fallback to 3 generic agents).
    const r = await callLLM(b.isLocal ? 'local' : ORCHESTRATOR_MODEL, { system, user, maxTokens: b.cfg.orchTok, signal: b.signal, timeout: b.lim.perCallTimeout, effort: 'low' })
    meterTokens(b, r.usage)
    const plan = sanitizePlan(parseJsonObject(r.text), query, b.cfg.maxAgents, b.cfg.maxSearches)
    // Diagnosable fallback: a null here is almost always max_tokens truncation of the plan JSON.
    if (!plan) console.warn(`[research] orchestrator output unusable (${r.text.length} chars) — falling back. Tail: …${r.text.slice(-160)}`)
    return plan
  } catch (e) {
    console.error('[research] orchestrator failed:', e)
    return null
  }
}

// Fallback when the orchestrator produces no usable plan: the previous Max behavior — 3 parallel
// agents (Haiku-planned distinct directions if possible, else the raw query), no dependencies.
// Also part of the cold planning path, so it receives the same session history as the orchestrator —
// otherwise an orchestrator hiccup would silently regress to blind planning.
async function fallbackPlan(query: string, b: Budget, history: HistoryMsg[]): Promise<OrchPlan> {
  const user = history.length
    ? `Recent conversation context:\n${formatHistory(history)}\n\nBased on this conversation, break down this research topic: ${query}`
    : query
  try {
    const r = await callLLM(b.isLocal ? 'local' : HAIKU, {
      system: 'You are a research lead. Break the topic into 3 DISTINCT research directions — different angles, not just different queries. When conversation context is provided, the directions must be specifically relevant to what was discussed, not generic. Output a JSON array of objects: [{ "name": string, "directive": string, "queries": string[] }]. Each gets up to 2 queries. Return ONLY valid JSON.',
      user, maxTokens: MAX_TOK.plan + 700, signal: b.signal, timeout: b.lim.perCallTimeout, effort: 'low',
    })
    meterTokens(b, r.usage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dirs = (parseJsonArray(r.text) as any[]).slice(0, 3)
    if (dirs.length) {
      return {
        reasoning: 'Orchestration unavailable — fell back to 3 parallel research directions.',
        synthesis_focus: 'a comprehensive, unified synthesis of all findings',
        agents: dirs.map((d, i) => ({
          id: i + 1,
          name: String(d?.name ?? `Direction ${i + 1}`).slice(0, 60),
          directive: String(d?.directive ?? query),
          queries: Array.isArray(d?.queries) ? d.queries.map(String).filter(Boolean).slice(0, 2) : [query],
          dependencies: [], receives_from: [],
        })),
      }
    }
  } catch (e) {
    console.error('[research] fallback planner failed:', e)
  }
  // Hard fallback: 3 generic parallel agents on the raw query.
  return {
    reasoning: 'Fell back to 3 parallel agents.',
    synthesis_focus: 'a comprehensive synthesis of all findings',
    agents: [1, 2, 3].map(id => ({ id, name: `Agent ${id}`, directive: query, queries: [query], dependencies: [], receives_from: [] })),
  }
}

// ── STREAMED SEARCH — the core of the redesign ───────────────────────────────────────────────────
// One agent-scoped search call, STREAMED. Liveness is judged by event flow, not wall-clock: a
// productive 70s call completes; a call silent for SEARCH_IDLE_MS is stalled and aborted; an
// absolute SEARCH_MAX_MS ceiling backstops everything. The run's AbortController chains in for
// instant STOP. Sources are emitted to the circuit board the moment the stream delivers them, and
// everything received BEFORE a stall/abort survives — a partially-failed search still contributes.
// Usage (incl. the per-search fee) is metered into both the global budget and the agent's meter.
async function streamedSearch(
  topic: string, query: string, agentId: number,
  b: Budget, ab: { used: number }, emit: Emit, onSource: (s: Source) => void,
): Promise<SearchResult> {
  emit({ type: 'agent_searching', agentId, query })
  emit({ type: 'searching', query })

  // STEP 1 — Tavily for SEARCH + URL discovery (always). Quick mode reads its snippets directly;
  // Deep/Exhaustive fetch full page text in step 2.
  const full = b.cfg.fullContent && b.pwUp
  const sr = await tavilySearch(query, {
    depth: 'advanced', maxResults: full ? 8 : 6, includeAnswer: false,
    includeRawContent: !full,   // when Playwright will fetch full text, skip Tavily's raw_content
    signal: b.signal, timeoutMs: b.lim.searchMaxMs,
  })
  const sources: Source[] = []
  for (const h of sr.results) {
    const s: Source = { url: h.url, title: h.title }
    sources.push(s)
    onSource(s)
    const domain = domainOf(h.url)
    emit({ type: 'agent_reading', agentId, source: s.title, url: s.url, favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '' })
    emit({ type: 'source', url: s.url, title: s.title, domain })
  }
  if (sr.ok) b.webSearches += 1
  emitTokens(b, emit, agentId)

  const ok = sr.ok && sources.length > 0
  if (!sources.length) return { summary: '', sources, ok }

  // STEP 2 — DEEP/EXHAUSTIVE: fetch the FULL readable text of each URL with Playwright so the agent
  // digests whole articles, not Tavily's ~500-char snippet. Each hit's content becomes the full page
  // text when the fetch succeeds, else falls back to the snippet. `crawl` also returns on-page links
  // (the Exhaustive seed pool). Playwright is best-effort: any failure degrades to the snippet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hits: { title: string; url: string; content: string }[] = sr.results.map(h => ({ title: h.title, url: h.url, content: h.content }))
  const crawlLinks: PageLink[] = []
  if (full && sr.results.length) {
    emit({ type: 'agent_searching', agentId, query: `Reading ${sr.results.length} pages in full…` })
    const pages = await fetchPages(sr.results.map(h => h.url), {
      maxChars: 18000, followLinks: b.cfg.crawl, maxLinks: 30, concurrency: 4, signal: b.signal, timeoutMs: b.lim.searchMaxMs * 3,
    })
    hits = sr.results.map(h => {
      const p = pages.find(x => x.url === h.url)
      const text = p && p.ok && p.text.length > (h.content?.length ?? 0) ? p.text : (h.content || (p?.text ?? ''))
      if (p?.links?.length) for (const l of p.links) if (crawlLinks.length < 60) crawlLinks.push(l)
      return { title: h.title, url: h.url, content: text }
    })
  }

  // STEP 3 — digest the content into dense notes with the utility model (Haiku / gpt-oss). Full
  // content gets a larger per-hit window AND a larger digest budget than snippet mode. LOCAL caps are
  // smaller (gpt-oss 16k context); Claude can take the full articles.
  const perHit = full ? (b.isLocal ? 3000 : 6000) : 2200
  const totalCap = full ? (b.isLocal ? 12000 : 30000) : DAG.RESULT_TRUNCATE_CHARS
  const content = hits
    .map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${(h.content || '').slice(0, perHit)}`)
    .join('\n\n').slice(0, totalCap)
  try {
    const comp = await callLLM(b.isLocal ? 'local' : HAIKU, {
      system: 'You compress web research into dense, factual notes. No preamble.',
      user: `Extract the key facts, numbers, named entities, and findings from these ${full ? 'full-page sources' : 'search results'} relevant to "${topic}". ${full ? 'Be thorough — 5-8 dense sentences capturing specifics.' : 'In 3-4 dense sentences.'} Reference source numbers like [1] where a fact comes from one.\n\n${content}`,
      maxTokens: b.cfg.digestTok, signal: b.signal, timeout: b.lim.perCallTimeout, effort: 'low',
    })
    meterTokens(b, comp.usage)
    meterTokens(ab, comp.usage)
    emitTokens(b, emit, agentId)   // live update — per-result compression
    const c = comp.text.trim()
    if (c) return { summary: c, sources, ok, links: crawlLinks }
  } catch (e) {
    console.error('[research] result-compress failed, using raw extract:', e)
  }
  // Digest failed — a deterministic stub from titles + a snippet, so the agent still contributes.
  const stub = `Search "${query}" found ${sources.length} sources: ${sources.slice(0, 6).map(s => s.title).join('; ')}. ${content.slice(0, 700)}`
  return { summary: stub, sources, ok, links: crawlLinks }
}

// Execute ONE agent: receive its directive + the orchestrator's reasoning + its dependencies' compressed
// findings, run up to MAX_SEARCHES adaptive searches (each compressed), then Haiku-compress to a
// ≤400-tok summary that dependents and synthesis receive. Emits the lifecycle events.
async function runDagAgent(
  agent: OrchAgent, plan: OrchPlan, query: string,
  summaries: Map<number, string>, track: RunTrack, b: Budget, emit: Emit,
): Promise<void> {
  emit({ type: 'agent_started', agentId: agent.id })
  // Pull the compressed findings (≤400 tok each) from this agent's dependencies — fire the pulse on
  // each connection as findings travel into this agent.
  const depIds = Array.from(new Set([...agent.dependencies, ...agent.receives_from]))
  const depBlocks: string[] = []
  for (const d of depIds) {
    emit({ type: 'dependency_resolved', fromAgentId: d, toAgentId: agent.id })
    const s = summaries.get(d)
    if (s) {
      const dep = plan.agents.find(a => a.id === d)
      depBlocks.push(`Findings from "${dep?.name ?? `agent ${d}`}":\n${s}`)
    }
  }
  // The digest "focus" — the agent's specific directive, plus a short note of upstream findings so
  // a dependent agent's per-search compression stays on its own ground and builds on, not repeats,
  // earlier work. (Search itself is Tavily on the orchestrator's pre-planned queries.)
  const depNote = depBlocks.length ? ` (build on, don't repeat, earlier findings: ${depBlocks.join(' | ').slice(0, 800)})` : ''
  const focus = `${agent.directive}${depNote}`

  // ── ADAPTIVE SEARCH LOOP ──
  // After EVERY search the agent re-assesses instead of blindly running a fixed quota:
  //  · global stop gate (abort / hard cost / token cap / deadline) → stop now with what it has
  //  · per-agent token cap → stop this agent
  //  · soft cost target reached → no NEW searches (first search always allowed)
  //  · ENOUGH material held (summaries + sources) → stop early, save the remaining spend
  // A failed search doesn't kill the agent — it moves on to its next query.
  const ab = { used: 0 }
  const parts: string[] = []
  let mySources = 0
  const queries = agent.queries.slice(0, b.cfg.maxSearches)
  for (let i = 0; i < queries.length; i++) {
    if (stopReason(b)) break
    if (ab.used > b.lim.agentCap) {
      console.warn(`[research] agent ${agent.id} (${agent.name}) hit its ${b.lim.agentCap}-token cap at ${ab.used} — stopping agent`)
      emit({ type: 'status', message: `${agent.name} hit its token cap — continuing with findings so far` })
      break
    }
    if (i > 0 && softStop(b)) {
      emit({ type: 'status', message: `Budget target reached — ${agent.name} stopping with findings so far` })
      break
    }
    if (parts.length >= ENOUGH_SUMMARIES && mySources >= ENOUGH_SOURCES) {
      emit({ type: 'status', message: `${agent.name} has enough material — finishing early` })
      break
    }
    track.attempts++
    // Sources are deduped by URL into BOTH the run-wide list (synthesis + References) and this
    // agent's own list (the findings sidecar — per-claim traceability).
    const r = await streamedSearch(focus, queries[i], agent.id, b, ab, emit, s => {
      if (!track.allSources.some(x => x.url === s.url)) track.allSources.push(s)
      track.seenDomains.add(domainOf(s.url))
      const mine = track.byAgent.get(agent.id) ?? []
      if (!mine.some(x => x.url === s.url)) { mine.push(s); track.byAgent.set(agent.id, mine) }
    })
    if (r.ok) track.searches++   // provenance: a search counts if it returned ANY live data
    if (r.summary) parts.push(r.summary)
    mySources += r.sources.length
    // Exhaustive crawl: stash newly-discovered on-page links (deduped) as seeds for later rounds.
    if (r.links?.length) for (const l of r.links) {
      if (track.crawlLinks.length < 200 && !track.crawlLinks.some(x => x.url === l.url)) track.crawlLinks.push(l)
    }
  }
  if (!parts.length) {
    // Honesty: this agent contributes nothing — say so rather than letting it pass silently.
    emit({ type: 'status', message: `${agent.name}: searches returned no usable results` })
  }
  // Final ≤400-tok summary. Only compress further when there's more than one search to merge, and
  // skip the extra call entirely when a stop has been signaled — return the parts as-is.
  let summary = parts.join('\n\n')
  if (parts.length > 1 && !stopReason(b) && ab.used <= b.lim.agentCap) {
    try {
      const comp = await callLLM(b.isLocal ? 'local' : HAIKU, {
        system: 'You compress research findings into a tight briefing. Concise, factual, no preamble.',
        user: `Compress these findings on "${agent.directive}" into a dense briefing (~300 words max) keeping the key facts and figures:\n\n${summary.slice(0, DAG.RESULT_TRUNCATE_CHARS)}`,
        maxTokens: DAG.AGENT_SUMMARY_TOK, signal: b.signal, timeout: b.lim.perCallTimeout, effort: 'low',
      })
      meterTokens(b, comp.usage)
      meterTokens(ab, comp.usage)
      emitTokens(b, emit, agent.id)   // live update — final per-agent summary compression
      const c = comp.text.trim()
      if (c) summary = c
    } catch (e) {
      console.error('[research] agent-summary compress failed:', e)
    }
  }
  summaries.set(agent.id, summary)
  emit({ type: 'agent_complete', agentId: agent.id, summaryPreview: summary.slice(0, 100) })
}

// ── Knowledge saturation (Exhaustive auto-winddown + live indicator) ──────────────────────────────
function cosine(a: number[], c: number[]): number {
  let dot = 0, na = 0, nc = 0
  const n = Math.min(a.length, c.length)
  for (let i = 0; i < n; i++) { dot += a[i] * c[i]; na += a[i] * a[i]; nc += c[i] * c[i] }
  return na && nc ? dot / (Math.sqrt(na) * Math.sqrt(nc)) : 0
}
type SaturationState = { round: number; priorEmbeddings: number[][]; objectiveEmb: number[] | null; objectiveResolved: boolean; consecutiveLow: number; priorDomains: number }
function makeSaturation(): SaturationState {
  return { round: 0, priorEmbeddings: [], objectiveEmb: null, objectiveResolved: false, consecutiveLow: 0, priorDomains: 0 }
}
// After a round, measure how much GENUINELY NEW information the round's summaries added — relative to
// everything gathered so far AND to the objective (the reference frame "enough" is measured against).
// Emits a `saturation` event and returns the round novelty (0 = fully redundant, 1 = entirely new
// ground). Embedding-based (Ollama nomic-embed-text, reused from the vault); if embeddings are
// unavailable it falls back to a new-domain ratio so the detector never blocks the run.
async function measureSaturation(sat: SaturationState, roundSummaries: string[], objective: string, track: RunTrack, b: Budget, emit: Emit): Promise<number> {
  sat.round++
  if (!sat.objectiveResolved) { sat.objectiveResolved = true; sat.objectiveEmb = await embedText(objective).catch(() => null) }
  const fresh = roundSummaries.filter(s => s && s.trim().length > 20)
  const embs: number[][] = []
  for (const s of fresh) { try { const e = await embedText(s); if (e) embs.push(e) } catch { /* Ollama down — fall back below */ } }
  let novelty: number
  if (embs.length) {
    const novelties = embs.map(e => {
      const maxPrior = sat.priorEmbeddings.length ? Math.max(...sat.priorEmbeddings.map(p => cosine(e, p))) : 0
      let nov = 1 - maxPrior
      // Relevance gate: novel-but-off-objective content doesn't advance the goal, so it counts less.
      if (sat.objectiveEmb) nov *= Math.max(0.2, Math.min(1, cosine(e, sat.objectiveEmb) + 0.3))
      return Math.max(0, Math.min(1, nov))
    })
    novelty = novelties.reduce((a, c) => a + c, 0) / novelties.length
    sat.priorEmbeddings.push(...embs)
  } else {
    const newDomains = track.seenDomains.size - sat.priorDomains
    novelty = sat.round === 1 ? 1 : Math.max(0, Math.min(1, newDomains / 4))
  }
  sat.priorDomains = track.seenDomains.size
  sat.consecutiveLow = novelty < b.cfg.noveltyThreshold ? sat.consecutiveLow + 1 : 0
  emit({ type: 'saturation', round: sat.round, novelty: Number(novelty.toFixed(3)), saturation: Number((1 - novelty).toFixed(3)), consecutiveLow: sat.consecutiveLow, threshold: b.cfg.noveltyThreshold, needed: b.cfg.saturationRounds })
  return novelty
}

// Exhaustive continuation planner: given everything found so far, design NEW agents to fill the most
// important remaining GAPS (or return an empty agents array if the topic is genuinely exhausted).
async function orchestrateGaps(query: string, priorSummaries: string[], track: RunTrack, b: Budget): Promise<OrchPlan | null> {
  const covered = priorSummaries.slice(-12).map(s => `- ${s.slice(0, 220)}`).join('\n')
  const seeds = track.crawlLinks.slice(0, 20).map(l => `${l.text || '(link)'} — ${l.url}`).join('\n')
  const system = `You are extending an EXHAUSTIVE research investigation — the goal is maximum depth and coverage, so err toward CONTINUING. Identify GAPS the findings have NOT yet covered: deeper sub-questions, specific entities/people/tools/papers, counterarguments, recent developments, edge cases, comparisons, quantitative detail, or adjacent angles. Design 2-${b.cfg.maxAgents} NEW agents (each covering ground no prior agent covered). Only return an EMPTY "agents" array if you genuinely cannot identify ANY new productive angle. Return ONLY valid JSON: {"reasoning": string, "agents": [{"id": number, "name": string, "directive": string, "queries": ["q1","q2"], "dependencies": [], "receives_from": []}], "synthesis_focus": string}`
  const user = `Objective: ${query}\n\nFindings so far:\n${covered || '(none)'}\n\nDiscovered-but-unread links (possible seeds):\n${seeds || '(none)'}\n\nDesign new agents to dig deeper into the most important remaining gaps.`
  try {
    const r = await callLLM(b.isLocal ? 'local' : ORCHESTRATOR_MODEL, { system, user, maxTokens: b.cfg.orchTok, signal: b.signal, timeout: b.lim.perCallTimeout, effort: 'low' })
    meterTokens(b, r.usage)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = parseJsonObject(r.text)
    // An explicit empty-agents reply is "saturated" — return a plan with zero agents (caller stops).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (raw && Array.isArray((raw as any).agents) && (raw as any).agents.length === 0) return { reasoning: String((raw as any).reasoning ?? 'No gaps remain.'), synthesis_focus: '', agents: [] }
    return sanitizePlan(raw, query, b.cfg.maxAgents, b.cfg.maxSearches)
  } catch (e) { console.error('[research] gap orchestrator failed:', e); return null }
}
const MAX_EXHAUSTIVE_ROUNDS = 50   // hard safety backstop — saturation/wind-down stop long before this

// Orchestrate → topo-sort → execute the DAG level-by-level → synthesize (model toggle) → save.
// `providedPlan` is Spectre's context-aware plan (when it orchestrated in conversation). When present
// and valid it is used directly — the cold orchestrator is skipped. A malformed plan validates to null
// and silently falls through to the cold orchestrator, then to the parallel-agents fallback.
async function runResearch(query: string, nodeId: string, model: string, b: Budget, emit: Emit, providedPlan: unknown, history: HistoryMsg[], chatSessionId: string) {
  emit({ type: 'step', step: 'plan' })
  let plan: OrchPlan | null = null
  if (providedPlan) {
    plan = sanitizePlan(providedPlan as Record<string, unknown>, query, b.cfg.maxAgents, b.cfg.maxSearches)
    if (plan) emit({ type: 'status', message: "Using Spectre's research plan..." })
    else console.warn('[research] provided plan failed validation — falling back to cold orchestrator')
  }
  const usedSpectrePlan = !!plan
  if (!plan) {
    emit({ type: 'status', message: 'Planning research strategy...' })
    plan = await orchestrate(query, b, history)
    emitTokens(b, emit)   // live update — orchestrator planning call
  }
  if (!plan) {
    emit({ type: 'status', message: 'Orchestrator unavailable — dispatching parallel agents...' })
    plan = await fallbackPlan(query, b, history)
    emitTokens(b, emit)   // live update — fallback planning call
  }
  // Permanent diagnostic — confirms exactly what session context the planner received and which
  // planning path ran, so a wrong-context plan is immediately attributable in the dev console.
  console.log(`=== RESEARCH CONTEXT VERIFICATION ===
Session ID: ${chatSessionId || '(none)'}
Messages loaded: ${history.length}
First message: ${history[0]?.content.slice(0, 80) ?? '(none)'}
Last message: ${history[history.length - 1]?.content.slice(0, 80) ?? '(none)'}
Plan provided: ${usedSpectrePlan ? 'yes' : 'no'}
Orchestrator output preview: ${plan.agents[0] ? `${plan.agents[0].name} — ${plan.agents[0].directive.slice(0, 120)}` : '(no agents)'}
=====================================`)
  const levels0 = topoLevels(plan.agents)
  // Log the plan on every run so the structure can be inspected in the dev console (verification #4).
  console.log('[research] DAG plan:', JSON.stringify(plan))
  console.log('[research] DAG levels:', JSON.stringify(levels0))
  emit({ type: 'dag_plan', plan, levels: levels0, mode: b.cfg.mode })

  emit({ type: 'step', step: 'search' })
  const summaries = new Map<number, string>()
  const track: RunTrack = { allSources: [], byAgent: new Map(), searches: 0, attempts: 0, crawlLinks: [], seenDomains: new Set() }
  const sat = makeSaturation()
  let warned = false
  let softWarned = false
  let reason: StopReason = null

  // Execute a batch of agents (the initial plan, or an Exhaustive gap-round) level-by-level, then
  // measure saturation. Returns false to signal the run should stop (stopped / wound-down / failed).
  const executeAgents = async (agents: OrchAgent[]): Promise<boolean> => {
    const byId = new Map(agents.map(a => [a.id, a]))
    // Snapshot the cumulative counters so the honesty gate measures THIS call's searches, not the
    // run's running total — otherwise once any round records a success the gate can never fire
    // again, and a mid-run search outage would burn agents until the round/cost backstop.
    const attemptsBefore = track.attempts
    const searchesBefore = track.searches
    for (const level of topoLevels(agents)) {
      // Wind Down (user button OR Exhaustive saturation auto-trigger): finish the current level, then
      // launch no further levels/rounds → straight to a FULL synthesis. Distinct from STOP (abort).
      if (isWindDownRequested(b.sessionId)) { reason = 'winddown'; return false }
      if (!softWarned && softStop(b)) {
        softWarned = true
        emit({ type: 'budget_warning', message: `Research at ~$${estCostUsd(b).toFixed(2)} — wrapping up, no new searches will start` })
      }
      reason = stopReason(b)
      if (reason) {
        if (reason === 'budget' && !warned) { warned = true; emit({ type: 'budget_warning', message: 'Approaching limit — synthesizing current findings' }) }
        return false
      }
      const lvlAgents = level.map(id => byId.get(id)).filter(Boolean) as OrchAgent[]
      await Promise.all(lvlAgents.map(a => runDagAgent(a, plan!, query, summaries, track, b, emit)))
      // HONESTY GATE: a full level ran and not one search returned live data → search itself is
      // failing. Stop burning agents. (A STOP/budget/timeout cause keeps THAT reason, not 'failed'.)
      if ((track.attempts - attemptsBefore) >= 2 && (track.searches - searchesBefore) === 0) {
        reason = stopReason(b) ?? 'failed'
        if (reason === 'failed') { console.warn(`[research] honesty gate: ${track.attempts - attemptsBefore} attempts this round, 0 succeeded`); emit({ type: 'status', message: 'Web searches are failing — stopping to avoid wasted spend' }) }
        return false
      }
    }
    // ── Saturation after the round ── how much NEW ground did these agents cover?
    const roundSummaries = agents.map(a => summaries.get(a.id)).filter((s): s is string => !!s)
    await measureSaturation(sat, roundSummaries, query, track, b, emit)
    // Exhaustive auto-winddown: enough consecutive low-novelty rounds → the topic has saturated.
    if (b.cfg.exhaustive && sat.consecutiveLow >= b.cfg.saturationRounds) {
      requestWindDown(b.sessionId)
      emit({ type: 'status', message: `Knowledge saturated — ${sat.consecutiveLow} rounds added little new. Winding down to synthesis…` })
    }
    return true
  }

  // Round 1 — the initial orchestrated plan.
  let cont = await executeAgents(plan.agents)

  // ── EXHAUSTIVE outer loop ── keep planning + running gap-filling agents until the topic saturates,
  // the user hits Wind Down, or a stop/cap fires. Each round re-orchestrates against what's been found.
  let roundNum = 1
  while (cont && b.cfg.exhaustive && !stopReason(b) && !isWindDownRequested(b.sessionId)) {
    if (roundNum >= MAX_EXHAUSTIVE_ROUNDS) { emit({ type: 'status', message: 'Reached the round backstop — synthesizing.' }); break }
    roundNum++
    emit({ type: 'status', message: `Round ${roundNum}: planning gap-filling agents…` })
    const gap = await orchestrateGaps(query, [...summaries.values()], track, b)
    emitTokens(b, emit)
    if (!gap || gap.agents.length === 0) { emit({ type: 'status', message: 'No material gaps remain — proceeding to synthesis.' }); break }
    // Re-id the new agents so they never collide with prior ids; append to the plan (synthesis + sidecar).
    const offset = Math.max(0, ...plan.agents.map(a => a.id))
    const newAgents: OrchAgent[] = gap.agents.map((a, i) => ({ ...a, id: offset + i + 1, dependencies: [], receives_from: [] }))
    plan.agents.push(...newAgents)
    emit({ type: 'dag_round', round: roundNum, agents: newAgents.map(a => ({ id: a.id, name: a.name, directive: a.directive, queries: a.queries })) })
    cont = await executeAgents(newAgents)
  }
  if (!reason) reason = isWindDownRequested(b.sessionId) ? 'winddown' : stopReason(b)

  // ── Synthesis ── weave the labeled agent summaries (never raw results) into one report.
  // Wind-down IS partial but DOES synthesize a full report (only a hard STOP/abort skips synthesis).
  const partial = reason === 'aborted' || reason === 'timeout' || reason === 'failed' || reason === 'winddown'
  if (reason === 'budget') emit({ type: 'status', message: 'Budget limit reached — synthesizing findings so far...' })
  else if (reason === 'aborted') emit({ type: 'status', message: 'Stopped — saving findings collected so far...' })
  else if (reason === 'winddown') emit({ type: 'status', message: 'Winding down — synthesizing everything gathered into the report…' })
  else if (reason === 'timeout') emit({ type: 'status', message: 'Time limit reached — synthesizing findings so far...' })
  else if (reason === 'failed') emit({ type: 'status', message: 'Searches failed — saving an honest failure notice...' })

  emit({ type: 'synthesis_started' })
  emit({ type: 'step', step: 'synthesize' })
  emit({ type: 'synthesizing', message: 'Weaving agent findings into a report...' })

  const labeled = plan.agents
    .filter(a => summaries.get(a.id))
    .map(a => `## ${a.name}\nDirective: ${a.directive}\n\n${summaries.get(a.id)}`)
  const findingsText = labeled.length ? labeled.join('\n\n') : '(No findings were collected before the run stopped.)'
  const synthBase = `You are synthesizing research from a coordinated multi-agent investigation. Each agent had a specific non-overlapping directive. Weave their findings into a single coherent research report that flows naturally — do not just concatenate agent outputs. Prioritize: ${plan.synthesis_focus}.`
  // Three synthesis paths:
  //  · ABORTED — STOP must land a saved notebook in <2s: skip LLM synthesis entirely; the
  //    deterministic raw-findings report costs zero tokens and zero time.
  //  · ZERO live searches — HONESTY: never synthesize model knowledge into something that reads
  //    like research. Save an explicit failure notice (costs nothing) instead.
  //  · Otherwise — normal LLM synthesis with the full 90s window (it's the run's LAST call and its
  //    input is cheap compressed summaries). It carries the run's abort signal, so a STOP arriving
  //    mid-synthesis still kills it instantly → raw-findings fallback.
  let report: string
  if (reason === 'aborted') {
    report = rawFindingsReport(query, plan, summaries, track.allSources, true)
  } else if (track.searches === 0) {
    const keyHint = isSearchConfigured() ? '' : '\n\n⚠ Web search is not configured — add `TAVILY_API_KEY` to `.env.local` and restart the dev server.'
    report = `**Research failed — no live web searches completed.**\n\nAll ${track.attempts} search attempt${track.attempts === 1 ? '' : 's'} returned no data, so there is nothing sourced to report. Rather than generate a report from model knowledge, this run is marked failed.${keyHint}\n\nIf web search IS configured, try again shortly — the search API may be momentarily rate-limited.`
  } else {
    try {
      report = await synthesize(
        model,
        synthSystem(synthBase, partial),
        `Topic: ${query}\n\nAgent findings:\n\n${findingsText}\n\nDiscovered sources:\n${track.allSources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}`,
        b,
        { signal: b.signal, timeout: b.lim.synthTimeout },
      )
    } catch (e) {
      console.warn('[research] synthesis failed/aborted/timed out — saving raw agent findings:', e instanceof Error ? e.message : e)
      emit({ type: 'status', message: 'Synthesis unavailable — saving raw findings…' })
      report = rawFindingsReport(query, plan, summaries, track.allSources, partial || !!stopReason(b))
    }
  }
  // Guarantee the References section survives, then stamp the provenance note (deterministic,
  // after synthesis, so the model can neither drop nor embellish either one).
  report = ensureReferences(report, track.allSources)
  report += provenanceNote(track.searches, track.allSources.length)
  emitTokens(b, emit)   // live update — synthesis call (the single largest output)
  emit({ type: 'synthesis_complete' })
  // STOP during synthesis, or a zero-search failure, also marks the report partial.
  const finalPartial = partial || stopReason(b) === 'aborted' || track.searches === 0
  await saveReport(nodeId, query, report, finalPartial, b, emit, buildFindingsMd(query, plan, summaries, track))
}

export async function POST(req: NextRequest) {
  let body: { query?: string; mode?: string; nodeId?: string; model?: string; sessionId?: string; plan?: unknown; chatSessionId?: string; conversationHistory?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const query = String(body.query ?? '').trim()
  // `mode` selects the research effort tier (quick | deep | exhaustive) — see modeConfig().
  // `plan` is Spectre's optional context-aware plan; when present it skips the cold orchestrator.
  const mode = resolveMode(body.mode)
  const providedPlan = body.plan
  const nodeId = String(body.nodeId ?? 'main')
  const model = resolveModel(body.model)
  // Session context isolation: `chatSessionId` + `conversationHistory` identify the triggering chat
  // session and carry its last ≤20 messages — the ONLY outside context the planner receives.
  // (`sessionId` is a separate, pre-existing field: the lock/abort key, which is the SCOPE, not the
  // chat session — /api/research/abort keys on the same value, so its semantics must not change.)
  const chatSessionId = String(body.chatSessionId ?? '').trim()
  const history = sanitizeHistory(body.conversationHistory)
  // Lock key: the chat session if supplied, else the node (so a run still can't double-fire per node).
  const lockKey = String(body.sessionId ?? '').trim() || `node:${nodeId}`
  if (!query) return new Response('query required', { status: 400 })
  // Permanent entry diagnostic (plan-path verification): which path will run + what arrived.
  console.log(`[research] request: plan=${providedPlan ? 'provided' : 'none'} chatSession=${chatSessionId || '(none)'} history=${history.length} msgs query="${query.slice(0, 100)}"`)

  // Per-session lock (FIX 2) — a duplicate / double-submitted run gets a 429 instead of a second
  // (expensive) pipeline. Released in the stream's finally.
  if (!acquireResearch(lockKey)) {
    return new Response(JSON.stringify({ error: 'Research already running for this session' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Run-wide AbortController: registered in the lock so /api/research/abort (and a client disconnect)
  // cancels every in-flight API call instantly — STOP responds in milliseconds, not call-completion.
  const controller = new AbortController()
  registerResearchController(lockKey, controller)

  const encoder = new TextEncoder()
  const isLocal = model === 'local'
  const cfg = modeConfig(mode, isLocal)
  // Deep/Exhaustive want full page content — pre-flight the Playwright container ONCE (a downed
  // container costs ~1.5s, then the run degrades to Tavily snippets rather than stalling per-search).
  const pwUp = cfg.fullContent ? await isPlaywrightUp() : false
  if (cfg.fullContent && !pwUp) console.warn('[research] Playwright container not reachable — falling back to Tavily snippets for', mode)
  // LOCAL runs (gpt-oss + Tavily) are gated by time/electricity, not dollars — relaxed caps.
  const b = makeBudget(lockKey, controller.signal, isLocal, cfg, pwUp)
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emit: Emit = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          /* controller already closed — ignore */
        }
      }
      // SSE keep-alive: a comment line every 15s so proxies / the client don't drop a long run.
      const ping = setInterval(() => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`: keep-alive\n\n`)) } catch { /* ignore */ }
      }, 15_000)

      try {
        emit({ type: 'mode', mode, fullContent: cfg.fullContent, playwright: pwUp, exhaustive: cfg.exhaustive })
        emitTokens(b, emit)   // initial zeroed counter + cost
        await runResearch(query, nodeId, model, b, emit, providedPlan, history, chatSessionId)
      } catch (err) {
        console.error('[research] pipeline failed:', err)
        emit({ type: 'error', message: err instanceof Error ? err.message : 'Research failed' })
      } finally {
        clearInterval(ping)
        releaseResearch(lockKey)
        closed = true
        controller.close()
      }
    },
    cancel() {
      // Client disconnected — request abort so the pipeline winds down to a partial synthesis and
      // still saves (server-side) rather than running on and billing. The finally releases the lock.
      requestAbort(lockKey)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

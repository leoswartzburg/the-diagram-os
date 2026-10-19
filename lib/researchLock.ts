// In-memory coordination for the deep-research pipeline. Shared by `/api/research` (which acquires a
// per-session lock and polls the abort flag between pipeline steps) and `/api/research/abort` (which
// sets the abort flag). Local single-process deployment → a module-level singleton is shared across
// both route handlers. Deliberately tiny and dependency-free.
//
// Keyed by sessionId. A session that has no DB row yet (lazy chat) still gets a stable client-supplied
// id, so the lock works before the first message is persisted.

const running = new Set<string>()
const aborted = new Set<string>()
// Wind-down is the GRACEFUL exit (distinct from abort/STOP): the current agent round finishes, no new
// agents/rounds spawn, and the run proceeds straight to a FULL synthesis. Unlike abort it does NOT
// cancel in-flight calls (so the current work completes) and it DOES synthesize (abort saves raw
// findings instead). The Exhaustive saturation detector also raises this automatically.
const windingDown = new Set<string>()
// Per-run AbortController, registered by /api/research at start. requestAbort() calls .abort() on it
// so in-flight Anthropic API calls are cancelled INSTANTLY — the abort flag alone is only polled
// between calls, which is how a stuck 14-minute search call once ignored STOP entirely.
const controllers = new Map<string, AbortController>()

// Try to take the lock for a session. Returns false if research is already running there — the route
// turns that into a 429 so a double-submit / duplicate deepResearch action can't start a second run.
export function acquireResearch(sessionId: string): boolean {
  if (running.has(sessionId)) return false
  running.add(sessionId)
  aborted.delete(sessionId) // clear any stale abort from a previous run
  windingDown.delete(sessionId)
  return true
}

// Attach the run's AbortController (called right after acquireResearch). Its signal is passed to
// every API call in the pipeline; requestAbort aborts it.
export function registerResearchController(sessionId: string, controller: AbortController): void {
  controllers.set(sessionId, controller)
}

// Release the lock when a run ends (success, error, or abort). Always called in a finally.
export function releaseResearch(sessionId: string): void {
  running.delete(sessionId)
  aborted.delete(sessionId)
  windingDown.delete(sessionId)
  controllers.delete(sessionId)
}

export function isResearchRunning(sessionId: string): boolean {
  return running.has(sessionId)
}

// Mark a session's run for early termination. Sets the polled flag AND aborts the run's controller,
// which rejects any in-flight API call immediately — STOP takes effect in milliseconds, not whenever
// the current call happens to finish. No-op if nothing is running.
export function requestAbort(sessionId: string): boolean {
  if (!running.has(sessionId)) return false
  aborted.add(sessionId)
  controllers.get(sessionId)?.abort()
  return true
}

export function isAbortRequested(sessionId: string): boolean {
  return aborted.has(sessionId)
}

// Graceful exit: finish the current round, no new agents, go straight to a full synthesis. Set by
// the Wind Down button AND by the Exhaustive saturation auto-trigger. Does NOT abort in-flight work.
export function requestWindDown(sessionId: string): boolean {
  if (!running.has(sessionId)) return false
  windingDown.add(sessionId)
  return true
}

export function isWindDownRequested(sessionId: string): boolean {
  return windingDown.has(sessionId)
}

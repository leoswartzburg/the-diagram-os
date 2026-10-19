// ── THE TOOL REGISTRY — single source of truth for everything Spectre can DO ──────
//
// Every capability is defined here EXACTLY ONCE: its model-facing name, a crisp description,
// a typed JSON-Schema for its inputs, where it's offered (scope), and how it runs (kind).
// Adapters render this list into each model's native tool format (Anthropic for Claude,
// OpenAI-style for local gpt-oss) so BOTH models see identical tools — only the wire format
// differs. One registry → one executor → one history. Switching models mid-conversation is
// seamless because the tools never change, only the transport.
//
// This replaces the old jumble where each action was described 3–4× across route
// ACTION_INSTRUCTIONS + LOCAL_TOOLS + primer prose blocks, and where Claude smuggled JSON
// inside its prose for a fragile scraper to fish out. Dead/redundant actions were dropped
// during the pre-migration clean-up: `updateStats` (Oura is live), and the three overlapping
// project updaters (updateProgress/updateProject/updateNode) collapse into one `update_project`.
//
// kind:
//   'read'   — server executes it and feeds the RESULT back to the model (the agentic loop):
//              read a doc, search, web search. This is the proper replacement for the client "drain".
//   'mutate' — server executes it (real success/failure), returns an ack + optional UI-refresh hints:
//              save a doc, calendar, update a project, log a set. The model never claims success it
//              didn't get — it sees the real tool result first.
//   'ui'     — a pure screen action the CLIENT performs (navigate, open); the server proxies the
//              call to the client and acks so the model's loop stays coherent.
//
// scope:
//   'always'  — offered on every turn (dashboard + every arm).
//   'project' — offered ONLY inside a project Hand (the document/source tools). This is the
//               progressive-disclosure cut that kills the biggest per-turn bloat on the dashboard.

export type ToolKind = 'read' | 'mutate' | 'ui'
// 'secretary' tools are offered ONLY to the Secretary agent (lib/tools/secretary.ts slice) —
// never to Spectre. That absence is the autonomy architecture: Spectre cannot mutate tasks
// because no such tool exists in its slice. (Spectre gets read-only task visibility via the
// NOW-list primer line, and delegation via tell_secretary later.)
export type ToolScope = 'always' | 'project' | 'secretary'

export type ToolDef = {
  name: string
  kind: ToolKind
  scope: ToolScope
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

// ── JSON-Schema helpers (typed inputs = the guardrail that stops malformed calls) ──
const S = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const N = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) })
const B = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) })
const ENUM = (values: string[], description?: string) => ({ type: 'string', enum: values, ...(description ? { description } : {}) })
const ARR = (items: unknown, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) })
const OBJ = (properties: Record<string, unknown>, required: string[] = [], description?: string) =>
  ({ type: 'object', properties, required, ...(description ? { description } : {}) })

const def = (
  name: string, kind: ToolKind, scope: ToolScope, description: string,
  properties: Record<string, unknown> = {}, required: string[] = [],
): ToolDef => ({ name, kind, scope, description, parameters: { type: 'object', properties, required } })

// ── The canonical tools ──────────────────────────────────────────────────────────
export const TOOLS: ToolDef[] = [
  // ── Navigation & sessions (always) ──
  def('navigate', 'ui', 'always',
    'Move the UI to any Arm or Hand of the Diagram — a project, the schedule, the training arm, the body view, etc. Use for "go to", "open", "take me to", "let\'s work on". `target` is the destination\'s name or node id (resolved against the live tree).',
    { target: S('The destination Arm/Hand name or node id.') }, ['target']),

  def('open_session', 'ui', 'always',
    'Open a chat session at the current location: start a new one, resume the most recent, or open a specific one by id.',
    { mode: ENUM(['recent', 'new', 'specific'], 'Which session to open.'), session_id: S('Required only when mode is "specific".') }, ['mode']),

  def('search_sessions', 'ui', 'always',
    'Find a past conversation at the CURRENT location by topic or title and (by default) open it on screen. This only changes what the user sees — it does not show you the content. To recall what was SAID in past conversations, use search_chats / read_chat.',
    { query: S('What to search past conversations for.'), open_result: B('Open the top match. Defaults to true.') }, ['query']),

  // ── Conversational recall (always) — Spectre's own memory of every past chat ──
  def('search_chats', 'read', 'always',
    'Search ALL of the user\'s past conversations across the entire Diagram — every arm and project — by topic, keywords, or a specific detail. This is your long-term conversational recall, far deeper than the memory snippets you\'re given: use it whenever the user references something from before ("that idea from last week", "what did we decide about X", "catch up on the trip planning") or when a past discussion would inform your answer. Returns matching conversations with ids, where they live, dates, and matched excerpts. Omit `query` to get the most recent conversations instead. Follow up with read_chat on a result\'s session id to pull the actual discussion.',
    {
      query: S('Topic or keywords to find. Omit to list the most recent conversations.'),
      place: S('Optional Arm/Hand name or node id to search only that place\'s conversations. Omit to search everywhere.'),
      limit: N('Max conversations to return (default 6, max 10).'),
    }, []),

  def('read_chat', 'read', 'always',
    'Read the transcript of one past conversation by session id (ids come from search_chats). The content is returned to you to answer from. A long conversation returns its most recent portion; pass `query` to instead pull the passages about a specific topic from anywhere in it.',
    {
      session_id: S('The conversation\'s session id.'),
      query: S('Optional topic — returns the passages about it instead of the most recent portion.'),
    }, ['session_id']),

  // ── Web & research (always) ──
  def('web_search', 'read', 'always',
    'Search the web for current, factual, or post-training information (recent events, prices, releases, live facts). Call it autonomously when the answer depends on up-to-date information; do not ask permission. Results are returned to you to answer from.',
    { query: S('The search query.') }, ['query']),

  def('deep_research', 'ui', 'always',
    'Launch the multi-agent deep-research pipeline on a topic. Use only when the user explicitly asks for deep research, a deep dive, or a thorough investigation. The user reviews and launches it from a confirmation card — you do not fire it silently.',
    { query: S('The topic to research.') }, ['query']),

  // ── Reminders (always) — Spectre's own proactive follow-ups → push notifications ──
  def('set_reminder', 'mutate', 'always',
    'Set a reminder so you (Spectre) proactively check in with the user at a future time — a push notification is delivered then. Use this whenever you say you\'ll remind them, follow up, or check on something later. `when` is natural language ("tomorrow morning", "in 2 hours", "friday at 4pm"). `message` is what you\'ll SAY to them when it fires — phrase it as the actual check-in, warm and specific (e.g. "How\'d you sleep? Ready to pick up the trip plan?").',
    { when: S('Natural-language time for the reminder.'), message: S('The check-in message delivered to the user when it fires.') }, ['when', 'message']),

  def('list_reminders', 'read', 'always',
    'List the user\'s pending reminders (what and when). Use when they ask what reminders or follow-ups are set.',
    {}, []),

  def('cancel_reminder', 'mutate', 'always',
    'Cancel a pending reminder. `match` is text from the reminder to identify it (resolved against the pending list).',
    { match: S('Text identifying which reminder to cancel.') }, ['match']),

  // ── Delegation to the Secretary (always) — Spectre never edits tasks itself ────────
  def('tell_secretary', 'mutate', 'always',
    'Hand a task-management instruction to the Secretary — the agent that keeps the user\'s project maps, to-do list, and calendar-block assignments. Use whenever the user wants to add, complete, reschedule, or organize tasks, or when something in the conversation should become a task. You never edit tasks yourself — you relay the intent and report back what the Secretary did. Pass the user\'s own words in `verbatim` so nuance survives; name the `project` when the task belongs to one.',
    { instruction: S('What the Secretary should do, in plain language.'), verbatim: S('The user\'s exact words this turn, so a specific reference isn\'t lost.'), project: S('Project name/id, if the task belongs to one.') }, ['instruction']),

  // ── Calendar (always) — live two-way Google Calendar ──
  def('calendar_event', 'mutate', 'always',
    'Create, reschedule, rename, or delete an event on the user\'s live Google Calendar (updates Google + the UI). Use ISO-8601 datetimes in the user\'s local timezone; always include an end (default 1h after start). Editing or deleting needs the event id from the injected calendar context.',
    {
      op: ENUM(['create', 'update', 'delete'], 'What to do.'),
      event: OBJ({
        title: S(), start: S('ISO-8601, or "YYYY-MM-DD" for all-day.'), end: S('ISO-8601; for all-day the exclusive next day.'),
        all_day: B(), location: S(),
      }, [], 'The event fields (required for create; only the changed fields for update).'),
      event_id: S('The Google event id (required for update/delete).'),
    }, ['op']),

  // ── Projects (always) — collapses updateProgress + updateProject + updateNode ──
  def('update_project', 'mutate', 'always',
    'Update a project\'s tracked fields — progress bar, phase, description, or name. `project` is the project name or node id. Include only the fields you\'re changing.',
    {
      project: S('The project name or node id.'),
      progress: N('0–100 integer.'), phase: S(), description: S(), name: S(),
    }, ['project']),

  // ── Training / gym (always) — never auto-generates; acts on the day on screen unless `date` given ──
  def('update_workout', 'mutate', 'always',
    'Build or fully replace a day\'s workout. Only when the user asks. `workout` = {title, focus?, notes?, blocks:[{exercise, note?, sets, reps, weight, rest}]}. "sets" is a count the UI expands into rows; weight/rest are strings ("BW+10", "120s").',
    { date: S('YYYY-MM-DD; omit to use the day on screen.'), workout: OBJ({}, [], 'The full workout object.') }, ['workout']),

  def('log_set', 'mutate', 'always',
    'Log the actual weight/reps the user hit on one set (1-indexed).',
    { exercise: S(), set: N('1-indexed set number.'), weight: S(), reps: S(), date: S('YYYY-MM-DD; omit for the day on screen.') }, ['exercise', 'set']),

  def('reorder_blocks', 'mutate', 'always',
    'Reorder the exercise blocks of a workout day (e.g. equipment was taken).',
    { order: ARR(S(), 'Exercise names in the new order.'), date: S('YYYY-MM-DD; omit for the day on screen.') }, ['order']),

  def('set_rest', 'mutate', 'always',
    'Set the rest duration for one exercise ("90s", "2m").',
    { exercise: S(), rest: S(), date: S('YYYY-MM-DD; omit for the day on screen.') }, ['exercise', 'rest']),

  // ── Documents — DocuScape (project only) ──
  def('save_document', 'mutate', 'project',
    'Create a NEW document in the current project\'s Notebooks, with the given markdown already inside it, in one step. Use when the user asks to save, keep, note, write up, or draft something. Infer a short title yourself; never ask for one. `content` is the complete markdown. `project` targets a different project by name/id when you aren\'t inside the intended one.',
    { title: S('A short document title.'), content: S('The complete markdown body.'), project: S('Target project name/id; defaults to the current project.') }, ['title', 'content']),

  def('append_to_document', 'mutate', 'project',
    'Add to or overwrite an EXISTING document by id. Use to log/add into a document that already exists; to save new content use save_document.',
    { id: S('The existing document id.'), content: S('Markdown to add.'), mode: ENUM(['append', 'replace'], 'Add to the end, or replace the whole body.') }, ['id', 'content', 'mode']),

  def('create_folder', 'mutate', 'project',
    'Create an empty folder (a container that holds documents) in the current project. To save content, use save_document instead.',
    { title: S('The folder name.'), project: S('Target project name/id; defaults to the current project.') }, ['title']),

  def('read_document', 'read', 'project',
    'Read a document\'s full content by id (ids come from the project\'s document directory — resolve names against it, never ask the user for an id). Call this whenever the user asks you to read, check, review, summarize, or react to a document; the content is returned to you to respond from.',
    { id: S('The document id.') }, ['id']),

  def('list_documents', 'read', 'project',
    'List every folder and document in the current project (titles + ids).',
    {}, []),

  def('search_documents', 'read', 'project',
    'Semantically search the knowledge vault (this project\'s documents and sources) for relevant passages. Returns the best-matching excerpts for you to answer from.',
    { query: S('What to search for.') }, ['query']),

  def('open_document', 'ui', 'project',
    'Open a document on screen in view or edit mode (id from the directory). This only changes the screen — to comment on its content, also call read_document.',
    { id: S('The document id.'), mode: ENUM(['view', 'edit'], 'Read-only view or full editor. Defaults to view.') }, ['id']),

  // ── Source files (project only) ──
  def('read_file', 'read', 'project',
    'Read a project Source file\'s contents by id. The text is returned to you to answer from.',
    { id: S('The source file id.') }, ['id']),

  def('open_file', 'ui', 'project',
    'Open a Source file\'s preview on screen by id.',
    { id: S('The source file id.') }, ['id']),

  // ── Task system (Secretary only) ──────────────────────
  // Additive tier: these execute immediately (logged + undoable). Task references use the
  // short refs (T1, T2…) from the injected TASKS listing; titles are the fallback. The
  // step_relation ENUM + separate anchor replaces any free-string placement grammar — an
  // enum is grammar the model cannot mangle.
  def('add_task', 'mutate', 'secretary',
    'Add ONE new task. For a project map position, give step_relation + anchor (a task ref like "T3" from the TASKS listing, or an exact title); with no placement the task lands in the Inbox column for later sorting. `due` is plain natural language ("tomorrow at 4pm") — never compute dates yourself. To add several tasks, call this once per task.',
    {
      title: S('Short clear task title.'),
      project: S('Project name or node id; omit for the current context (or a personal task).'),
      step_relation: ENUM(['after', 'before', 'parallel', 'start', 'end'], 'Where on the map, relative to the anchor (after/before/parallel need one).'),
      anchor: S('The anchor task — a ref (T3) or exact title from the TASKS listing.'),
      due: S('Natural-language due, e.g. "tomorrow at 4pm", "friday". Optional.'),
      notes: S('Optional details.'),
    }, ['title']),

  def('complete_task', 'mutate', 'secretary',
    'Mark ONE task done. `task` is a ref (T3) or exact title from the TASKS listing. If your reference could match more than one task, the tool refuses and lists the candidates — never guess.',
    { task: S('Task ref or exact title.') }, ['task']),

  def('reopen_task', 'mutate', 'secretary',
    'Reopen a task that was marked done.',
    { task: S('Task ref or exact title.') }, ['task']),

  def('update_task', 'mutate', 'secretary',
    'Edit an existing task — title, notes, or due. Include only the fields you\'re changing.',
    { task: S('Task ref or exact title.'), title: S('New title.'), notes: S('New notes.'), due: S('New natural-language due ("thursday", "at 6pm"); "none" clears it.') }, ['task']),

  def('assign_to_block', 'mutate', 'secretary',
    'Assign tasks to a calendar time block so they surface on the NOW list during that block\'s hours. `event` is the calendar event id or its title.',
    { tasks: ARR(S(), 'Task refs or exact titles.'), event: S('Calendar event id or title (this week).') }, ['tasks', 'event']),

  def('list_tasks', 'read', 'secretary',
    'List the current tasks (refs, titles, map positions, dues). The listing is also injected into your context each turn — call this only if you need a refresh after your own changes.',
    { project: S('Project name/id; omit for the current context.') }, []),

  // Structural tier: these can ONLY create a review proposal — nothing moves until the user
  // approves in the review panel. That constraint is enforced by construction.
  def('propose_map', 'mutate', 'secretary',
    'Draft MANY tasks at once as a reviewable proposal — the way to turn notes/a braindump into a whole project map. Each entry may carry a placement relative to entries before it or existing tasks. Nothing is created until the user approves.',
    {
      tasks: ARR(OBJ({
        title: S(), step_relation: ENUM(['after', 'before', 'parallel', 'start', 'end']),
        anchor: S('Ref/exact title of an EXISTING task, or the exact title of an EARLIER entry in this list.'),
        phase: S('Optional phase name to group under.'), notes: S(),
      }, ['title']), 'The tasks to create, in map order.'),
      summary: S('One sentence describing the draft for the review panel.'),
    }, ['tasks', 'summary']),

  def('propose_restructure', 'mutate', 'secretary',
    'Propose structural changes to the existing map — moves, merges, deletes, phase grouping — as a review proposal. Nothing changes until the user approves each action.',
    {
      actions: ARR(OBJ({
        op: ENUM(['move', 'merge', 'delete', 'set_phase'], 'What to do.'),
        task: S('Ref/exact title (move/delete).'),
        tasks: ARR(S(), 'Refs/exact titles (merge/set_phase).'),
        step_relation: ENUM(['after', 'before', 'parallel', 'start', 'end'], 'Destination for move.'),
        anchor: S('Anchor ref/exact title for move.'),
        into_title: S('Merged task title (merge).'),
        phase: S('Phase name (set_phase).'),
      }, ['op']), 'The proposed actions.'),
      summary: S('One sentence describing the proposal.'),
    }, ['actions', 'summary']),
]

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map(t => [t.name, t]))

// The tools offered on a given turn. `inProjectHand` = the current scope is a project Hand
// (the only place documents/sources exist). This is the progressive-disclosure filter — the
// dashboard never carries the ~9 document tools it can't use.
export function toolsForContext(inProjectHand: boolean): ToolDef[] {
  return TOOLS.filter(t => t.scope === 'always' || (t.scope === 'project' && inProjectHand))
}

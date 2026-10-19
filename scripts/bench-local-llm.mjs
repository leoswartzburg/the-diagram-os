// Latency bench for the LOCAL backend (llama-server :8013, gpt-oss:20b).
// Mirrors lib/spectreLocal.ts request shape: streaming, harmony reasoning
// effort, gpt-oss recommended sampling, optionally the LOCAL_TOOLS array and a
// realistic Spectre-sized system prompt. Reports TTFT (first visible content
// token), total wall time, and llama-server's own timings when present.
// Usage: node scripts/bench-local-llm.mjs

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://localhost:8013'

const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: true } },
})
const STR = { type: 'string' }
const NUM = { type: 'number' }
// Same 21 tools as LOCAL_TOOLS (names/shapes matter for prompt size, not semantics).
const TOOLS = [
  tool('updateProgress', 'Update a project progress bar (0-100).', { project: STR, value: NUM }, ['project', 'value']),
  tool('updateProject', 'Update a project phase/description/progress field.', { project: STR, field: STR, value: STR }, ['project', 'field', 'value']),
  tool('updateNode', 'Update a Diagram node (progress/phase/description/name).', { id: STR, progress: NUM, phase: STR, description: STR, name: STR }, ['id']),
  tool('calendarSync', 'Create/update/delete a Google Calendar event.', { op: STR, event: { type: 'object', additionalProperties: true }, eventId: STR }, ['op']),
  tool('updateWorkout', "Build or fully replace a day's workout.", { date: STR, workout: { type: 'object', additionalProperties: true } }, ['workout']),
  tool('logSet', 'Log actual weight/reps for one set (1-indexed).', { exercise: STR, set: NUM, weight: STR, reps: STR, date: STR }, ['exercise', 'set']),
  tool('reorderBlocks', 'Reorder the exercise blocks of a workout day.', { order: { type: 'array', items: STR }, date: STR }, ['order']),
  tool('setRest', 'Set rest duration for one exercise.', { exercise: STR, rest: STR, date: STR }, ['exercise', 'rest']),
  tool('updateStats', 'Update a body stat (sleep/readiness/hrv/recovery).', { field: STR, value: NUM }, ['field', 'value']),
  tool('deepResearch', 'Launch the deep-research pipeline on a topic.', { query: STR, plan: { type: 'object', additionalProperties: true } }, ['query']),
  tool('readFile', "Read a project Source file's contents.", { id: STR }, ['id']),
  tool('searchVault', 'Semantic search over the Metalmind knowledge vault.', { query: STR, node_id: STR, limit: NUM }, ['query']),
  tool('createNotebook', 'Create a Notebook (folder) or Document (notebook).', { title: STR, type: STR, parent_id: STR, content: STR }, ['title', 'type']),
  tool('readNotebook', "Read a notebook/document's full content.", { id: STR }, ['id']),
  tool('listNotebooks', 'List all notebooks in the current project.', {}),
  tool('writeToNotebook', "Append to or replace a notebook's content.", { id: STR, content: STR, mode: STR }, ['id', 'content', 'mode']),
  tool('navigateTo', 'Navigate the UI to an Arm or Hand of The Diagram.', { node_id: STR, node_name: STR }, ['node_id', 'node_name']),
  tool('openNotebook', 'Open a notebook in the UI (view or edit mode).', { id: STR, mode: STR }, ['id']),
  tool('openFile', 'Open a Source file preview in the UI.', { id: STR }, ['id']),
  tool('openSession', 'Open a chat session (recent/new/specific).', { mode: STR, session_id: STR, node_id: STR }, ['mode']),
  tool('searchSessions', 'Find a past conversation by topic/title.', { query: STR, node_id: STR, open_result: { type: 'boolean' } }, ['query']),
]

// ~Spectre-sized system prompt (the real one — identity + action protocol +
// spatial prefix + primer — lands around 3-5k tokens). Synthetic filler at a
// comparable scale so prompt-processing cost is represented.
const FILLER = Array.from({ length: 160 }, (_, i) =>
  `Context line ${i}: The Diagram tracks schedule, body metrics, projects, training, and knowledge; respond concisely and stay in character as Spectre.`,
).join('\n')
const BIG_SYSTEM = `You are Spectre, a personal AI operating system inside The Diagram. Be concise, capable, and direct.\n\n[CONTEXT]\n${FILLER}`

async function run(label, body) {
  const t0 = performance.now()
  let ttft = null
  let text = ''
  let reasoningChars = 0
  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
  })
  if (!res.ok) { console.log(`${label}: HTTP ${res.status}`); return }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let usage = null
  let timings = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const data = line.startsWith('data: ') ? line.slice(6).trim() : ''
      if (!data || data === '[DONE]') continue
      try {
        const obj = JSON.parse(data)
        if (obj.usage) usage = obj.usage
        if (obj.timings) timings = obj.timings
        const delta = obj.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length
        if (typeof delta.content === 'string' && delta.content) {
          if (ttft === null) ttft = performance.now() - t0
          text += delta.content
        }
      } catch { /* skip */ }
    }
  }
  const total = performance.now() - t0
  const fmt = (ms) => ms == null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`
  console.log(`\n── ${label}`)
  console.log(`   TTFT (first visible token): ${fmt(ttft)}   total: ${fmt(total)}`)
  if (timings) console.log(`   llama timings: prompt ${timings.prompt_n} tok @ ${timings.prompt_per_second?.toFixed(0)} tok/s · gen ${timings.predicted_n} tok @ ${timings.predicted_per_second?.toFixed(1)} tok/s`)
  if (usage) console.log(`   usage: prompt ${usage.prompt_tokens} · completion ${usage.completion_tokens}`)
  console.log(`   reasoning chars: ${reasoningChars} · reply: ${JSON.stringify(text.slice(0, 120))}`)
}

const base = { model: 'gpt-oss-20b', temperature: 1.0, top_p: 1.0 }
const effort = (e) => ({ reasoning_effort: e, chat_template_kwargs: { reasoning_effort: e } })
const greet = [{ role: 'user', content: 'Hey Spectre, good evening. How are you?' }]
const question = [{ role: 'user', content: 'Quick one — what is the derivative of x^2 * sin(x)?' }]

console.log(`Bench against ${LLAMA_URL}`)
// Warm-up (not reported) so the first measured run isn't paying cache/cold cost.
await run('warm-up (discard)', { ...base, ...effort('low'), messages: greet, max_tokens: 32 })

await run('A. minimal greeting · effort=low · no tools', { ...base, ...effort('low'), messages: greet })
await run('B. minimal greeting · effort=medium · no tools', { ...base, ...effort('medium'), messages: greet })
await run('C. realistic: big system + 21 tools · effort=medium · greeting', { ...base, ...effort('medium'), tools: TOOLS, messages: [{ role: 'system', content: BIG_SYSTEM }, ...greet] })
await run('D. realistic: big system + 21 tools · effort=medium · short question', { ...base, ...effort('medium'), tools: TOOLS, messages: [{ role: 'system', content: BIG_SYSTEM }, ...question] })
await run('E. realistic repeat (prompt cache warm) · greeting', { ...base, ...effort('medium'), tools: TOOLS, messages: [{ role: 'system', content: BIG_SYSTEM }, ...greet] })

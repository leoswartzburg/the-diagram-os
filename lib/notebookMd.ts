// Docu-scape converters: TipTap (ProseMirror) JSON ⇄ Markdown.
//
// Pure functions (no TipTap / framework imports) so they run on the client for export
// and live Spectre writes, and could run server-side too. Coverage targets the nodes
// the editor uses: paragraph, heading, bullet/ordered/task lists, blockquote, code
// block, horizontal rule, hard break, table; inline bold/italic/code/strike/highlight/
// underline/link. Anything unrecognised degrades to its text content.

export type TiptapMark = { type: string; attrs?: Record<string, unknown> }
export type TiptapNode = {
  type?: string
  content?: TiptapNode[]
  text?: string
  marks?: TiptapMark[]
  attrs?: Record<string, unknown>
}
export type TiptapDoc = { type: 'doc'; content: TiptapNode[] }

// ── Math delimiter normalization ─────────────────────────────────────────────────
// Spectre emits LaTeX in several delimiter styles — Claude tends to use $…$/$$…$$
// already, gpt-oss writes display math as bracketed blocks ([ \frac{3}{2}k_B T ]) and
// inline as \( … \). Normalize all of them to the $…$ / $$…$$ forms the markdown→TipTap
// parser (and the chat renderer's remark-math) understand. Runs ONLY on prose segments —
// fenced ``` blocks and inline `code` are left verbatim so a real bracket or dollar sign
// in code never becomes math. Bracket→display fires only when the body holds a backslash
// command and isn't a markdown link [text](url), so ordinary prose is untouched.
export function normalizeMath(src: string): string {
  return (src ?? '')
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => {
      if (i % 2 === 1) return seg // code span / fenced block — never transform
      return seg
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)      // \[ … \] → display
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`)        // \( … \) → inline
        .replace(/\[\s*([^[\]]*?\\[^[\]]*?)\s*\](?!\()/g, (_m, body) => `$$${body.trim()}$$`) // [ \… ] → display
    })
    .join('')
}

// ── TipTap JSON → Markdown ───────────────────────────────────────────────────────
function serializeInline(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return ''
  return nodes.map(n => {
    if (n.type === 'hardBreak') return '  \n'
    if (n.type === 'inlineMath') return `$${String(n.attrs?.latex ?? '')}$`
    let text = n.text ?? ''
    if (!text) return ''
    for (const m of n.marks ?? []) {
      switch (m.type) {
        case 'bold':      text = `**${text}**`; break
        case 'italic':    text = `*${text}*`; break
        case 'code':      text = `\`${text}\``; break
        case 'strike':    text = `~~${text}~~`; break
        case 'highlight': text = `==${text}==`; break
        case 'underline': text = `<u>${text}</u>`; break
        case 'link': {
          const href = (m.attrs?.href as string) ?? ''
          text = `[${text}](${href})`; break
        }
        default: break
      }
    }
    return text
  }).join('')
}

function serializeBlocks(nodes: TiptapNode[] | undefined, depth = 0): string {
  if (!nodes) return ''
  const out: string[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(serializeInline(n.content))
        break
      case 'heading': {
        const lvl = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)))
        out.push(`${'#'.repeat(lvl)} ${serializeInline(n.content)}`)
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = n.type === 'orderedList'
        const items = (n.content ?? []).map((li, i) => {
          const inner = serializeBlocks(li.content, depth + 1).split('\n').filter(Boolean)
          const marker = ordered ? `${i + 1}.` : '-'
          const pad = '  '.repeat(depth)
          return inner.map((line, j) => j === 0 ? `${pad}${marker} ${line}` : `${pad}  ${line}`).join('\n')
        })
        out.push(items.join('\n'))
        break
      }
      case 'taskList': {
        const items = (n.content ?? []).map(li => {
          const checked = li.attrs?.checked ? 'x' : ' '
          const inner = serializeBlocks(li.content, depth + 1).split('\n').filter(Boolean)
          const pad = '  '.repeat(depth)
          return inner.map((line, j) => j === 0 ? `${pad}- [${checked}] ${line}` : `${pad}  ${line}`).join('\n')
        })
        out.push(items.join('\n'))
        break
      }
      case 'blockquote':
        out.push(serializeBlocks(n.content, depth).split('\n').map(l => `> ${l}`).join('\n'))
        break
      case 'codeBlock': {
        const lang = (n.attrs?.language as string) ?? ''
        const code = (n.content ?? []).map(c => c.text ?? '').join('')
        out.push('```' + lang + '\n' + code + '\n```')
        break
      }
      case 'mathBlock':
        out.push(`$$\n${String(n.attrs?.latex ?? '').trim()}\n$$`)
        break
      case 'horizontalRule':
        out.push('---')
        break
      case 'image': {
        const src = (n.attrs?.src as string) ?? ''
        const alt = (n.attrs?.alt as string) ?? ''
        if (src) out.push(`![${alt}](${src})`)
        break
      }
      case 'table': {
        const rows = n.content ?? []
        const lines: string[] = []
        rows.forEach((row, ri) => {
          const cells = (row.content ?? []).map(cell => serializeBlocks(cell.content, 0).replace(/\n+/g, ' ').trim())
          lines.push('| ' + cells.join(' | ') + ' |')
          if (ri === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |')
        })
        out.push(lines.join('\n'))
        break
      }
      default:
        if (n.content) out.push(serializeBlocks(n.content, depth))
        else if (n.text) out.push(n.text)
        break
    }
  }
  return out.join('\n\n')
}

export function tiptapToMarkdown(doc: TiptapDoc | TiptapNode | null | undefined): string {
  if (!doc || !doc.content) return ''
  return serializeBlocks(doc.content).replace(/\n{3,}/g, '\n\n').trim()
}

// A short plain-text preview (first N chars, no markdown syntax) for library cards.
export function tiptapPreview(doc: TiptapDoc | TiptapNode | null | undefined, max = 120): string {
  if (!doc || !doc.content) return ''
  const walk = (nodes: TiptapNode[]): string =>
    nodes.map(n => n.text ?? (n.content ? walk(n.content) : '')).join(' ')
  return walk(doc.content).replace(/\s+/g, ' ').trim().slice(0, max)
}

// ── Markdown → TipTap JSON ─────────────────────────────────────────────────────────
// Inline tokenizer: **bold**, *italic*/_italic_, `code`, ~~strike~~, ==highlight==.
function parseInline(text: string): TiptapNode[] {
  const out: TiptapNode[] = []
  // Math alternatives ($$…$$ then $…$) come last; both are emitted as inlineMath nodes.
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(`([^`]+)`)|(~~([^~]+)~~)|(==([^=]+)==)|(\$\$([^$]+?)\$\$)|(\$([^$\n]+?)\$)|(\[([^\]]+)\]\(([^)]+)\))|(<u>([^<]+)<\/u>)/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string, mark?: string) => {
    if (!t) return
    out.push(mark ? { type: 'text', text: t, marks: [{ type: mark }] } : { type: 'text', text: t })
  }
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index))
    if (m[2] !== undefined) push(m[2], 'bold')
    else if (m[4] !== undefined) push(m[4], 'italic')
    else if (m[6] !== undefined) push(m[6], 'italic')
    else if (m[8] !== undefined) push(m[8], 'code')
    else if (m[10] !== undefined) push(m[10], 'strike')
    else if (m[12] !== undefined) push(m[12], 'highlight')
    else if (m[14] !== undefined) out.push({ type: 'inlineMath', attrs: { latex: m[14].trim() } })
    else if (m[16] !== undefined) out.push({ type: 'inlineMath', attrs: { latex: m[16].trim() } })
    else if (m[18] !== undefined) out.push({ type: 'text', text: m[18], marks: [{ type: 'link', attrs: { href: m[19] } }] })   // [text](url) → link mark
    else if (m[21] !== undefined) push(m[21], 'underline')                                                                     // <u>text</u> → underline mark
    last = re.lastIndex
  }
  if (last < text.length) push(text.slice(last))
  return out.length ? out : []
}

const para = (text: string): TiptapNode => ({ type: 'paragraph', content: parseInline(text) })

export function markdownToTiptap(md: string): TiptapDoc {
  const lines = normalizeMath((md ?? '').replace(/\r\n/g, '\n')).split('\n')
  const content: TiptapNode[] = []
  let i = 0
  const flushList = (ordered: boolean, task: boolean) => {
    const items: TiptapNode[] = []
    const bullet = /^\s*[-*+]\s+(.*)$/
    const task1 = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
    const order = /^\s*\d+\.\s+(.*)$/
    while (i < lines.length) {
      const ln = lines[i]
      if (task) {
        const t = ln.match(task1); if (!t) break
        items.push({ type: 'taskItem', attrs: { checked: t[1].toLowerCase() === 'x' }, content: [para(t[2])] }); i++
      } else if (ordered) {
        const o = ln.match(order); if (!o) break
        items.push({ type: 'listItem', content: [para(o[1])] }); i++
      } else {
        if (task1.test(ln)) break
        const b = ln.match(bullet); if (!b) break
        items.push({ type: 'listItem', content: [para(b[1])] }); i++
      }
    }
    content.push({ type: task ? 'taskList' : ordered ? 'orderedList' : 'bulletList', content: items })
  }

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      i++
      const code: string[] = []
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++ // closing fence
      content.push({ type: 'codeBlock', attrs: fence[1] ? { language: fence[1] } : {}, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] })
      continue
    }
    // Display math block: a line starting with $$ (closing on the same line or a later one).
    const dm = line.match(/^\s*\$\$(.*)$/)
    if (dm) {
      const sameClose = dm[1].match(/^(.*?)\$\$\s*$/)
      if (sameClose) {
        content.push({ type: 'mathBlock', attrs: { latex: sameClose[1].trim() } }); i++; continue
      }
      const buf = dm[1] ? [dm[1]] : []
      i++
      while (i < lines.length && !/\$\$/.test(lines[i])) { buf.push(lines[i]); i++ }
      if (i < lines.length) { const tail = lines[i].replace(/\$\$.*$/, ''); if (tail) buf.push(tail); i++ }
      content.push({ type: 'mathBlock', attrs: { latex: buf.join('\n').trim() } })
      continue
    }
    // Standalone image line: ![alt](src) → block image node (round-trips paste/drag images).
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/)
    if (img) { content.push({ type: 'image', attrs: { src: img[2], alt: img[1] } }); i++; continue }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { content.push({ type: 'heading', attrs: { level: h[1].length }, content: parseInline(h[2]) }); i++; continue }
    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { content.push({ type: 'horizontalRule' }); i++; continue }
    // Blockquote (collect consecutive)
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++ }
      content.push({ type: 'blockquote', content: [para(quote.join(' '))] })
      continue
    }
    // Task list
    if (/^\s*[-*+]\s+\[([ xX])\]\s+/.test(line)) { flushList(false, true); continue }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) { flushList(true, false); continue }
    // Bullet list
    if (/^\s*[-*+]\s+/.test(line)) { flushList(false, false); continue }
    // Paragraph (single line; blank line separates)
    content.push(para(line))
    i++
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

// ── Math migration for already-stored documents ─────────────────────────────────────
// Documents saved before math nodes existed hold their LaTeX as literal text ($$…$$, $…$,
// or gpt-oss brackets). On load we split that text into math nodes so old docs render too.
// Conservative + idempotent: structure and marks are preserved, code is never touched, and
// a doc that already contains math nodes passes through unchanged.
function splitTextMath(text: string, marks: TiptapMark[] | undefined): TiptapNode[] {
  // Never mathify inline code.
  if (marks?.some(m => m.type === 'code')) return [{ type: 'text', text, ...(marks ? { marks } : {}) }]
  const norm = normalizeMath(text)
  if (!norm.includes('$')) return [{ type: 'text', text, ...(marks ? { marks } : {}) }]
  const out: TiptapNode[] = []
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (t: string) => { if (t) out.push({ type: 'text', text: t, ...(marks ? { marks } : {}) }) }
  while ((m = re.exec(norm)) !== null) {
    if (m.index > last) pushText(norm.slice(last, m.index))
    out.push({ type: 'inlineMath', attrs: { latex: (m[1] ?? m[2] ?? '').trim() } })
    last = re.lastIndex
  }
  if (last < norm.length) pushText(norm.slice(last))
  return out.length ? out : [{ type: 'text', text, ...(marks ? { marks } : {}) }]
}

function migrateNodes(nodes: TiptapNode[]): TiptapNode[] {
  const out: TiptapNode[] = []
  for (const n of nodes) {
    // Code blocks: pass through untouched (no math inside).
    if (n.type === 'codeBlock') { out.push(n); continue }
    // A paragraph whose entire text is one display expression → promote to a math block.
    if (n.type === 'paragraph' && n.content?.length && n.content.every(c => !c.type || c.type === 'text')) {
      const norm = normalizeMath(n.content.map(c => c.text ?? '').join('')).trim()
      const disp = norm.match(/^\$\$([\s\S]+?)\$\$$/)
      if (disp && !disp[1].includes('$$')) { out.push({ type: 'mathBlock', attrs: { latex: disp[1].trim() } }); continue }
    }
    if (n.type === 'text' && n.text) out.push(...splitTextMath(n.text, n.marks))
    else if (n.content) out.push({ ...n, content: migrateNodes(n.content) })
    else out.push(n)
  }
  return out
}

export function migrateDocMath(doc: TiptapDoc | TiptapNode | null | undefined): TiptapDoc {
  if (!doc || !doc.content) return { type: 'doc', content: [{ type: 'paragraph' }] }
  const content = migrateNodes(doc.content)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

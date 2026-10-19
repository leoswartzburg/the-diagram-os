/**
 * Strips markdown syntax for clean voice/TTS output.
 * Pure string processing — no AI involvement.
 */
export function stripMarkdown(text: string): string {
  let s = text

  // Remove fenced code blocks entirely
  s = s.replace(/```[\s\S]*?```/g, '')

  // Tables → spoken prose (the "vertical line vertical line" bug): drop |---|---|
  // separator rows entirely, read each data row as its cells joined by commas, and
  // never let a stray pipe reach the voice.
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/gm, '')
  s = s.replace(/^\s*\|(.+)\|\s*$/gm, (_m, inner: string) =>
    inner.split('|').map(c => c.trim()).filter(Boolean).join(', ') + '. ')
  s = s.replace(/\|/g, ', ')

  // Replace dividers with a spoken pause
  s = s.replace(/^[-*_]{3,}\s*$/gm, '... ')

  // Convert consecutive unordered bullet lists → comma-separated prose
  s = s.replace(/(?:^[ \t]*[-*+]\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map(l => l.replace(/^[ \t]*[-*+]\s+/, '').trim())
      .filter(Boolean)
    return items.length === 1 ? items[0] + '. ' : items.join(', ') + '. '
  })

  // Convert consecutive ordered lists → comma-separated prose
  s = s.replace(/(?:^[ \t]*\d+\.\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map(l => l.replace(/^[ \t]*\d+\.\s+/, '').trim())
      .filter(Boolean)
    return items.length === 1 ? items[0] + '. ' : items.join(', ') + '. '
  })

  // Remove heading markers (keep the text)
  s = s.replace(/^#{1,6}\s+/gm, '')

  // Remove bold + italic combined ***text***
  s = s.replace(/\*{3}([\s\S]+?)\*{3}/g, '$1')
  // Remove bold **text**
  s = s.replace(/\*{2}([\s\S]+?)\*{2}/g, '$1')
  // Remove italic *text*
  s = s.replace(/\*([^*\n]+)\*/g, '$1')
  // Remove bold/italic with underscores
  s = s.replace(/_{3}([\s\S]+?)_{3}/g, '$1')
  s = s.replace(/_{2}([\s\S]+?)_{2}/g, '$1')
  s = s.replace(/_([^_\n]+)_/g, '$1')

  // Remove inline code backticks (keep text)
  s = s.replace(/`([^`]+)`/g, '$1')

  // Remove blockquote markers
  s = s.replace(/^[ \t]*>\s*/gm, '')

  // Remove links — keep label text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Remove images entirely
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, '')

  // Remove any leftover HTML tags
  s = s.replace(/<[^>]+>/g, '')

  // Collapse 3+ newlines to double
  s = s.replace(/\n{3,}/g, '\n\n')

  return s.trim()
}

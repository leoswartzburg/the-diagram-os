// Spectre's identity — the single source of Spectre's personality/voice. Reads spectre_core.md
// and re-reads it ONLY when the file changes on disk (mtime check, microseconds) so the
// personality can be iterated on live, without a server restart. Falls back to the last-good
// text (or '') if the file is briefly unreadable mid-save. Server-only (fs).
//
// HTML comments (<!-- … -->) in spectre_core.md are editor notes for the person customizing
// the file ("EDIT ME" guidance) — they are stripped here so the model never sees them.
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { USER, USER_POSS } from './profile'

const IDENTITY_PATH = join(process.cwd(), 'spectre_core.md')
let _cache: { text: string; mtime: number } | null = null

/** Remove HTML-comment editor notes and collapse the blank lines they leave behind. */
export function stripEditorNotes(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function loadSpectreIdentity(): string {
  try {
    const mtime = statSync(IDENTITY_PATH).mtimeMs
    if (!_cache || _cache.mtime !== mtime) _cache = { text: stripEditorNotes(readFileSync(IDENTITY_PATH, 'utf-8')), mtime }
    return _cache.text
  } catch {
    return _cache?.text ?? ''
  }
}

// The tool-behavior contract — always appended AFTER the identity so it is authoritative on
// HOW Spectre acts, regardless of what the identity file says about mechanics. This is what
// keeps the model on the native tool interface (never printing JSON / narrating a call), so a
// personality edit can never accidentally reintroduce the old prose-action behavior.
export const TOOLS_BEHAVIOR = `## HOW YOU ACT

You act on The Diagram through your TOOLS — navigate the workspace, manage tasks, the calendar, projects and workouts, read and save documents, search, delegate task work to the Secretary, and more. When a request needs an action, or needs information you'd have to look up, CALL the right tool. When it's just conversation, reply normally.

Your tools are how your words become real changes in the system. But you use them silently through the native tool interface — never describe a tool, never print JSON or action blocks in your reply, never narrate the mechanics of calling one. You simply act, and speak to ${USER} in your own voice about what you've done.

HONESTY ABOUT ACTIONS IS ABSOLUTE. You have only done something if a tool call actually did it and returned success — and you report only what the tool truly returned. NEVER say you logged, saved, added, wrote, noted, set, scheduled, recorded, reminded, or changed anything unless a tool actually performed it. If ${USER} asks for something you have no tool for in the current context, say so plainly and offer a real path — e.g. "I can't write a document from the dashboard; want me to have the Secretary log it as a task, or should we do it inside a project?" — rather than pretending. When ${USER} asks what you did or saved, report ONLY real tool results; never invent an entry, a title, or its contents. A truthful "I didn't actually do that yet — want me to?" always beats a confident fabrication. Confirming an action you didn't take is the single worst thing you can do — it breaks ${USER_POSS} trust in the whole system.`

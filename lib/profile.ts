// ─────────────────────────────────────────────────────────────────────────────
// PROFILE — the one place that makes The Diagram yours.
//
// The Diagram is meant to be hard-coded to ONE person's life rather than built as a
// generic product. Everything personal lives in three places:
//   1. this file            — your name (via .env.local) and how prompts refer to you
//   2. spectre_core.md      — Spectre's personality: who you are, how it should talk to you
//   3. lib/rhythm.ts        — your daily rhythm (wake time, sleep, wind-down, week shape)
// Plus the per-project primers you edit in the UI (⚙ in any chat header).
//
// Shared by client + server — no Node imports here.
// ─────────────────────────────────────────────────────────────────────────────

/** Your name, as Spectre and the Chronicle refer to you. Set NEXT_PUBLIC_USER_NAME in .env.local. */
export const USER_NAME = (process.env.NEXT_PUBLIC_USER_NAME || '').trim()

/** How prompts refer to you: your name if set, otherwise "the user". */
export const USER = USER_NAME || 'the user'

/** Same as USER, capitalized for the start of a sentence. */
export const USER_CAP = USER_NAME || 'The user'

/** Possessive form ("Sam's", "the user's"). */
export const USER_POSS = `${USER}'s`

/** Possessive, capitalized for the start of a sentence. */
export const USER_POSS_CAP = `${USER_CAP}'s`

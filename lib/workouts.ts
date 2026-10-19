// Server-only persistence + analytics for the gym arm.
//
// Two gitignored JSON files at the project root form the gym backend:
//   workouts.json  — the master workout file (source of truth, keyed by date)
//   exercises.json — the exercise library, DERIVED from logged sets (PRs + e1RM)
//
// The client owns the workout state and POSTs the full workouts map on every
// mutation; the server writes it and re-derives the exercise library so the two
// files never drift. e1RM uses the Epley formula: weight × (1 + reps / 30).

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

// ── Types (mirrored in app/page.tsx) ─────────────────────────────────────────
export type WorkoutSet = {
  plannedWeight: string
  plannedReps: string
  actualWeight: string
  actualReps: string
  done: boolean
}
export type WorkoutBlock = {
  id: string
  exercise: string
  note: string
  restSeconds: number
  sets: WorkoutSet[]
}
export type Workout = {
  date: string          // 'YYYY-MM-DD'
  title: string
  focus: string
  notes: string
  completed: boolean
  blocks: WorkoutBlock[]
}
export type WorkoutsMap = Record<string, Workout>

export type ExerciseSession = { date: string; topWeight: number; topReps: number; bestE1rm: number }
export type ExerciseRecord = {
  name: string
  maxWeight: number
  maxReps: number
  bestE1rm: number
  sessions: ExerciseSession[]   // chronological, one entry per day trained
}
export type ExercisesMap = Record<string, ExerciseRecord>

const WORKOUTS_PATH = join(process.cwd(), 'workouts.json')
const EXERCISES_PATH = join(process.cwd(), 'exercises.json')

// ── Helpers ──────────────────────────────────────────────────────────────────
// Leading-number parse: "100" → 100, "100kg" → 100, "BW+10" → NaN (bodyweight
// math isn't reliable here, so such sets are skipped for e1RM).
function num(s: string | undefined): number {
  if (!s) return NaN
  const n = parseFloat(String(s).trim())
  return Number.isFinite(n) ? n : NaN
}

// Epley estimated 1-rep max, rounded to one decimal.
export function epley(weight: number, reps: number): number {
  return Math.round(weight * (1 + reps / 30) * 10) / 10
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

// ── Library derivation ───────────────────────────────────────────────────────
// Walks every logged set across all workouts and builds per-exercise PRs + a
// per-day session history (for future e1RM-over-time charts).
export function deriveExercises(workouts: WorkoutsMap): ExercisesMap {
  // exercise key → date → running session stats
  const acc: Record<string, { name: string; byDate: Record<string, ExerciseSession> }> = {}

  const dates = Object.keys(workouts).sort()
  for (const date of dates) {
    const w = workouts[date]
    if (!w || !Array.isArray(w.blocks)) continue
    for (const block of w.blocks) {
      const name = (block.exercise ?? '').trim()
      if (!name) continue
      const key = name.toLowerCase()
      for (const set of block.sets ?? []) {
        const weight = num(set.actualWeight)
        const reps = num(set.actualReps)
        if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) continue
        const e = epley(weight, reps)
        const entry = (acc[key] ??= { name, byDate: {} })
        entry.name = name // keep latest display casing
        const sess = (entry.byDate[date] ??= { date, topWeight: 0, topReps: 0, bestE1rm: 0 })
        if (weight > sess.topWeight) sess.topWeight = weight
        if (reps > sess.topReps) sess.topReps = reps
        if (e > sess.bestE1rm) sess.bestE1rm = e
      }
    }
  }

  const out: ExercisesMap = {}
  for (const key of Object.keys(acc)) {
    const { name, byDate } = acc[key]
    const sessions = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
    out[key] = {
      name,
      maxWeight: sessions.reduce((m, s) => Math.max(m, s.topWeight), 0),
      maxReps: sessions.reduce((m, s) => Math.max(m, s.topReps), 0),
      bestE1rm: sessions.reduce((m, s) => Math.max(m, s.bestE1rm), 0),
      sessions,
    }
  }
  return out
}

// ── Public API ───────────────────────────────────────────────────────────────
export function readStore(): { workouts: WorkoutsMap; exercises: ExercisesMap } {
  const workouts = readJson<{ workouts?: WorkoutsMap }>(WORKOUTS_PATH, {}).workouts ?? {}
  const exercises = readJson<{ exercises?: ExercisesMap }>(EXERCISES_PATH, {}).exercises ?? {}
  return { workouts, exercises }
}

// Persist the workouts map, then re-derive + persist the exercise library so the
// two files stay consistent. Returns both for the client to adopt.
export function writeWorkouts(workouts: WorkoutsMap): { workouts: WorkoutsMap; exercises: ExercisesMap } {
  const exercises = deriveExercises(workouts)
  writeFileSync(WORKOUTS_PATH, JSON.stringify({ workouts }, null, 2), 'utf-8')
  writeFileSync(EXERCISES_PATH, JSON.stringify({ exercises }, null, 2), 'utf-8')
  return { workouts, exercises }
}

import { NextRequest, NextResponse } from 'next/server'
import { readStore, writeWorkouts, type WorkoutsMap } from '@/lib/workouts'

export const dynamic = 'force-dynamic'

// GET /api/workouts — the full gym backend: the master workout file plus the
// derived exercise library (PRs + e1RM). Returns empty maps (200) on day one
// when the files don't exist yet, so the UI shows clean empty states.
export async function GET() {
  try {
    const { workouts, exercises } = readStore()
    return NextResponse.json({ workouts, exercises })
  } catch (err) {
    console.error('[Workouts] read failed:', err)
    return NextResponse.json({ workouts: {}, exercises: {}, error: 'read_failed' }, { status: 502 })
  }
}

// POST /api/workouts — single write entry point. Body: { workouts: WorkoutsMap }.
// Persists the master file, re-derives the exercise library, and returns both so
// the client adopts the freshly computed PRs without duplicating Epley logic.
export async function POST(req: NextRequest) {
  let body: { workouts?: WorkoutsMap }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  if (!body.workouts || typeof body.workouts !== 'object') {
    return NextResponse.json({ error: 'missing_workouts' }, { status: 400 })
  }
  try {
    const { workouts, exercises } = writeWorkouts(body.workouts)
    return NextResponse.json({ workouts, exercises })
  } catch (err) {
    console.error('[Workouts] write failed:', err)
    return NextResponse.json({ error: 'write_failed' }, { status: 502 })
  }
}

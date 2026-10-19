// Google Calendar integration — server-only.
//
// Single-user. OAuth via google-auth-library; the refresh token is
// persisted to a gitignored .gcal-token.json at the project root and the
// access token is refreshed silently. Calendar reads/writes go through the
// Calendar v3 REST API using the OAuth2 client's auto-refreshing request().
//
// Two layers consume this: the lean 7-day window injected into Spectre's
// context + the What's Next widget, and the full browsable month calendar in
// the schedule folder. Both share the same listEvents()/create/update/delete.

import { OAuth2Client, type Credentials } from 'google-auth-library'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'

const TOKEN_PATH = join(process.cwd(), '.gcal-token.json')
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
]

// Google's 11 named event colors → background hex (the colorId palette).
const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986CB',  // Lavender
  '2': '#33B679',  // Sage
  '3': '#8E24AA',  // Grape
  '4': '#E67C73',  // Flamingo
  '5': '#F6BF26',  // Banana
  '6': '#F4511E',  // Tangerine
  '7': '#039BE5',  // Peacock
  '8': '#616161',  // Graphite
  '9': '#3F51B5',  // Blueberry
  '10': '#0B8043', // Basil
  '11': '#D50000', // Tomato
}

// Shared event shape — mirrored by the CalendarEvent type in app/page.tsx.
export type CalendarEvent = {
  id: string
  title: string
  start: string   // ISO datetime (timed) or 'YYYY-MM-DD' (all-day)
  end: string
  allDay: boolean
  color?: string
  location?: string
  description?: string
  // Series id when this is an instance of a recurring event (singleEvents=true expands
  // series into per-instance ids). Blocks link at the series level so ONE manual link
  // covers every "Work 10–5" instance forever.
  recurringEventId?: string
}

// Partial event used for create/update (no id required on create).
export type EventInput = {
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  location?: string
}

// ── Token persistence ───────────────────────────────────────────────────────

function readToken(): Credentials | null {
  if (!existsSync(TOKEN_PATH)) return null
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as Credentials
  } catch {
    return null
  }
}

function writeToken(tokens: Credentials): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8')
}

export function isConnected(): boolean {
  return !!readToken()?.refresh_token
}

export function disconnect(): void {
  if (existsSync(TOKEN_PATH)) rmSync(TOKEN_PATH)
}

// ── OAuth client ────────────────────────────────────────────────────────────

function makeClient(redirectUri?: string): OAuth2Client {
  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  )
  // Persist silently-refreshed tokens. The 'tokens' event may omit the
  // refresh_token on a plain access-token refresh — merge so we never lose it.
  client.on('tokens', (incoming) => {
    const existing = readToken() ?? {}
    writeToken({ ...existing, ...incoming })
  })
  return client
}

export function getAuthUrl(redirectUri: string): string {
  return makeClient(redirectUri).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // force a refresh_token every time
    scope: SCOPES,
  })
}

export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const client = makeClient(redirectUri)
  const { tokens } = await client.getToken(code)
  const existing = readToken() ?? {}
  writeToken({ ...existing, ...tokens })  // keep prior refresh_token if Google omits it
}

// Authenticated client for API calls. Throws if not connected.
function authedClient(): OAuth2Client {
  const tokens = readToken()
  if (!tokens?.refresh_token) throw new Error('NOT_CONNECTED')
  const client = makeClient()
  client.setCredentials(tokens)
  return client
}

// ── Event mapping ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapEvent(g: any): CalendarEvent {
  const allDay = !!g.start?.date
  return {
    id: g.id,
    title: g.summary ?? '(no title)',
    start: g.start?.dateTime ?? g.start?.date ?? '',
    end: g.end?.dateTime ?? g.end?.date ?? '',
    allDay,
    color: g.colorId ? GOOGLE_EVENT_COLORS[g.colorId] : undefined,
    location: g.location ?? undefined,
    description: g.description ?? undefined,
    recurringEventId: g.recurringEventId ?? undefined,
  }
}

function toGoogleBody(e: EventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (e.title !== undefined) body.summary = e.title
  if (e.location !== undefined) body.location = e.location
  if (e.start !== undefined) body.start = e.allDay ? { date: e.start } : { dateTime: e.start }
  if (e.end !== undefined) body.end = e.allDay ? { date: e.end } : { dateTime: e.end }
  return body
}

// ── Calendar operations ─────────────────────────────────────────────────────

export async function listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
  const client = authedClient()
  const base =
    `${CAL_BASE}?singleEvents=true&orderBy=startTime&maxResults=250` +
    `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
  // Follow pagination — a busy ~6-week month window expands recurring events past 250
  // instances; without this the tail is silently dropped. Cap pages as a sane backstop.
  const items: unknown[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.request<any>({ url })
    items.push(...((res.data?.items ?? []) as unknown[]))
    pageToken = res.data?.nextPageToken
    if (!pageToken) break
  }
  return items.map(mapEvent)
}

export async function createEvent(event: EventInput): Promise<CalendarEvent> {
  const client = authedClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await client.request<any>({ url: CAL_BASE, method: 'POST', data: toGoogleBody(event) })
  return mapEvent(res.data)
}

export async function updateEvent(id: string, event: EventInput): Promise<CalendarEvent> {
  const client = authedClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await client.request<any>({
    url: `${CAL_BASE}/${encodeURIComponent(id)}`,
    method: 'PATCH',
    data: toGoogleBody(event),
  })
  return mapEvent(res.data)
}

export async function deleteEvent(id: string): Promise<void> {
  const client = authedClient()
  await client.request({ url: `${CAL_BASE}/${encodeURIComponent(id)}`, method: 'DELETE' })
}

// Oura Ring V2 integration — server-only.
//
// Single-user. Mirrors the Google Calendar pattern (direct OAuth2, no
// NextAuth, gitignored token file, silent refresh) but hand-rolled with fetch
// because google-auth-library is hardwired to Google's endpoints.
//
// Consumers: the body arm's four stats + premium dashboard, and Spectre's
// context (today's scores + 7-day trends). A server cache (.oura-cache.json) is
// refreshed by webhooks ~30s after a ring sync and by the client's morning poll
// (GET /api/oura/sync, 7–11am). The client reads the cache via GET /api/oura/data.
//
// Real Oura v2 field sourcing (daily_sleep / daily_readiness only carry a `score`
// + `contributors`; HRV, heart rate and stage durations live in the `sleep`
// periods endpoint): Sleep score ← daily_sleep.score · Readiness score +
// contributors + temperature_deviation ← daily_readiness · HRV / resting HR /
// total / REM / deep durations ← the main `sleep` period for that day.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { createHmac, randomUUID } from 'crypto'

const TOKEN_PATH   = join(process.cwd(), '.oura-token.json')
const CACHE_PATH   = join(process.cwd(), '.oura-cache.json')
const WEBHOOK_PATH = join(process.cwd(), '.oura-webhooks.json')

const AUTH_URL  = 'https://cloud.ouraring.com/oauth/authorize'
const TOKEN_URL = 'https://api.ouraring.com/oauth/token'
const API_BASE  = 'https://api.ouraring.com/v2/usercollection'
const WEBHOOK_API = 'https://api.ouraring.com/v2/webhook/subscription'
const SCOPES = 'personal daily'

const WEBHOOK_DATA_TYPES = ['daily_sleep', 'daily_readiness', 'sleep'] as const
const WEBHOOK_EVENT_TYPES = ['create', 'update'] as const

// ── Shared snapshot types (mirrored in app/page.tsx) ─────────────────────────
// One calendar day of real Oura metrics. Durations are stored in seconds (raw
// from the API); the client converts to hours/minutes for display. Any field is
// null when that day's data is missing — never 0 (0 = a data error, e.g. 0ms HRV).
export type OuraDay = {
  date: string
  sleep_score: number | null            // daily_sleep.score (0-100)
  readiness_score: number | null        // daily_readiness.score (0-100)
  average_hrv: number | null            // sleep.average_hrv — RMSSD, ms
  average_heart_rate: number | null     // sleep.average_heart_rate — bpm
  total_sleep_duration: number | null   // sleep.total_sleep_duration — seconds
  rem_sleep_duration: number | null     // sleep.rem_sleep_duration — seconds
  deep_sleep_duration: number | null    // sleep.deep_sleep_duration — seconds
  temperature_deviation: number | null  // daily_readiness.temperature_deviation — °C
  contributors: Record<string, number | null> | null  // daily_readiness.contributors
  bedtime_start: string | null          // sleep.bedtime_start — ISO; feeds the asleep-by habit auto-check
}
export type OuraSnapshot = {
  date: string            // the most-recent day represented (newest entry in `days`)
  fromYesterday: boolean  // most-recent day is yesterday (today not yet published)
  lastSynced: string | null
  days: OuraDay[]         // exactly 7, oldest→newest, calendar-aligned (nullable per day)
}

// ── Token persistence + OAuth ────────────────────────────────────────────────
type OuraToken = { access_token: string; refresh_token: string; expires_at: number }

function readToken(): OuraToken | null {
  if (!existsSync(TOKEN_PATH)) return null
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as OuraToken } catch { return null }
}
function writeToken(t: OuraToken): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), 'utf-8')
}
export function isConnected(): boolean {
  return !!readToken()?.refresh_token
}
export function disconnect(): void {
  for (const p of [TOKEN_PATH, CACHE_PATH]) if (existsSync(p)) rmSync(p)
}

function basicAuth(): string {
  const id = process.env.OURA_CLIENT_ID ?? ''
  const secret = process.env.OURA_CLIENT_SECRET ?? ''
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

export function getAuthUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.OURA_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  })
  return `${AUTH_URL}?${q.toString()}`
}

export async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  })
  if (!res.ok) throw new Error(`Oura token exchange failed: ${res.status} ${await res.text()}`)
  const t = await res.json()
  writeToken({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  })
}

async function refresh(token: OuraToken): Promise<OuraToken> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  })
  // AUTH_EXPIRED → the refresh token is no longer valid; the user must reconnect.
  if (!res.ok) throw new Error(`AUTH_EXPIRED: Oura token refresh failed: ${res.status} ${await res.text()}`)
  const t = await res.json()
  const next: OuraToken = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || token.refresh_token,  // rotation may omit it
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  }
  writeToken(next)
  return next
}

// Single-flight refresh: buildSnapshot fires 3 ouraGet calls in parallel, each of which can
// trip the "near expiry" path at the same instant. Oura ROTATES the refresh_token on use, so
// parallel refreshes each POST the same old token — the first rotates it and the rest get 401
// → a false AUTH_EXPIRED (spurious Reconnect) + a late writeToken clobbering the good rotated
// token. Share ONE in-flight refresh across all concurrent callers.
let refreshing: Promise<OuraToken> | null = null
function refreshShared(token: OuraToken): Promise<OuraToken> {
  if (!refreshing) refreshing = refresh(token).finally(() => { refreshing = null })
  return refreshing
}

async function accessToken(): Promise<string> {
  let token = readToken()
  if (!token?.refresh_token) throw new Error('NOT_CONNECTED')
  if (Date.now() > token.expires_at - 60_000) token = await refreshShared(token)
  return token.access_token
}

// ── API fetch ────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ouraGet(path: string, params: Record<string, string>): Promise<any[]> {
  const q = new URLSearchParams(params).toString()
  const doFetch = async (tok: string) =>
    fetch(`${API_BASE}/${path}?${q}`, { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store' })

  let tok = await accessToken()
  let res = await doFetch(tok)
  if (res.status === 401) {            // token rejected — force one (shared) refresh + retry
    const t = readToken()
    if (t) { tok = (await refreshShared(t)).access_token; res = await doFetch(tok) }
  }
  if (!res.ok) throw new Error(`Oura ${path} failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return Array.isArray(data?.data) ? data.data : []
}

// ── Date helpers ─────────────────────────────────────────────────────────────
// Dates are 'YYYY-MM-DD' in the SERVER's local timezone (the host machine is expected
// to run in the user's own timezone). CRITICAL: never use `new Date(str)`
// for arithmetic — it parses 'YYYY-MM-DD' as UTC midnight, which then reads back
// one calendar day EARLIER via local getters in any UTC-minus zone (this was the
// "today shows yesterday" bug — the 7-day window was built that way). shiftYmd()
// does the math at UTC noon so the date can never slip across the tz offset.
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function todayYmd(): string {
  return ymd(new Date())
}
function shiftYmd(ymdStr: string, n: number): string {
  const [y, m, d] = ymdStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12))
  dt.setUTCDate(dt.getUTCDate() + n)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

// Pick the main overnight sleep period for a given day (longest / long_sleep).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mainSleep(periods: any[]): any | null {
  if (!periods.length) return null
  const longs = periods.filter(p => p.type === 'long_sleep')
  const pool = longs.length ? longs : periods
  return pool.reduce((a, b) => ((b.total_sleep_duration ?? 0) > (a.total_sleep_duration ?? 0) ? b : a))
}

// Coerce to a finite number, else null. (Used to keep 0/NaN/undefined out of the snapshot.)
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ── Snapshot ─────────────────────────────────────────────────────────────────
// Pulls the last 7 days from daily_sleep + daily_readiness + the `sleep` periods
// endpoint and assembles one calendar-aligned, nullable record per day.
export async function buildSnapshot(): Promise<OuraSnapshot> {
  const today = todayYmd()
  const start = shiftYmd(today, -8)
  const end = shiftYmd(today, 1)   // +1 day buffer: today is always in range despite any tz offset
  const [dailySleep, dailyReadiness, sleep] = await Promise.all([
    ouraGet('daily_sleep', { start_date: start, end_date: end }),
    ouraGet('daily_readiness', { start_date: start, end_date: end }),
    ouraGet('sleep', { start_date: start, end_date: end }),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byDay = (arr: any[]) => { const m = new Map<string, any>(); for (const r of arr) m.set(r.day, r); return m }
  const sleepMap = byDay(dailySleep)
  const readyMap = byDay(dailyReadiness)
  // sleep periods can be multiple per day — group then pick the main one
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sleepPeriods = new Map<string, any[]>()
  for (const s of sleep) { const a = sleepPeriods.get(s.day) ?? []; a.push(s); sleepPeriods.set(s.day, a) }

  // Show the most-recent available day at or before today. Oura dates sleep by the
  // WAKE date, and today's row only appears after the morning ring sync — so the
  // freshest real data may be today or yesterday. (Anything past `today`, e.g. the
  // +1 buffer day, is excluded.)
  const available = [...new Set<string>([...sleepMap.keys(), ...readyMap.keys()])]
    .filter(d => d <= today)
    .sort()
  const date = available.length ? available[available.length - 1] : shiftYmd(today, -1)
  const fromYesterday = date !== today
  console.log(`[Oura] sync — requested ${start} → ${end} (today ${today}); showing ${date}${fromYesterday ? ' (today\'s row not published yet)' : ''}`)

  const buildDay = (d: string): OuraDay => {
    const ds = sleepMap.get(d)
    const dr = readyMap.get(d)
    const sp = mainSleep(sleepPeriods.get(d) ?? [])
    const hrv = num(sp?.average_hrv)
    const hr  = num(sp?.average_heart_rate)
    return {
      date: d,
      sleep_score:           num(ds?.score),
      readiness_score:       num(dr?.score),
      average_hrv:           hrv != null && hrv > 0 ? Math.round(hrv) : null,  // 0ms HRV = data error → null
      average_heart_rate:    hr  != null && hr  > 0 ? Math.round(hr)  : null,
      total_sleep_duration:  num(sp?.total_sleep_duration),
      rem_sleep_duration:    num(sp?.rem_sleep_duration),
      deep_sleep_duration:   num(sp?.deep_sleep_duration),
      temperature_deviation: num(dr?.temperature_deviation),
      contributors:          dr?.contributors ?? null,
      bedtime_start:         typeof sp?.bedtime_start === 'string' ? sp.bedtime_start : null,
    }
  }

  // 7 calendar days ending at `date`, oldest→newest (alignment preserved; missing
  // days are null). Uses shiftYmd — NOT new Date(date) — to avoid the UTC-parse slip.
  const days: OuraDay[] = []
  for (let i = 6; i >= 0; i--) days.push(buildDay(shiftYmd(date, -i)))

  const snapshot: OuraSnapshot = { date, fromYesterday, lastSynced: new Date().toISOString(), days }
  try { writeFileSync(CACHE_PATH, JSON.stringify(snapshot, null, 2), 'utf-8') } catch { /* cache best-effort */ }
  return snapshot
}

export function getCachedSnapshot(): OuraSnapshot | null {
  if (!existsSync(CACHE_PATH)) return null
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as OuraSnapshot } catch { return null }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
type WebhookState = { verificationToken: string; subscriptions: string[] }

function readWebhookState(): WebhookState {
  if (existsSync(WEBHOOK_PATH)) {
    try {
      return JSON.parse(readFileSync(WEBHOOK_PATH, 'utf-8')) as WebhookState
    } catch (e) {
      // File exists but is corrupt — do NOT mint a fresh verification token here (that would
      // rotate the live token and break Oura's webhook handshake). Fail loudly instead.
      console.error('[Oura] .oura-webhooks.json is corrupt — refusing to rotate the verification token:', (e as Error).message)
      throw new Error('OURA_WEBHOOK_STATE_CORRUPT')
    }
  }
  // Genuinely absent (first run) → mint a new token.
  return { verificationToken: randomUUID(), subscriptions: [] }
}
function writeWebhookState(s: WebhookState): void {
  writeFileSync(WEBHOOK_PATH, JSON.stringify(s, null, 2), 'utf-8')
}
export function getVerificationToken(): string {
  const s = readWebhookState(); writeWebhookState(s); return s.verificationToken
}

function webhookHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-client-id': process.env.OURA_CLIENT_ID ?? '',
    'x-client-secret': process.env.OURA_CLIENT_SECRET ?? '',
  }
}

// Register the four data types (create+update) if not already present. Oura GETs
// the callback to verify during creation, so the webhook route must be live.
export async function ensureSubscriptions(callbackUrl: string): Promise<void> {
  const state = readWebhookState()
  writeWebhookState(state)  // persist the verification token before Oura verifies

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let existing: any[] = []
  try {
    const res = await fetch(WEBHOOK_API, { headers: webhookHeaders() })
    if (res.ok) existing = await res.json()
  } catch { /* listing failed — attempt creation anyway */ }

  const have = new Set(existing.map(s => `${s.data_type}:${s.event_type}`))
  const created: string[] = []
  for (const data_type of WEBHOOK_DATA_TYPES) {
    for (const event_type of WEBHOOK_EVENT_TYPES) {
      if (have.has(`${data_type}:${event_type}`)) continue
      try {
        const res = await fetch(WEBHOOK_API, {
          method: 'POST',
          headers: webhookHeaders(),
          body: JSON.stringify({
            callback_url: callbackUrl,
            verification_token: state.verificationToken,
            event_type,
            data_type,
          }),
        })
        if (res.ok) { const sub = await res.json(); if (sub?.id) created.push(sub.id) }
        else console.warn(`[Oura] subscribe ${data_type}:${event_type} → ${res.status} ${await res.text()}`)
      } catch (err) {
        console.warn(`[Oura] subscribe ${data_type}:${event_type} error:`, err)
      }
    }
  }
  state.subscriptions = [...state.subscriptions, ...created]
  writeWebhookState(state)
}

// Best-effort HMAC-SHA256 verification of a raw webhook body. Oura does not
// reliably sign event payloads, so this only runs when a signature is present.
export function verifyHmac(rawBody: string, signature: string | null): boolean {
  if (!signature) return true  // no signature header — accept (we re-fetch from the authed API anyway)
  const secret = process.env.OURA_CLIENT_SECRET ?? ''
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex')
  const provided = signature.replace(/^sha256=/i, '').trim()
  return digest === provided
}

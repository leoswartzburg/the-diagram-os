import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// TTS providers, local-first with graceful degradation:
//   LOCAL chain — Chatterbox (:8004, voice cloned from a reference clip, primary local engine)
//                 → Cartesia (cloud, last resort so voice never goes silent)
//   CLOUD       — Cartesia directly (a 402/429 here triggers the client-side
//                 failover that flips the TTS toggle to LOCAL).
const CHATTERBOX_URL = process.env.CHATTERBOX_URL || 'http://localhost:8004'
// Chatterbox resolves the OpenAI `voice` field by exact filename (incl. extension),
// looking under voices/ then reference_audio/. Drop your own reference clip there and set
// CHATTERBOX_VOICE to its filename in .env.local.
const CHATTERBOX_VOICE = process.env.CHATTERBOX_VOICE || 'default.wav'
// Cartesia voice — any voice id from the Cartesia library (or your own clone). Override with
// CARTESIA_VOICE_ID in .env.local (the same default is used by /api/tts/stream).
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const text: string = body?.text
  // Per-request override from the UI toggle, falling back to the server default.
  const provider: string = (body?.provider || process.env.TTS_PROVIDER || 'local').toLowerCase()

  if (!text?.trim()) {
    return NextResponse.json({ error: 'No text provided' }, { status: 400 })
  }

  if (provider === 'cartesia' || provider === 'cloud') {
    return ttsCartesia(text, !!body?.simulate402)
  }

  // LOCAL chain (also taken for the legacy 'chatterbox' provider value).
  const chatterbox = await ttsChatterbox(text)
  if (chatterbox) return chatterbox
  console.warn('[TTS] Chatterbox unavailable — degrading to Cartesia (cloud)')
  return ttsCartesia(text)
}

// ── Chatterbox (local voice clone — primary local voice) ─────────────────────
// Returns null on ANY failure so the chain can degrade; never throws.
async function ttsChatterbox(text: string): Promise<NextResponse | null> {
  try {
    const res = await fetch(`${CHATTERBOX_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'chatterbox',
        input: text.slice(0, 2000),
        voice: CHATTERBOX_VOICE,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      console.error('[TTS] Chatterbox error:', res.status, await res.text().catch(() => ''))
      return null
    }
    return new NextResponse(res.body, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' },
    })
  } catch (err) {
    console.error('[TTS] Chatterbox unreachable:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Cartesia (cloud, paid) — original implementation, kept fully intact ─────
async function ttsCartesia(text: string, simulate402 = false) {
  // Test hook: force a credit-exhaustion (402) to exercise the voice failover.
  // Enabled by env (TTS_SIMULATE_402=1) for a live browser test, or by a request
  // body flag in dev only (never in a production build).
  if (process.env.TTS_SIMULATE_402 === '1' || (process.env.NODE_ENV !== 'production' && simulate402)) {
    return NextResponse.json({ error: 'Simulated Cartesia credit exhaustion' }, { status: 402 })
  }

  const apiKey = process.env.CARTESIA_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'CARTESIA_API_KEY not set' }, { status: 500 })
  }

  const cartesiaRes = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3-latest',
      transcript: (text as string).slice(0, 2000),
      voice: {
        mode: 'id',
        id: CARTESIA_VOICE_ID,
      },
      output_format: {
        container: 'mp3',
        encoding: 'mp3',
        sample_rate: 44100,
      },
    }),
  })

  if (!cartesiaRes.ok) {
    const errBody = await cartesiaRes.text()
    console.error('[TTS] Cartesia error:', cartesiaRes.status, errBody)
    return NextResponse.json({ error: errBody }, { status: cartesiaRes.status })
  }

  return new NextResponse(cartesiaRes.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
    },
  })
}

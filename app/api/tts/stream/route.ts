import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Streaming TTS — proxies Cartesia's SSE endpoint and re-streams the decoded RAW PCM as a chunked
// response, so a capable client (Web Audio) can begin playback at FIRST-FRAME latency (~100ms p90)
// instead of waiting for a whole sentence to synthesize and transcode (the /tts/bytes path forfeits
// ~300-600ms). Server-side only so CARTESIA_API_KEY never reaches the browser.
//
// Cartesia's streaming endpoints (SSE + WebSocket) emit RAW PCM only — there is no MP3 over the
// stream — so the contract is fixed pcm_s16le @ 44.1kHz mono, surfaced to the client via headers.
// On ANY failure the client transparently falls back to the buffered /api/tts path, so streaming
// can never make voice worse than it is today.
const SAMPLE_RATE = 44100
// Same voice as /api/tts — override with CARTESIA_VOICE_ID in .env.local.
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091'
const ENCODING = 'pcm_s16le'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const text: string = body?.text
  if (!text?.trim()) return NextResponse.json({ error: 'No text provided' }, { status: 400 })

  const apiKey = process.env.CARTESIA_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'CARTESIA_API_KEY not set' }, { status: 500 })

  let upstream: Response
  try {
    upstream = await fetch('https://api.cartesia.ai/tts/sse', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // sonic-3 is the low-latency Sonic tier (~100ms p90 first audio). Same voice id as /tts/bytes.
        model_id: 'sonic-3',
        transcript: (text as string).slice(0, 2000),
        voice: { mode: 'id', id: CARTESIA_VOICE_ID },
        // Streaming = raw container only (no header/codec wait). Match the rate end-to-end.
        output_format: { container: 'raw', encoding: ENCODING, sample_rate: SAMPLE_RATE },
      }),
    })
  } catch (err) {
    console.error('[TTS stream] Cartesia unreachable:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Cartesia unreachable' }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    const errBody = await upstream.text().catch(() => '')
    console.error('[TTS stream] Cartesia error:', upstream.status, errBody.slice(0, 300))
    return NextResponse.json({ error: errBody || 'Cartesia error' }, { status: upstream.status || 502 })
  }

  // Re-stream: parse the SSE, base64-decode each {type:'chunk'} event's audio, emit raw PCM bytes.
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          // SSE events are separated by blank lines; each carries one or more `data:` lines.
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.startsWith('data:') ? line.slice(5).trim() : ''
            if (!trimmed) continue
            try {
              const obj = JSON.parse(trimmed)
              if (obj.type === 'chunk' && typeof obj.data === 'string') {
                controller.enqueue(new Uint8Array(Buffer.from(obj.data, 'base64')))
              } else if (obj.type === 'error') {
                console.error('[TTS stream] Cartesia stream error event:', obj.error ?? obj)
              }
              // obj.type === 'done' → upstream will close; nothing to emit.
            } catch { /* non-JSON keepalive / partial — skip */ }
          }
        }
      } catch (err) {
        console.error('[TTS stream] proxy read failed:', err instanceof Error ? err.message : String(err))
      }
      controller.close()
    },
  })

  return new NextResponse(out, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'X-Sample-Rate': String(SAMPLE_RATE),
      'X-Encoding': ENCODING,
    },
  })
}

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Speech-to-text, local-first with cloud fallback:
//   1. Local Faster-Whisper container (:8005, large-v3-turbo float16 on GPU) —
//      OpenAI-compatible endpoint, zero cost, no audio leaves the machine.
//   2. Groq cloud (whisper-large-v3-turbo) — automatic fallback when the local
//      container is down/unhealthy, preserving the original behavior exactly.
// The client records mic audio with MediaRecorder and POSTs it as multipart
// form-data under the field "file". Both backends accept the same shape.
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:8005'

async function transcribeLocal(file: Blob): Promise<string | null> {
  const form = new FormData()
  form.append('file', file, 'audio.webm')
  form.append('language', 'en')
  try {
    const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      // Generous ceiling — local turbo transcribes a 10s utterance in well under
      // a second once warm; the timeout only catches a wedged container.
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.warn('[STT] local whisper non-OK:', res.status, '— falling back to Groq')
      return null
    }
    const data = await res.json()
    return String(data.text ?? '').trim()
  } catch (err) {
    console.warn('[STT] local whisper unreachable — falling back to Groq:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function transcribeGroq(file: Blob): Promise<NextResponse> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Local whisper offline and GROQ_API_KEY not set' }, { status: 502 })
  }
  const groqForm = new FormData()
  // Groq infers format from the filename extension — webm/opus from MediaRecorder.
  groqForm.append('file', file, 'audio.webm')
  groqForm.append('model', 'whisper-large-v3-turbo')
  groqForm.append('response_format', 'json')
  groqForm.append('language', 'en')

  const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: groqForm,
  }).catch(() => null)

  if (!groqRes) {
    return NextResponse.json({ error: 'Groq request failed' }, { status: 502 })
  }
  if (!groqRes.ok) {
    const errBody = await groqRes.text()
    console.error('[STT] Groq error:', groqRes.status, errBody)
    return NextResponse.json({ error: errBody }, { status: groqRes.status })
  }
  const data = await groqRes.json()
  return NextResponse.json({ text: String(data.text ?? '').trim() })
}

export async function POST(req: NextRequest) {
  let incoming: FormData
  try {
    incoming = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = incoming.get('file')
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: 'No audio provided' }, { status: 400 })
  }

  const localText = await transcribeLocal(file)
  if (localText !== null) {
    return NextResponse.json({ text: localText })
  }
  return transcribeGroq(file)
}

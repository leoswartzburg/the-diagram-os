import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { updateSession } from '@/lib/conversations'

export const dynamic = 'force-dynamic'

const anthropic = new Anthropic()

// POST /api/chat/sessions/[id]/retitle { userMessage, assistantResponse }
// Calls Haiku once after the first exchange to generate a specific 3-6 word
// title from actual conversation content. Returns { title } on success.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { userMessage, assistantResponse } = await req.json()
    if (!userMessage) return NextResponse.json({ error: 'userMessage required' }, { status: 400 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 24,
      system: 'Generate a short 3-6 word title for this conversation. Be specific and descriptive. Return ONLY the title, nothing else. No quotes, no punctuation at the end.',
      messages: [{
        role: 'user',
        content: `First message: ${String(userMessage).slice(0, 400)}\nFirst response: ${String(assistantResponse ?? '').slice(0, 200)}\n\nTitle:`,
      }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
    if (!title) return NextResponse.json({ error: 'no title generated' }, { status: 500 })

    const session = updateSession(id, { title })
    if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })

    return NextResponse.json({ title })
  } catch (e) {
    console.error('[retitle] failed:', e)
    return NextResponse.json({ error: 'retitle failed' }, { status: 500 })
  }
}

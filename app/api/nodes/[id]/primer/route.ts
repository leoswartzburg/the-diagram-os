import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getNode, updateNode } from '@/lib/conversations'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const anthropic = new Anthropic()

// POST /api/nodes/[id]/primer — generate a personalized 2-3 sentence default
// Spectre primer for a freshly created Arm/Hand (Haiku, mirrors the chat-retitle
// pattern) and store it in the node's primer field. Returns { primer, node }.
//
// The node already carries the template-default primer at creation time, so this
// is an UPGRADE — never the difference between empty and non-empty. The user can
// still edit the primer afterward via the existing primer editor.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const node = getNode(id)
    if (!node) return NextResponse.json({ error: 'node not found' }, { status: 404 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      system:
        'You write a short instructional context primer for an AI assistant named Spectre that operates inside a named workspace of a personal operating system called The Diagram. Given the workspace name, its template type, and its level (an "arm" is a top-level space; a "hand" is a sub-space inside an arm), write 2-3 sentences telling Spectre what this space is for and how it should behave when operating here. Be concrete and grounded in the workspace name. Address Spectre in the second person. Return ONLY the primer text — no preamble, no quotes, no markdown, no trailing notes.',
      messages: [{
        role: 'user',
        content: `Workspace name: ${node.name}\nTemplate type: ${node.template}\nLevel: ${node.level}\n\nPrimer:`,
      }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const primer = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
    if (!primer) return NextResponse.json({ error: 'no primer generated' }, { status: 500 })

    const updated = updateNode(id, { primer })   // also busts the diagram-tree cache
    return NextResponse.json({ primer, node: updated })
  } catch (e) {
    console.error('[nodes/primer] failed:', e)
    return NextResponse.json({ error: 'primer generation failed' }, { status: 500 })
  }
}

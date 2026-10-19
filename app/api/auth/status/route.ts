import { NextResponse } from 'next/server'
import { isConnected, disconnect } from '@/lib/gcal'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ connected: isConnected() })
}

// Disconnect — removes the local token file.
export async function DELETE() {
  disconnect()
  return NextResponse.json({ connected: false })
}

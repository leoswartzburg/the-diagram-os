// Authorization + input validation for the /api/system/* routes, which execute
// host shell commands (ollama / docker) to orchestrate the voice TTS failover.
//
// Gate: allow only requests originating from localhost OR the Tailscale network
// (CGNAT range 100.64.0.0/10, plus Tailscale's IPv6 ULA fd7a:115c:a1e0::/48).
// The Tailscale proxy sets X-Forwarded-For to the real client IP, so a request
// arriving over the public Funnel from a non-tailnet client presents a public
// source IP and is rejected. Direct localhost requests carry no forwarding
// headers and are allowed.

import type { NextRequest } from 'next/server'

function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '')
  return v === '127.0.0.1' || v.startsWith('127.') || v === '::1' || v === '0:0:0:0:0:0:0:1'
}

// Tailscale assigns IPv4 from 100.64.0.0/10 (100.64.0.0 – 100.127.255.255) and
// IPv6 from fd7a:115c:a1e0::/48.
function isTailscale(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '').toLowerCase()
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]); const b = Number(m[2])
    return a === 100 && b >= 64 && b <= 127
  }
  return v.startsWith('fd7a:115c:a1e0')
}

function clientIps(req: NextRequest): string[] {
  const ips: string[] = []
  const xff = req.headers.get('x-forwarded-for')
  if (xff) ips.push(...xff.split(',').map(s => s.trim()).filter(Boolean))
  const xrip = req.headers.get('x-real-ip')
  if (xrip) ips.push(xrip.trim())
  return ips
}

export function isAuthorizedSystemRequest(req: NextRequest): boolean {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase()
  const hostLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  const fwd = req.headers.get('x-forwarded-for') || req.headers.get('x-forwarded-host')

  // Direct localhost request (no proxy in front) — trusted.
  if (!fwd && hostLocal) return true

  // Proxied request — require a loopback or Tailscale client IP.
  const ips = clientIps(req)
  if (ips.length === 0) return hostLocal
  return ips.some(ip => isLoopback(ip) || isTailscale(ip))
}

// Guards model/container arguments against shell injection (defence in depth on
// top of the network gate). Allows the chars used by ollama tags + docker names.
export function validToken(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s)
}

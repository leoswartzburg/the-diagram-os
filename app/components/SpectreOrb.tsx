'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SpectreOrb — the V4 "living lattice" orb. Nested fluid point-shells + a morphing
// outer line-web + a bright eyeball core, with a slow Earth-like pitch wobble and an
// in-plane galaxy spin. Reacts to state (idle/listening/thinking/speaking) by shifting
// the blue's shade + motion. Canvas-rendered; detail scales with size so it works from
// the 28px mini-orb up to the full dashboard hero. Drop-in replacement for OrbRings
// (accepts the same props; cfg/mode accepted for compatibility but unused).
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect } from 'react'

type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface OrbProps {
  size: number
  renderSize?: number
  active?: boolean
  listening?: boolean
  voiceMode?: boolean
  voicePhase?: string
  mode?: string
  cfg?: unknown
}

function deriveState(p: OrbProps): OrbState {
  if (p.voiceMode && p.voicePhase) {
    const vp = p.voicePhase
    if (vp === 'listening') return 'listening'
    if (vp === 'speaking') return 'speaking'
    if (vp === 'thinking' || vp === 'transcribing' || vp === 'reconfiguring') return 'thinking'
    return 'idle'
  }
  if (p.listening) return 'listening'
  if (p.active) return 'thinking'
  return 'idle'
}

export function SpectreOrb(props: OrbProps) {
  const { size, renderSize } = props
  // Render the canvas at a fixed high resolution (geo) and let CSS scale the DISPLAY size.
  // This keeps the orb crisp when it grows in voice mode (no rasterized-then-stretched blur).
  const geo = renderSize ?? size
  const ref = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<OrbState>('idle')
  stateRef.current = deriveState(props)

  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    const W = geo, H = geo, dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr)
    const R = geo * 0.42, cx = W / 2, cy = H / 2, ga = Math.PI * (3 - Math.sqrt(5))
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
    const inner = [
      { N: clamp(Math.round(geo * 0.7), 12, 120), rad: 0.46, sp: 0.0027, ax: 0.5, ay: 0, sz: 1.5, a: 0.85, pts: [] as number[][] },
      { N: clamp(Math.round(geo * 1.3), 24, 215), rad: 0.72, sp: -0.0043, ax: 0.34, ay: 1, sz: 1.25, a: 0.58, pts: [] as number[][] },
    ]
    inner.forEach(d => { for (let i = 0; i < d.N; i++) { const y = 1 - (i / (d.N - 1)) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = i * ga; d.pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random() * 6.28]) } })
    const M = clamp(Math.round(geo * 0.9), 18, 150)
    const outer: { lat: number; lon: number; ph: number; sd: number; sl: number }[] = []
    for (let i = 0; i < M; i++) { const y = 1 - (i / (M - 1)) * 2; outer.push({ lat: Math.asin(Math.max(-1, Math.min(1, y))), lon: i * ga, ph: i * 0.7, sd: Math.random() * 2 - 1, sl: Math.random() * 2 - 1 }) }
    let oay = 0, gz = 0, fc = 0, edges: number[][] = []
    const rot = (p: number[], ax: number, ay: number, az: number): number[] => {
      const c = Math.cos(ay), s = Math.sin(ay); const x = p[0] * c - p[2] * s, z = p[0] * s + p[2] * c, y = p[1]
      const cX = Math.cos(ax), sX = Math.sin(ax); const y2 = y * cX - z * sX, z2 = y * sX + z * cX
      const cZ = Math.cos(az), sZ = Math.sin(az); return [x * cZ - y2 * sZ, x * sZ + y2 * cZ, z2]
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const T: Record<string, any> = {
      idle:      { oayInc: 0.006, gzInc: 0.0018, pitch: 0.30, churn: 0.07, dLat: 0.18, dLon: 0.22, snap: 8,  coreS: 1.00, coreP: 0.05, coreF: 1.6, swirl: 0.0,  th2: 0.16, spinMul: 1.0, radMul: 1.00, pulse: 0.00, line: [125, 208, 255], point: [155, 227, 255], glow: [14, 165, 233] },
      listening: { oayInc: 0.004, gzInc: 0.0012, pitch: 0.22, churn: 0.05, dLat: 0.10, dLon: 0.12, snap: 10, coreS: 1.30, coreP: 0.07, coreF: 1.3, swirl: 0.0,  th2: 0.18, spinMul: 0.8, radMul: 0.96, pulse: 0.00, line: [135, 226, 255], point: [192, 242, 255], glow: [56, 189, 248] },
      thinking:  { oayInc: 0.005, gzInc: 0.0016, pitch: 0.18, churn: 0.04, dLat: 0.07, dLon: 0.09, snap: 6,  coreS: 0.95, coreP: 0.07, coreF: 2.0, swirl: 0.0,  th2: 0.22, spinMul: 2.6, radMul: 0.88, pulse: 0.00, line: [115, 195, 255], point: [150, 215, 255], glow: [22, 135, 255] },
      speaking:  { oayInc: 0.011, gzInc: 0.0026, pitch: 0.28, churn: 0.14, dLat: 0.24, dLon: 0.28, snap: 3,  coreS: 1.12, coreP: 0.30, coreF: 6.0, swirl: 0.95, th2: 0.10, spinMul: 1.4, radMul: 1.04, pulse: 0.05, line: [110, 200, 255], point: [175, 228, 255], glow: [28, 150, 255] },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur: any = JSON.parse(JSON.stringify(T.idle))
    const lp = (a: number, b: number) => a + (b - a) * 0.06
    const lp3 = (a: number[], b: number[]) => [lp(a[0], b[0]), lp(a[1], b[1]), lp(a[2], b[2])]
    const t0 = performance.now(); let raf = 0
    const frame = () => {
      const tt = (performance.now() - t0) / 1000
      const tg = T[stateRef.current] || T.idle
      ;['oayInc', 'gzInc', 'pitch', 'churn', 'dLat', 'dLon', 'snap', 'coreS', 'coreP', 'coreF', 'swirl', 'th2', 'spinMul', 'radMul', 'pulse'].forEach(k => { cur[k] = lp(cur[k], tg[k]) })
      cur.line = lp3(cur.line, tg.line); cur.point = lp3(cur.point, tg.point); cur.glow = lp3(cur.glow, tg.glow)
      const gl = cur.glow.map((v: number) => Math.round(v)), pc = cur.point.map((v: number) => Math.round(v)), lc = cur.line.map((v: number) => Math.round(v))
      const Reff = R * cur.radMul * (1 + cur.pulse * Math.sin(tt * 6))
      ctx.clearRect(0, 0, W, H)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Reff * 1.05)
      g.addColorStop(0, 'rgba(' + pc[0] + ',' + pc[1] + ',' + pc[2] + ',0.30)')
      g.addColorStop(0.45, 'rgba(' + gl[0] + ',' + gl[1] + ',' + gl[2] + ',0.12)')
      g.addColorStop(1, 'rgba(' + gl[0] + ',' + gl[1] + ',' + gl[2] + ',0)')
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, Reff * 1.05, 0, 7); ctx.fill()
      oay += cur.oayInc; gz += cur.gzInc; const gp = cur.pitch * Math.sin(tt * 0.14)
      const loc: number[][] = []
      for (let i = 0; i < M; i++) { const o = outer[i]; const lat = o.lat + cur.dLat * Math.sin(tt * 0.45 + o.ph) + cur.swirl * o.sl * 0.25 * Math.sin(tt * 0.8 + o.ph * 2.3); const lon = o.lon + cur.dLon * Math.sin(tt * 0.38 + o.ph * 1.7) + cur.swirl * o.sd * tt * 0.55; const rr = 1 + cur.churn * Math.sin(tt * 1.2 + o.ph * 2); const cl = Math.cos(lat); loc.push([cl * Math.cos(lon) * rr, Math.sin(lat) * rr, cl * Math.sin(lon) * rr]) }
      const snapI = Math.max(3, Math.round(cur.snap)), TH2 = cur.th2
      if (fc % snapI === 0) { edges = []; for (let a = 0; a < M; a++) for (let b = a + 1; b < M; b++) { const dx = loc[a][0] - loc[b][0], dy = loc[a][1] - loc[b][1], dz = loc[a][2] - loc[b][2]; if (dx * dx + dy * dy + dz * dz < TH2) edges.push([a, b]) } }
      fc++
      const ro = loc.map(p => rot(p, 0.58 + gp, oay, gz))
      ctx.globalCompositeOperation = 'lighter'
      for (let e = 0; e < edges.length; e++) { const A = ro[edges[e][0]], B = ro[edges[e][1]]; const zz = ((A[2] + B[2]) / 2 + 1) / 2; ctx.strokeStyle = 'rgba(' + lc[0] + ',' + lc[1] + ',' + lc[2] + ',' + (0.04 + zz * 0.24) + ')'; ctx.lineWidth = 0.5 + zz * 0.6; ctx.beginPath(); ctx.moveTo(cx + A[0] * Reff, cy - A[1] * Reff); ctx.lineTo(cx + B[0] * Reff, cy - B[1] * Reff); ctx.stroke() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = []
      inner.forEach(d => { d.ay += d.sp * cur.spinMul; for (let i = 0; i < d.N; i++) { const bp = d.pts[i]; const rr = d.rad * (1 + cur.churn * 0.7 * Math.sin(tt * 1.0 + bp[3])); const q = rot([bp[0] * rr, bp[1] * rr, bp[2] * rr], d.ax + gp, d.ay, gz); all.push([q[0], q[1], q[2], d.a, d.sz]) } })
      for (let i = 0; i < M; i++) all.push([ro[i][0], ro[i][1], ro[i][2], 0.72, 1.5])
      all.sort((a, b) => a[2] - b[2])
      for (let j = 0; j < all.length; j++) { const p = all[j], zz = (p[2] + 1) / 2; ctx.fillStyle = 'rgba(' + pc[0] + ',' + pc[1] + ',' + pc[2] + ',' + (p[3] * (0.2 + zz * 0.8)) + ')'; ctx.beginPath(); ctx.arc(cx + p[0] * Reff, cy - p[1] * Reff, p[4] * (0.5 + zz) * (geo < 70 ? 0.8 : 1), 0, 7); ctx.fill() }
      const er = Reff * 0.22 * cur.coreS * (1 + cur.coreP * Math.sin(tt * cur.coreF))
      const ng = ctx.createRadialGradient(cx, cy, 0, cx, cy, er)
      ng.addColorStop(0, 'rgba(255,255,255,1)'); ng.addColorStop(0.38, 'rgba(225,245,255,0.95)'); ng.addColorStop(0.7, 'rgba(' + gl[0] + ',' + gl[1] + ',' + gl[2] + ',0.55)'); ng.addColorStop(1, 'rgba(' + gl[0] + ',' + gl[1] + ',' + gl[2] + ',0)')
      ctx.fillStyle = ng; ctx.beginPath(); ctx.arc(cx, cy, er, 0, 7); ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(frame)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [geo])

  return <canvas ref={ref} style={{ display: 'block', width: size, height: size, transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1), height 0.6s cubic-bezier(0.4,0,0.2,1)' }} />
}

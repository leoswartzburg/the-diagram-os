// Playwright full-content fetch service for the deep-research pipeline.
//
// Tavily handles search + URL discovery; this service fetches the FULL readable text of each
// URL with a real headless browser (handles JS-rendered pages, hydration, dynamic content a raw
// fetch can't). Used by Deep + Exhaustive research modes — Quick stays on Tavily snippets.
//
// POST /fetch { urls: string[], maxChars?, followLinks?, maxLinks?, concurrency? }
//   → { results: [{ url, ok, status, title, text, links:[{url,text}] }] }
// GET /health → { ok: true }
//
// One shared browser; per-URL isolated contexts; images/media/fonts blocked for speed (text only).
// Everything is best-effort: a page that fails returns { ok:false, text:'' } so the caller degrades.

import http from 'node:http'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT || 8009)
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 20000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 4)
const DEFAULT_MAX_CHARS = Number(process.env.MAX_CHARS || 24000)

let browserPromise = null
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
      .catch(e => { browserPromise = null; throw e })
  }
  return browserPromise
}

async function fetchOne(url, { maxChars, followLinks, maxLinks }) {
  let context, page
  try {
    const browser = await getBrowser()
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    })
    page = await context.newPage()
    // Only text matters — drop heavy resources so pages settle fast.
    await page.route('**/*', route => {
      const t = route.request().resourceType()
      if (t === 'image' || t === 'media' || t === 'font') return route.abort()
      return route.continue()
    })
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    // Best-effort hydration window — capped so a chatty page can't hang the worker.
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {})
    const data = await page.evaluate(opts => {
      const body = document.body ? document.body.cloneNode(true) : null
      if (!body) return { title: document.title || '', text: '', links: [] }
      body.querySelectorAll('script,style,noscript,svg,header,footer,nav,aside,iframe,form,button,[aria-hidden="true"]')
        .forEach(el => el.remove())
      const main = body.querySelector('main') || body.querySelector('article') || body
      const text = (main.innerText || '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const links = []
      if (opts.followLinks) {
        const seen = new Set()
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href
          if (!href || !/^https?:/i.test(href) || seen.has(href)) continue
          seen.add(href)
          links.push({ url: href, text: (a.innerText || '').trim().slice(0, 120) })
          if (links.length >= opts.maxLinks) break
        }
      }
      return { title: document.title || '', text, links }
    }, { followLinks: !!followLinks, maxLinks: maxLinks || 40 })
    const text = (data.text || '').slice(0, maxChars)
    return { url, ok: text.length > 80, status: resp ? resp.status() : 0, title: data.title || '', text, links: data.links || [] }
  } catch (e) {
    return { url, ok: false, status: 0, title: '', text: '', links: [], error: String((e && e.message) || e).slice(0, 200) }
  } finally {
    try { await page?.close() } catch { /* ignore */ }
    try { await context?.close() } catch { /* ignore */ }
  }
}

// Bounded-concurrency map preserving input order.
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === 'POST' && req.url === '/fetch') {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy() })
    req.on('end', async () => {
      let payload
      try { payload = JSON.parse(body || '{}') } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return }
      const urls = Array.isArray(payload.urls) ? payload.urls.filter(u => typeof u === 'string').slice(0, 50) : []
      const maxChars = Math.min(60000, Number(payload.maxChars) || DEFAULT_MAX_CHARS)
      const followLinks = !!payload.followLinks
      const maxLinks = Math.min(80, Number(payload.maxLinks) || 40)
      const conc = Math.min(8, Math.max(1, Number(payload.concurrency) || CONCURRENCY))
      if (!urls.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results: [] })); return }
      try {
        const results = await pool(urls, conc, u => fetchOne(u, { maxChars, followLinks, maxLinks }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String((e && e.message) || e), results: [] }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, () => console.log(`[playwright] full-content fetch service listening on :${PORT}`))

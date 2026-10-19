// Next.js server-startup hook (runs once when the server process boots). We use it to
// bring the Metalmind vault online: ensure the Obsidian structure + Qdrant collection
// exist, then background-index any notebooks/files not yet vectorized. Everything is
// non-blocking and self-catching — a cold Qdrant/Ollama never blocks or breaks startup.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { initVault } = await import('./lib/vault')
      void initVault()
    } catch (e) {
      console.warn('[instrumentation] vault init skipped:', (e as Error).message)
    }
    // Scribe's autonomous heartbeat: regenerate today's chapter at the morning/afternoon/night
    // checkpoints (and finalize yesterday on day-rollover), even with no browser open.
    try {
      const { startScribeScheduler } = await import('./lib/scribeSchedule')
      startScribeScheduler()
    } catch (e) {
      console.warn('[instrumentation] scribe scheduler skipped:', (e as Error).message)
    }
    // Notification heartbeat: due reminders, block-end nudges, morning digest → your phone
    // via Web Push. No-ops until VAPID is configured + a device is subscribed.
    try {
      const { startNotifyScheduler } = await import('./lib/notifySchedule')
      startNotifyScheduler()
    } catch (e) {
      console.warn('[instrumentation] notify scheduler skipped:', (e as Error).message)
    }
  }
}

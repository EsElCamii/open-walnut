/**
 * Event-loop lag monitor — makes event-loop starvation VISIBLE.
 *
 * Walnut has repeatedly hit bugs where a synchronous burst (unbounded debug
 * logging, ~293 serial SQLite writes per health-monitor tick, a JSON-store
 * read-modify-write) blocks the libuv event loop for seconds, so EVERY HTTP
 * request — even a 2 KB one — stalls behind it and times out at 15 s. Those
 * bugs were invisible: the slow request's own handler logged a fast duration
 * because the time was spent *queued*, not *running*.
 *
 * This monitor closes that gap. It uses two independent signals:
 *
 *  1. perf_hooks.monitorEventLoopDelay — a zero-overhead libuv histogram of
 *     loop delay (max/p99/mean). Sampled every WINDOW_MS; if the window max
 *     crosses STALL_THRESHOLD_MS we log a `warn` with the percentiles. This
 *     tells us a stall happened and how bad, with no hot-path cost.
 *
 *  2. A self-scheduled timer that measures how late it actually fired. When a
 *     single tick is late by > STALL_THRESHOLD_MS we log the lateness plus the
 *     name of the periodic task most likely responsible (set via
 *     markCriticalSection), so the culprit is named, not guessed.
 *
 * Cheap enough to run in production permanently. Off only in tests.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { log } from '../logging/index.js'

/** Loop delay above this (ms) in a window is reported as a stall. */
const STALL_THRESHOLD_MS = 250
/** How often we sample the libuv histogram + reset it. */
const WINDOW_MS = 5_000
/** Self-timer cadence; lateness beyond threshold = the loop was blocked. */
const PROBE_INTERVAL_MS = 1_000

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let windowTimer: ReturnType<typeof setInterval> | null = null
let probeTimer: ReturnType<typeof setTimeout> | null = null
let lastProbeAt = 0

/**
 * The name of the synchronous section currently executing, if any. Periodic
 * tasks that are known event-loop hazards (health monitor, reconciler, git
 * sync) wrap themselves with markCriticalSection() so that when the probe
 * detects a stall we can attribute it instead of guessing.
 */
let currentSection: string | null = null
let sectionStartedAt = 0

/**
 * Mark a synchronous/awaited section so a concurrent stall can be attributed
 * to it. Returns a function to call when the section ends (use try/finally).
 *
 *   const end = markCriticalSection('health-monitor.check')
 *   try { ...heavy work... } finally { end() }
 */
export function markCriticalSection(name: string): () => void {
  // Nested sections: keep the outermost label (the one that owns the burst).
  if (currentSection) return () => { /* inner — outer owns attribution */ }
  currentSection = name
  sectionStartedAt = Date.now()
  return () => { currentSection = null; sectionStartedAt = 0 }
}

export function startEventLoopMonitor(): void {
  if (histogram) return // already running

  histogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()
  lastProbeAt = Date.now()

  // Signal 1: windowed histogram — reports the worst delay seen per window.
  windowTimer = setInterval(() => {
    if (!histogram) return
    const maxMs = histogram.max / 1e6 // ns → ms
    if (maxMs >= STALL_THRESHOLD_MS) {
      log.web.warn('event-loop stall detected (histogram)', {
        windowMs: WINDOW_MS,
        maxMs: Math.round(maxMs),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        meanMs: Math.round(histogram.mean / 1e6),
        // If a marked section is mid-flight it's the prime suspect.
        suspectSection: currentSection,
        sectionAgeMs: currentSection ? Date.now() - sectionStartedAt : undefined,
      })
    }
    histogram.reset()
  }, WINDOW_MS)
  if (typeof windowTimer === 'object' && 'unref' in windowTimer) windowTimer.unref()

  // Signal 2: self-timer lateness — pinpoints WHEN a tick was blocked and by
  // what (the section in flight at that instant).
  const probe = (): void => {
    const now = Date.now()
    const lateBy = now - lastProbeAt - PROBE_INTERVAL_MS
    lastProbeAt = now
    if (lateBy >= STALL_THRESHOLD_MS) {
      log.web.warn('event-loop blocked (probe late)', {
        lateByMs: lateBy,
        suspectSection: currentSection,
        sectionAgeMs: currentSection ? now - sectionStartedAt : undefined,
      })
    }
    probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
    if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()
  }
  probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
  if (probeTimer && typeof probeTimer === 'object' && 'unref' in probeTimer) probeTimer.unref()

  log.web.info('event-loop monitor started', { stallThresholdMs: STALL_THRESHOLD_MS, windowMs: WINDOW_MS })
}

export function stopEventLoopMonitor(): void {
  if (windowTimer) { clearInterval(windowTimer); windowTimer = null }
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null }
  if (histogram) { histogram.disable(); histogram = null }
  currentSection = null
}

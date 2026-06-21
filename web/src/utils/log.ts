/**
 * Structured frontend logger for cross-boundary traceability.
 *
 * Usage:
 *   import { log } from '@/utils/log'
 *   log.info('ws', 'RPC → session:send', { sessionId, rpcId })
 *
 * All levels go through console.log/warn/error which are captured by
 * the browser-logger monkey-patch and forwarded to the server log.
 * IDs are NEVER truncated — grep a full sessionId to trace across
 * browser + server logs.
 *
 * Level gate: `debug` is suppressed by default. Per-WS-event logging on a large
 * streaming session floods both the browser console and (via the browser-logger
 * forwarder) the server log file, which contributed to event-loop starvation.
 * Re-enable in DevTools with `localStorage.walnutLogLevel = 'debug'` (then
 * reload), or append `?logLevel=debug` to the URL.
 */

type LogData = Record<string, unknown>;

function resolveDebugEnabled(): boolean {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('logLevel');
    const level = (fromUrl ?? window.localStorage.getItem('walnutLogLevel') ?? 'info').toLowerCase();
    return level === 'debug' || level === 'trace';
  } catch {
    return false; // SSR / no window / blocked storage — default to suppressed
  }
}

// Resolved once at module load; the level is not expected to change mid-session.
const debugEnabled = resolveDebugEnabled();

function fmt(subsystem: string, message: string, data?: LogData): [string, ...unknown[]] {
  const tag = `[${subsystem}] ${message}`;
  return data !== undefined ? [tag, data] : [tag];
}

export const log = {
  // debug uses console.log (not console.debug) because console.debug is invisible
  // to Chrome's default DevTools filter and is NOT captured by the browser-logger
  // monkey-patch. Both debug and info intentionally route through console.log.
  // Gated: debug is a no-op unless walnutLogLevel=debug (see module header).
  debug(subsystem: string, message: string, data?: LogData): void {
    if (!debugEnabled) return;
    console.log(...fmt(subsystem, message, data));
  },
  info(subsystem: string, message: string, data?: LogData): void {
    console.log(...fmt(subsystem, message, data));
  },
  warn(subsystem: string, message: string, data?: LogData): void {
    console.warn(...fmt(subsystem, message, data));
  },
  error(subsystem: string, message: string, data?: LogData): void {
    console.error(...fmt(subsystem, message, data));
  },
};

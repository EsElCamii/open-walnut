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
 */

type LogData = Record<string, unknown>;

function fmt(subsystem: string, message: string, data?: LogData): [string, ...unknown[]] {
  const tag = `[${subsystem}] ${message}`;
  return data !== undefined ? [tag, data] : [tag];
}

export const log = {
  // debug uses console.log (not console.debug) because console.debug is invisible
  // to Chrome's default DevTools filter and is NOT captured by the browser-logger
  // monkey-patch. Both debug and info intentionally route through console.log.
  debug(subsystem: string, message: string, data?: LogData): void {
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

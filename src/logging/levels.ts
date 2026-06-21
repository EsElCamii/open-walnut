/**
 * Log level types and severity ordering.
 *
 * The configured threshold gates every emit() call (see subsystem.ts). Default
 * is `info`: `debug`/`trace` short-circuit before any serialization, stderr
 * write, or redaction. This matters on the streaming hot path — a single live
 * session can emit tens of thousands of `debug` text-delta lines, and writing
 * each one synchronously to stderr (tty) was starving the event loop, making
 * even a 2 KB HTTP response take 15 s. Set WALNUT_LOG_LEVEL=debug to re-enable
 * verbose diagnostics when investigating.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * Resolve the configured log threshold from WALNUT_LOG_LEVEL (case-insensitive).
 * Falls back to `info` for missing/invalid values. Read once at module load —
 * the level is process-wide and not expected to change at runtime.
 */
function resolveConfiguredLevel(): LogLevel {
  const raw = process.env.WALNUT_LOG_LEVEL?.toLowerCase().trim();
  if (raw && raw in LOG_LEVEL_ORDER) return raw as LogLevel;
  return DEFAULT_LEVEL;
}

export const CONFIGURED_LOG_LEVEL: LogLevel = resolveConfiguredLevel();

/**
 * Returns true if a message at `messageLevel` should be emitted
 * when the configured threshold is `configuredLevel` (defaults to the
 * process-wide CONFIGURED_LOG_LEVEL).
 */
export function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel = CONFIGURED_LOG_LEVEL): boolean {
  return LOG_LEVEL_ORDER[messageLevel] >= LOG_LEVEL_ORDER[configuredLevel];
}

/**
 * Terminal spawn — the ONLY place that knows where terminal bytes come from.
 *
 * Returns an `IPty` handle for a session's shell. The shell always runs inside
 * a named tmux session (`walnut-<sessionId>`) so it survives ssh/server death:
 *   - local:  node-pty spawns `tmux new-session -A -s walnut-<sid> -c <cwd>`
 *   - remote: node-pty spawns `ssh -tt <host> 'tmux new-session -A ...'`
 *
 * `-A` is idempotent (attach if the session exists, create otherwise), so a
 * reconnect re-attaches to the same shell with state intact. The upper layers
 * (TerminalManager / ring buffer / RPC) only see `IPty` — to change transport
 * (daemon, reverse agent) you only touch this file.
 */

import os from 'node:os'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { SessionRecord } from '../../core/types.js'
import type { SshTarget } from '../../providers/session-io.js'
import { shellQuote } from '../../providers/session-io.js'
import { getConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

export interface SpawnResult {
  pty: IPty
  /** Resolved working directory used for tmux `-c` (for diagnostics). */
  cwd?: string
  /** Host alias when remote, undefined for local. */
  host?: string
}

/**
 * Stable tmux session name derived from the Claude session ID.
 *
 * The returned name is interpolated UNQUOTED into remote `ssh ... 'tmux ... -s
 * <name>'` command strings, so it must contain no shell metacharacters. Claude
 * session IDs are UUIDs (hex + dashes), but we fail fast on anything outside
 * `[A-Za-z0-9_-]` rather than silently building an injectable command — a
 * malformed/hostile id is a bug, not something to paper over.
 */
export function tmuxSessionName(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Unsafe session id for tmux session name: ${JSON.stringify(sessionId)}`)
  }
  return `walnut-${sessionId}`
}

/**
 * Resolve a host alias to an SshTarget via config.hosts.
 * Returns null for local (empty host). Throws if the alias is unknown.
 */
export async function resolveSshTarget(host: string): Promise<SshTarget> {
  const config = await getConfig()
  const def = config.hosts?.[host]
  if (!def) throw new Error(`Unknown host: ${host}`)
  if (!def.hostname) throw new Error(`Host "${host}" has no hostname`)
  return { hostname: def.hostname, user: def.user, port: def.port, shell_setup: def.shell_setup }
}

function sshHostString(t: SshTarget): string {
  return t.user ? `${t.user}@${t.hostname}` : t.hostname
}

/** SSH options shared by terminal connections: batch mode + keepalive. */
function sshKeepaliveArgs(t: SshTarget): string[] {
  const args = [
    '-tt', // force remote PTY allocation
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
  if (t.port) args.push('-p', String(t.port))
  return args
}

/**
 * The remote command run over ssh: enter (or create) the tmux session.
 * cwd injected via tmux `-c` (start directory); omitted when no cwd.
 *
 * `-A` makes this idempotent: attach if `walnut-<sid>` exists, else create it.
 * IMPORTANT: when attaching to an EXISTING session, tmux IGNORES `-c` — the
 * pane keeps whatever cwd it currently has. That's intentional: a reconnect
 * lands you back where you left off (your `cd`s preserved), not reset to the
 * session's original cwd. `-c` only takes effect on first creation.
 */
export function buildRemoteTmuxCommand(sessionId: string, cwd?: string): string {
  const name = tmuxSessionName(sessionId)
  const parts = ['tmux', 'new-session', '-A', '-s', name]
  if (cwd) {
    parts.push('-c', shellQuote(cwd))
  }
  return parts.join(' ')
}

/** Local tmux args (node-pty spawns `tmux` directly, no shell quoting needed). */
export function buildLocalTmuxArgs(sessionId: string, cwd?: string): string[] {
  const name = tmuxSessionName(sessionId)
  const args = ['new-session', '-A', '-s', name]
  if (cwd) args.push('-c', cwd)
  return args
}

/** Full ssh argv for a remote terminal (for diagnostics/tests). */
export function buildRemoteSshArgs(sessionId: string, target: SshTarget, cwd?: string): string[] {
  return [
    ...sshKeepaliveArgs(target),
    sshHostString(target),
    buildRemoteTmuxCommand(sessionId, cwd),
  ]
}

/**
 * Spawn a terminal pty for a session record. Local → tmux; remote → ssh→tmux.
 * `node-pty` is imported lazily so a native-binary load failure can be caught
 * by the caller and degrade gracefully (terminal disabled, server stays up).
 */
export async function resolveSpawnForSession(
  record: SessionRecord,
  cols: number,
  rows: number,
): Promise<SpawnResult> {
  const pty = await import('@homebridge/node-pty-prebuilt-multiarch')
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>

  if (record.host) {
    const target = await resolveSshTarget(record.host)
    const args = buildRemoteSshArgs(record.claudeSessionId, target, record.cwd)
    log.web.info('terminal spawn (remote)', { sessionId: record.claudeSessionId, host: record.host, cwd: record.cwd })
    const p = pty.spawn('ssh', args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env })
    return { pty: p, cwd: record.cwd, host: record.host }
  }

  const cwd = record.cwd ?? os.homedir()
  const args = buildLocalTmuxArgs(record.claudeSessionId, cwd)
  log.web.info('terminal spawn (local)', { sessionId: record.claudeSessionId, cwd })
  const p = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd, env })
  return { pty: p, cwd }
}

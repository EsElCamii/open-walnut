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
import path from 'node:path'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type { SessionRecord } from '../../core/types.js'
import type { SshTarget } from '../../providers/session-io.js'
import { shellQuote } from '../../providers/session-io.js'
import { getConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

/**
 * SSH ControlMaster args shared by the tmux probe AND the terminal spawn for a
 * host. WHY: a fresh SSH connection to a corp dev host through the WSSH proxy
 * costs 2-21s (highly variable). Without muxing, the probe pays that once and
 * the spawn pays it AGAIN moments later — and the probe's 20s timeout would
 * intermittently fire. With a shared ControlPath, the probe establishes the
 * master connection and the spawn reuses it instantly (ControlPersist keeps it
 * warm). Same pattern the session daemon uses (daemon-connection.ts).
 *
 * `host` is the alias — one socket per alias, stable across probe+spawn+reaper.
 */
export function sshControlMasterArgs(host: string): string[] {
  const socket = path.join(os.tmpdir(), `walnut-term-ssh-${host}`)
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${socket}`,
    '-o', 'ControlPersist=120',
  ]
}

export interface SpawnResult {
  pty: IPty
  /** Resolved working directory used for tmux `-c` (for diagnostics). */
  cwd?: string
  /** Host alias when remote, undefined for local. */
  host?: string
}

/**
 * Dedicated tmux socket name (`tmux -L walnut ...`). TWO reasons this is
 * mandatory, not cosmetic:
 *   1. Isolation — Walnut's terminals never collide with the user's own tmux
 *      sessions on the default socket.
 *   2. Correctness on old tmux — a stale/corrupt `default` socket left in
 *      /tmp/tmux-<uid>/ makes tmux 1.8 (older Linux distros) silently fail
 *      `new-session` with rc=1 and immediately close the ssh connection. A
 *      private `-L` socket sidesteps that entirely (verified on a real legacy
 *      dev host where the default socket was wedged).
 * Used by spawn.ts, tmux-check.ts (probe) and tmux-lifecycle.ts — they MUST
 * all pass the same `-L walnut` or they'd talk to different tmux servers.
 */
export const TMUX_SOCKET = 'walnut'

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
 *
 * Start directory is set by `cd <cwd> &&` BEFORE launching tmux, NOT by tmux's
 * `-c` flag. Reason: `new-session -c` was only added in tmux 1.9, and some
 * legacy dev hosts ship tmux 1.8 — passing `-c` there fails with "unknown
 * option -- c" and the terminal never opens. A `cd` first works on every tmux
 * version: a NEW session inherits the launching client's cwd. `exec` replaces
 * the shell so the ssh process becomes tmux directly (clean signal handling).
 *
 * `-A` makes this idempotent: attach if `walnut-<sid>` exists, else create it.
 * On attach to an EXISTING session the leading `cd` is irrelevant — tmux keeps
 * the pane's current cwd, so a reconnect lands you back where you left off.
 */
export function buildRemoteTmuxCommand(sessionId: string, cwd?: string): string {
  const name = tmuxSessionName(sessionId)
  const tmux = `exec tmux -L ${TMUX_SOCKET} new-session -A -s ${name}`
  return cwd ? `cd ${shellQuote(cwd)} && ${tmux}` : tmux
}

/**
 * Local tmux args (node-pty spawns `tmux` directly).
 * Start directory comes from node-pty's `cwd` spawn option (see
 * resolveSpawnForSession), NOT tmux `-c` — same tmux-1.8 compatibility reason
 * as the remote path: a new session inherits the launching client's cwd.
 */
export function buildLocalTmuxArgs(sessionId: string): string[] {
  const name = tmuxSessionName(sessionId)
  return ['-L', TMUX_SOCKET, 'new-session', '-A', '-s', name]
}

/** Full ssh argv for a remote terminal. `host` (alias) keys the shared
 * ControlMaster socket so the probe's warm connection is reused here. */
export function buildRemoteSshArgs(sessionId: string, target: SshTarget, cwd?: string, host?: string): string[] {
  return [
    ...sshKeepaliveArgs(target),
    ...(host ? sshControlMasterArgs(host) : []),
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
    const args = buildRemoteSshArgs(record.claudeSessionId, target, record.cwd, record.host)
    log.web.info('terminal spawn (remote)', { sessionId: record.claudeSessionId, host: record.host, cwd: record.cwd })
    const p = pty.spawn('ssh', args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env })
    return { pty: p, cwd: record.cwd, host: record.host }
  }

  const cwd = record.cwd ?? os.homedir()
  const args = buildLocalTmuxArgs(record.claudeSessionId)
  log.web.info('terminal spawn (local)', { sessionId: record.claudeSessionId, cwd })
  // Start dir comes from node-pty's cwd option (tmux new-session inherits the
  // launching client's cwd) — avoids tmux `-c` which old tmux lacks.
  const p = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd, env })
  return { pty: p, cwd }
}

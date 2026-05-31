/**
 * tmux lifecycle helpers — when to keep vs reap the persistent tmux sessions.
 *
 * Core rule: connection-break events (WS flap, idle, server restart) NEVER kill
 * the tmux session — that's the whole point of tmux. Only explicit intent
 * (user "结束终端"), loss of ownership (session deleted), or a clean orphan
 * sweep may `kill-session`. Task completion uses a conditional kill: a tmux
 * session running a real foreground process (build/test) is kept; an idle shell
 * is reaped.
 */

import { execFile } from 'node:child_process'
import type { SessionRecord } from '../../core/types.js'
import { resolveSshTarget, tmuxSessionName } from './spawn.js'
import { listSessions } from '../../core/session-tracker.js'
import { log } from '../../logging/index.js'

const CMD_TIMEOUT_MS = 8_000

/** Shell names that mean "no foreground task" when reported as pane_current_command. */
const SHELL_COMMANDS = new Set(['bash', 'zsh', '-zsh', '-bash', 'sh', '-sh', 'fish', '-fish', 'tmux'])

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Run a tmux command locally, or wrapped in ssh for a remote host. */
async function runTmux(host: string | undefined, tmuxArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!host) {
    return run('tmux', tmuxArgs)
  }
  const target = await resolveSshTarget(host)
  const hostString = target.user ? `${target.user}@${target.hostname}` : target.hostname
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
  if (target.port) sshArgs.push('-p', String(target.port))
  // Quote each tmux arg minimally; our args are session names / format strings (no spaces except the format).
  const remote = ['tmux', ...tmuxArgs.map((a) => (/\s/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a))].join(' ')
  sshArgs.push(hostString, remote)
  return run('ssh', sshArgs)
}

/**
 * Does the session's tmux pane have a real foreground process (not just a shell)?
 * Returns false when tmux/session is absent or only running an idle shell.
 */
export async function hasForegroundProcess(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<boolean> {
  const name = tmuxSessionName(record.claudeSessionId)
  const res = await runTmux(record.host, ['display-message', '-p', '-t', name, '#{pane_current_command}'])
  if (res.code !== 0) return false // session gone or tmux missing → nothing to keep
  const cmd = res.stdout.trim()
  if (!cmd) return false
  return !SHELL_COMMANDS.has(cmd)
}

/** Explicitly kill a session's tmux session. */
export async function killTmuxSession(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<void> {
  const name = tmuxSessionName(record.claudeSessionId)
  const res = await runTmux(record.host, ['kill-session', '-t', name])
  if (res.code === 0) {
    log.web.info('tmux session killed', { sessionId: record.claudeSessionId, host: record.host })
  } else {
    log.web.debug('tmux kill-session noop (likely already gone)', { sessionId: record.claudeSessionId, host: record.host })
  }
}

/**
 * Conditional reap on task completion / session stop. Keeps the tmux session if
 * a foreground process is still running; otherwise kills it.
 * Returns 'killed' | 'kept'.
 */
export async function conditionalReap(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<'killed' | 'kept'> {
  if (await hasForegroundProcess(record)) {
    log.web.info('tmux kept (foreground process running)', { sessionId: record.claudeSessionId })
    return 'kept'
  }
  await killTmuxSession(record)
  return 'killed'
}

/** List walnut tmux session names on a host (local or remote). */
async function listWalnutTmux(host: string | undefined): Promise<string[]> {
  const res = await runTmux(host, ['list-sessions', '-F', '#{session_name}'])
  if (res.code !== 0) return [] // no server running → nothing to reap
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('walnut-'))
}

/**
 * Orphan reaper: sweep `walnut-*` tmux sessions on the local host (and known
 * remote hosts) and kill any whose backing session no longer exists in the
 * registry. Safety net for the "conditional keep" strategy. Best-effort.
 */
export async function reapOrphanTmux(): Promise<void> {
  let liveIds: Set<string>
  try {
    const sessions = await listSessions()
    liveIds = new Set(sessions.map((s) => s.claudeSessionId))
  } catch (err) {
    log.web.warn('reapOrphanTmux: failed to list sessions', { error: String(err) })
    return
  }

  // Determine hosts to sweep: local + every host referenced by a live session.
  const hosts = new Set<string | undefined>([undefined])
  try {
    const sessions = await listSessions()
    for (const s of sessions) if (s.host) hosts.add(s.host)
  } catch { /* already logged above */ }

  for (const host of hosts) {
    let names: string[]
    try {
      names = await listWalnutTmux(host)
    } catch (err) {
      log.web.warn('reapOrphanTmux: list failed', { host, error: String(err) })
      continue
    }
    for (const name of names) {
      const sid = name.slice('walnut-'.length)
      if (liveIds.has(sid)) continue // session still tracked → keep
      log.web.info('reaping orphan tmux session', { name, host })
      try {
        await killTmuxSession({ claudeSessionId: sid, host })
      } catch (err) {
        log.web.warn('reapOrphanTmux: kill failed', { name, host, error: String(err) })
      }
    }
  }
}

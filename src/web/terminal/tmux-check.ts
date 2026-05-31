/**
 * tmux availability probe. Terminal sessions require tmux on the target host
 * (it's what keeps the shell alive across ssh/server death). If tmux is missing
 * we do NOT silently fall back to a bare shell — that would give a terminal
 * that loses state on disconnect. Instead we return a structured error so the
 * UI can show an install hint + retry.
 */

import { execFile } from 'node:child_process'
import type { SessionRecord } from '../../core/types.js'
import { resolveSshTarget } from './spawn.js'
import { log } from '../../logging/index.js'

export type TmuxProbe =
  | { ok: true; version: string }
  | { ok: false; code: 'NO_TMUX'; host?: string; os?: string; installHint: string }

const PROBE_TIMEOUT_MS = 8_000

function run(cmd: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Map an OS identifier to a tmux install command. */
function installHintForOs(osId: string | undefined): string {
  const id = (osId ?? '').toLowerCase()
  if (id === 'darwin' || id === 'macos') return 'brew install tmux'
  if (/amzn|amazon|rhel|centos|fedora/.test(id)) return 'sudo yum install -y tmux  # or: sudo dnf install -y tmux'
  if (/debian|ubuntu/.test(id)) return 'sudo apt-get install -y tmux'
  return '安装 tmux 后重试(用目标主机的包管理器,如 yum / apt / dnf / pacman)'
}

/** Probe the local machine for tmux. */
async function probeLocal(): Promise<TmuxProbe> {
  const res = await run('tmux', ['-V'])
  if (res.code === 0 && /tmux/i.test(res.stdout)) {
    return { ok: true, version: res.stdout.trim() }
  }
  return { ok: false, code: 'NO_TMUX', os: process.platform, installHint: installHintForOs(process.platform) }
}

/**
 * Probe a remote host for tmux over ssh, and detect its OS so we can give the
 * right install command. One ssh round-trip does both.
 */
async function probeRemote(host: string): Promise<TmuxProbe> {
  let target
  try {
    target = await resolveSshTarget(host)
  } catch (err) {
    log.web.warn('terminal tmux probe: host resolve failed', { host, error: String(err) })
    return { ok: false, code: 'NO_TMUX', host, installHint: installHintForOs(undefined) }
  }

  const hostString = target.user ? `${target.user}@${target.hostname}` : target.hostname
  // Single command: report tmux version (or NO_TMUX) AND the OS id.
  const remoteCmd =
    'OS=$( (. /etc/os-release 2>/dev/null && echo "$ID") || uname -s ); ' +
    'if command -v tmux >/dev/null 2>&1; then echo "TMUX_OK:$(tmux -V)"; else echo "NO_TMUX"; fi; ' +
    'echo "OS:$OS"'

  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
  if (target.port) args.push('-p', String(target.port))
  args.push(hostString, remoteCmd)

  const res = await run('ssh', args)
  const out = res.stdout
  const osMatch = out.match(/OS:(.*)/)
  const osId = osMatch?.[1]?.trim()

  if (/TMUX_OK:/.test(out)) {
    const ver = out.match(/TMUX_OK:(.*)/)?.[1]?.trim() ?? 'tmux'
    return { ok: true, version: ver }
  }
  return { ok: false, code: 'NO_TMUX', host, os: osId, installHint: installHintForOs(osId) }
}

/** Probe tmux availability for a session (local or remote). */
export async function probeTmux(record: SessionRecord): Promise<TmuxProbe> {
  return record.host ? probeRemote(record.host) : probeLocal()
}

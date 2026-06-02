/**
 * tmux availability probe. Terminal sessions require tmux on the target host
 * (it's what keeps the shell alive across ssh/server death). If tmux is missing
 * we do NOT silently fall back to a bare shell — that would give a terminal
 * that loses state on disconnect. Instead we return a structured error so the
 * UI can show an install hint + retry.
 */

import { execFile } from 'node:child_process'
import type { SessionRecord } from '../../core/types.js'
import { resolveSshTarget, TMUX_SOCKET, sshControlMasterArgs } from './spawn.js'
import { log } from '../../logging/index.js'

export type TmuxProbe =
  | { ok: true; version: string }
  | { ok: false; code: 'NO_TMUX'; host?: string; os?: string; installHint: string }

// 20s: a remote probe is a full ssh round-trip, and the corp SSH proxy adds
// ~10-17s of (variable) connection latency to dev hosts. 8s/15s were too tight
// and killed the probe mid-flight — the truncated output then fell through to
// the generic NO_TMUX hint instead of the accurate TMUX_BROKEN/OK result.
const PROBE_TIMEOUT_MS = 20_000

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

/** Probe the local machine for tmux (presence only — local tmux is the dev's
 * own install and, unlike ancient remote builds, is assumed functional once
 * present; a -V check avoids spawning a throwaway server on every open). */
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
  // One ssh round-trip detects OS + verifies tmux can ACTUALLY run a session,
  // not just report a version. A bare `tmux -V` check is insufficient: ancient
  // builds (e.g. tmux 1.8 on older Linux distros) report a version but then fail to
  // start a session over an ssh PTY — opening such a terminal just dies with a
  // confusing "Connection closed". So we create + kill a throwaway detached
  // session and require RC 0. `-c` is NOT used here (1.8 lacks it); the probe
  // session is functional-only, its cwd is irrelevant.
  // The `new-session` test is wrapped in remote `timeout 5` (when available) so
  // a broken tmux that HANGS trying to start a server can't consume the whole
  // ssh budget — it falls through to TMUX_BROKEN within 5s instead.
  // Probe on the SAME dedicated socket the real terminal uses (`-L walnut`):
  // the default socket may be wedged (stale socket → tmux 1.8 fails), so a
  // probe on `default` would false-negative a host where `-L walnut` works.
  // A `run_tmux` shell function carries the optional `timeout` prefix so a
  // hung tmux can't stall the probe — done via a function, NOT a `$TO` var,
  // because an unquoted `$TO="timeout 5"` would be passed as a single
  // "timeout 5" argv token ("command not found") instead of word-splitting.
  const probe = `tmux -L ${TMUX_SOCKET} new-session -d -s __walnut_probe__`
  const kill = `tmux -L ${TMUX_SOCKET} kill-session -t __walnut_probe__`
  const remoteCmd =
    'OS=$( (. /etc/os-release 2>/dev/null && echo "$ID") || uname -s ); echo "OS:$OS"; ' +
    'run_tmux() { if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"; else "$@"; fi; }; ' +
    `if ! command -v tmux >/dev/null 2>&1; then echo "NO_TMUX"; ` +
    `elif run_tmux ${probe} >/dev/null 2>&1; then ` +
    `${kill} >/dev/null 2>&1; echo "TMUX_OK:$(tmux -V)"; ` +
    'else echo "TMUX_BROKEN:$(tmux -V 2>&1)"; fi'

  // ControlMaster: this probe ESTABLISHES the shared SSH connection that the
  // terminal spawn (moments later) reuses instantly — without it both pay the
  // 2-21s corp-proxy connection cost and the probe's timeout intermittently
  // fires. Socket key (host alias) must match buildRemoteSshArgs's.
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', ...sshControlMasterArgs(host)]
  if (target.port) args.push('-p', String(target.port))
  args.push(hostString, remoteCmd)

  const res = await run('ssh', args)
  const out = res.stdout
  const osId = out.match(/OS:(.*)/)?.[1]?.trim()
  log.web.info('terminal tmux probe (remote)', { host, code: res.code, out: out.trim().replace(/\n/g, ' | ') })

  if (/TMUX_OK:/.test(out)) {
    const ver = out.match(/TMUX_OK:(.*)/)?.[1]?.trim() ?? 'tmux'
    return { ok: true, version: ver }
  }
  // tmux present but can't start a session (too old / broken) → tell the user to
  // upgrade, same NO_TMUX UI path with an upgrade-oriented hint.
  if (/TMUX_BROKEN:/.test(out)) {
    const ver = out.match(/TMUX_BROKEN:(.*)/)?.[1]?.trim() ?? ''
    return {
      ok: false, code: 'NO_TMUX', host, os: osId,
      installHint: `当前 tmux 无法启动会话(${ver || '版本过旧'})。请升级:${installHintForOs(osId)}`,
    }
  }
  return { ok: false, code: 'NO_TMUX', host, os: osId, installHint: installHintForOs(osId) }
}

/** Probe tmux availability for a session (local or remote). */
export async function probeTmux(record: SessionRecord): Promise<TmuxProbe> {
  return record.host ? probeRemote(record.host) : probeLocal()
}

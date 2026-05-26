/**
 * Full-chain E2E: RemoteSessionManager → DaemonConnection → real daemon process
 *                → real FIFO → real child process → session death → session_state
 *                broadcast → client onExit callback fires.
 *
 * This is the exact user-reported scenario: session dies silently, user sends
 * again, and the system must:
 *   1. Detect the death deterministically
 *   2. Propagate it to the RemoteSessionManager via session_state
 *   3. Fire onExit so the runner can gracefulStop + --resume respawn
 *   4. writeMessage must return a strict false on pipe dead (no silent drop)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const fakeSshTarget: SshTarget = { hostname: 'localhost' }

interface DaemonProc {
  proc: ChildProcess
  port: number
  daemonDir: string
  scriptPath: string
}

let scriptPath: string

async function writeDaemonScript(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-e2e-'))
  const p = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(p, getDaemonSource(), { mode: 0o755 })
  return p
}

async function spawnDaemon(daemonDir: string): Promise<DaemonProc> {
  const env = { ...process.env, WALNUT_DAEMON_DIR: daemonDir }
  const proc = spawn('node', [scriptPath, '--start'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  })
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(t); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (e) => { clearTimeout(t); reject(e) })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('daemon exited: ' + c)) })
  })
  return { proc, port, daemonDir, scriptPath }
}

async function stopDaemon(d: DaemonProc): Promise<void> {
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch {} ; resolve() }, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}

beforeAll(async () => {
  fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
  scriptPath = await writeDaemonScript()
})

afterAll(async () => {
  try { await fsp.rm(path.dirname(scriptPath), { recursive: true, force: true }) } catch {}
})

// ════════════════════════════════════════════════════════════════════════

describe('RemoteSessionManager → real daemon full chain', () => {
  let daemon: DaemonProc
  let daemonDir: string

  beforeEach(async () => {
    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-data-'))
    daemon = await spawnDaemon(daemonDir)
  })

  afterEach(async () => {
    await stopDaemon(daemon)
    try { await fsp.rm(daemonDir, { recursive: true, force: true }) } catch {}
  })

  // ─────────────────────────────────────────────────────────────────────
  it('external SIGKILL on session process → onExit fires via session_state', async () => {
    const sid = `full-chain-${Date.now()}`
    const transport = new RemoteSessionManager(sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const lines: string[] = []
    let exitCode: number | null = null

    const result = await transport.start({
      args: ['/bin/sleep', '60'],
      cwd: '/tmp',
      message: 'init\n',
      onOutput: (ev) => { lines.push(ev.line) },
      onExit: (code) => { exitCode = code },
    })

    expect(result.pid).toBeGreaterThan(0)
    const pid = result.pid

    // Externally kill — daemon must detect via proc.on('exit'), reap,
    // broadcast session_state=dead, and the transport's handleDaemonEvent
    // must fire _onExit.
    process.kill(pid, 'SIGKILL')

    await vi.waitFor(() => {
      expect(exitCode).not.toBeNull()
    }, { timeout: 10_000, interval: 50 })

    expect(exitCode).toBeGreaterThanOrEqual(0)
    await transport.stop()
  })

  // ─────────────────────────────────────────────────────────────────────
  it('writeMessage to dead session returns false (strict ack, no silent drop)', async () => {
    const sid = `strict-ack-${Date.now()}`
    const transport = new RemoteSessionManager(sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    let exitCalled = false
    const result = await transport.start({
      args: ['/bin/sleep', '60'],
      cwd: '/tmp',
      message: 'init\n',
      onOutput: () => {},
      onExit: () => { exitCalled = true },
    })

    // Kill the session process
    process.kill(result.pid, 'SIGKILL')

    // Wait for daemon to detect death and broadcast session_state=dead,
    // which flips _hasPipe=false on the transport.
    await vi.waitFor(() => expect(exitCalled).toBe(true), { timeout: 10_000, interval: 50 })

    // Now writeMessage should return false deterministically — NOT true, NOT throw.
    const sent = await transport.writeMessage('late message')
    expect(sent).toBe(false)

    await transport.stop()
  })

  // ─────────────────────────────────────────────────────────────────────
  it('writeMessage on healthy session returns true', async () => {
    const sid = `happy-path-${Date.now()}`
    const transport = new RemoteSessionManager(sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const result = await transport.start({
      args: ['/bin/sleep', '60'],
      cwd: '/tmp',
      message: 'init\n',
      onOutput: () => {},
      onExit: () => {},
    })
    expect(result.pid).toBeGreaterThan(0)

    const sent = await transport.writeMessage('follow up')
    expect(sent).toBe(true)

    // Cleanup
    process.kill(result.pid, 'SIGKILL')
    await transport.stop()
  })
})

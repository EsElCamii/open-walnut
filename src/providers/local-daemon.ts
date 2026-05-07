/**
 * Local Daemon — manages a daemon process on the local macOS machine.
 *
 * The local daemon is the same binary (walnut-daemon) that runs on remote
 * Linux hosts, but compiled for darwin-arm64. It provides unified session
 * management: spawn, FIFO, JSONL tailing, permission policy — same as remote.
 *
 * Lifecycle:
 *   1. Walnut startup: ensureRunning() checks /tmp/open-walnut/daemon.port
 *   2. If daemon is alive AND version matches binary: reuse it
 *   3. If version mismatches: SIGTERM the old daemon (session survive? they
 *      get killed — local CLIs are children of the daemon process group, but
 *      next request will respawn and users can re-send)
 *   4. Spawn the binary with --start, wait for port file
 *   5. Connect via ws://localhost:<port> (no SSH tunnel)
 *
 * Version auto-refresh: on every Walnut startup we compare the daemon's
 * reported version (via 'hello' command) against the binary's .version
 * sidecar. If they differ, the running daemon is stale and gets restarted
 * so bug fixes ship immediately without manual intervention.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { log } from '../logging/index.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'

const DEFAULT_DAEMON_DIR = '/tmp/open-walnut'

// ESM-safe __dirname equivalent
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface LocalDaemonOptions {
  /** Override daemon dir (default: /tmp/open-walnut). Tests use this for isolation. */
  daemonDir?: string
  /** Override binary path (default: autodetected). Tests use this with a mock script. */
  binaryPath?: string
}

export class LocalDaemon {
  private _port: number | null = null
  private _wsUrl: string | null = null
  private readonly daemonDir: string
  private readonly portFile: string
  private readonly pidFile: string
  private readonly overrideBinaryPath: string | undefined

  constructor(opts: LocalDaemonOptions = {}) {
    this.daemonDir = opts.daemonDir ?? DEFAULT_DAEMON_DIR
    this.portFile = path.join(this.daemonDir, 'daemon.port')
    this.pidFile = path.join(this.daemonDir, 'daemon.pid')
    this.overrideBinaryPath = opts.binaryPath
  }

  get port(): number | null { return this._port }
  get wsUrl(): string | null { return this._wsUrl }

  async ensureRunning(): Promise<number> {
    const binaryPath = this.findDaemonBinary()
    const expectedVersion = this.readBinaryVersion(binaryPath)

    // 1. Check if daemon is already running
    const existingPort = this.readPortFile()
    if (existingPort) {
      const helloResult = await this.ping(existingPort)
      if (helloResult.alive) {
        // 2. Check version — auto-restart if stale
        if (expectedVersion && helloResult.version && helloResult.version !== expectedVersion) {
          log.session.info('local daemon version mismatch — restarting', {
            running: helloResult.version,
            expected: expectedVersion,
          })
          await this.stopDaemon()
        } else {
          this._port = existingPort
          this._wsUrl = `ws://localhost:${existingPort}`
          log.session.info('local daemon already running', {
            port: existingPort,
            version: helloResult.version,
          })
          return existingPort
        }
      } else {
        log.session.info('local daemon port file exists but daemon is dead, respawning')
      }
    }

    // 3. Spawn fresh daemon
    const port = await this.spawnDaemon(binaryPath)
    this._port = port
    this._wsUrl = `ws://localhost:${port}`
    log.session.info('local daemon started', { port, version: expectedVersion })
    return port
  }

  getDirectWsUrl(): string {
    if (!this._wsUrl) throw new Error('Local daemon not running. Call ensureRunning() first.')
    return this._wsUrl
  }

  private readPortFile(): number | null {
    try {
      const content = fs.readFileSync(this.portFile, 'utf-8').trim()
      const port = parseInt(content, 10)
      return port > 0 ? port : null
    } catch {
      return null
    }
  }

  private readPidFile(): number | null {
    try {
      const content = fs.readFileSync(this.pidFile, 'utf-8').trim()
      const pid = parseInt(content, 10)
      return pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async ping(port: number): Promise<{ alive: boolean; version?: string; capabilities?: string[] }> {
    return new Promise((resolve) => {
      // 2s is generous for localhost WebSocket (typically <10ms) but handles
      // daemon startup jitter. This blocks Walnut server startup, so keep short.
      const timeout = setTimeout(() => { resolve({ alive: false }) }, 2000)
      try {
        const ws = new WebSocket(`ws://localhost:${port}`)
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, cmd: 'hello' }))
        })
        ws.on('message', (data) => {
          clearTimeout(timeout)
          ws.close()
          try {
            const msg = JSON.parse(data.toString()) as { ok?: boolean; version?: string; capabilities?: string[] }
            resolve({ alive: msg.ok === true, version: msg.version, capabilities: msg.capabilities })
          } catch {
            resolve({ alive: false })
          }
        })
        ws.on('error', () => { clearTimeout(timeout); resolve({ alive: false }) })
      } catch {
        clearTimeout(timeout)
        resolve({ alive: false })
      }
    })
  }

  private async stopDaemon(): Promise<void> {
    const pid = this.readPidFile()
    if (!pid) return
    try { process.kill(pid, 'SIGTERM') } catch { return }

    // Wait for shutdown (up to 5s)
    for (let i = 0; i < 50; i++) {
      if (!this.isPidAlive(pid)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // Force kill if still alive
    if (this.isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    try { fs.unlinkSync(this.portFile) } catch {}
    try { fs.unlinkSync(this.pidFile) } catch {}
  }

  private async spawnDaemon(binaryPath: string): Promise<number> {
    fs.mkdirSync(this.daemonDir, { recursive: true })

    log.session.info('spawning local daemon', { binary: binaryPath })

    const proc = spawn(binaryPath, ['--start'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    proc.unref()

    // Capture async spawn errors (ENOENT, EACCES) so they surface as rejection
    // instead of "unhandled error" crashes. The listener is single-use — once
    // spawn completes (error or success), nothing more arrives.
    let spawnError: Error | null = null
    proc.on('error', (err) => { spawnError = err })

    // Wait for port file (daemon writes it on startup)
    const port = await this.waitForPortFile(10000)
    if (spawnError) {
      throw new Error(`Local daemon spawn failed: ${(spawnError as Error).message}`)
    }
    if (!port) {
      throw new Error('Local daemon failed to start — port file not created within 10s')
    }

    // Verify it responds
    const result = await this.ping(port)
    if (!result.alive) {
      throw new Error(`Local daemon started (port ${port}) but not responding to hello`)
    }

    return port
  }

  private findDaemonBinary(): string {
    if (this.overrideBinaryPath) return this.overrideBinaryPath
    // DAEMON_BINARIES_DIR is the canonical build output location
    const binaryName = `daemon-darwin-arm64`
    const candidates = [
      path.join(DAEMON_BINARIES_DIR, binaryName),
      path.join(__dirname, '..', '..', 'dist', 'daemon-binaries', binaryName),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    throw new Error(`Local daemon binary not found. Run: bash scripts/build-daemon.sh`)
  }

  private readBinaryVersion(binaryPath: string): string | null {
    try {
      return fs.readFileSync(`${binaryPath}.version`, 'utf-8').trim()
    } catch {
      return null
    }
  }

  // 10s allows for: binary exec, Bun runtime init, directory creation,
  // socket bind, and port file write. Empirically sufficient for all tested hardware.
  private async waitForPortFile(timeoutMs: number): Promise<number | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const port = this.readPortFile()
      if (port) {
        // Verify it's a fresh port (not stale from old daemon)
        const pid = this.readPidFile()
        if (pid && this.isPidAlive(pid)) {
          return port
        }
      }
      await new Promise(r => setTimeout(r, 200))
    }
    return null
  }
}

export const localDaemon = new LocalDaemon()

/**
 * DaemonConnection — WebSocket client + SSH tunnel to remote walnut-daemon.
 *
 * ARCHITECTURE:
 * One DaemonConnection per remote host. Manages:
 *   1. Deploying daemon.js to the remote host
 *   2. Starting the daemon (or connecting to existing)
 *   3. SSH tunnel (localhost:localPort → remote:daemonPort)
 *   4. WebSocket connection through the tunnel
 *   5. Automatic reconnection on tunnel/connection failure
 *
 * LIFECYCLE:
 *   connect() → [send() commands] → disconnect()
 *   On tunnel death: auto-reconnect (daemon survives)
 *   On daemon death: auto-redeploy + restart
 *
 * PROTOCOL:
 *   Commands: { id, cmd, ...params }
 *   Responses: { id, ok, ...data }
 *   Events: { ev, ...data } (no id — unsolicited)
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../logging/index.js'
import { getDaemonSource } from './daemon-source.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { buildRemotePreamble } from './session-io.js'
import type { SshTarget } from './session-io.js'

// ── Types ──

export interface DaemonCommandResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export interface DaemonEvent {
  ev: string
  sid?: string
  line?: string
  lines?: string[]
  agent?: string
  code?: number
  [key: string]: unknown
}

type EventHandler = (event: DaemonEvent) => void

interface PendingCommand {
  resolve: (result: DaemonCommandResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ── DaemonConnection ──

export class DaemonConnection {
  private ws: WebSocket | null = null
  private tunnel: ChildProcess | null = null
  private sshTarget: SshTarget
  private hostKey: string
  private localPort: number | null = null
  private remotePort: number | null = null
  private _connected = false
  private _connecting = false
  private _destroyed = false
  private _disconnectedSince: number | null = null
  private cmdCounter = 0
  private pendingCommands = new Map<number, PendingCommand>()
  private eventHandlers: EventHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Timestamp of last pong received — used for stale connection detection. */
  private lastPongAt = 0

  /** Command timeout in ms. Generous for initial deploy operations. */
  private static COMMAND_TIMEOUT_MS = 30_000
  /** Initial reconnect delay after connection loss (doubles each attempt, caps at MAX). */
  private static RECONNECT_DELAY_MS = 2_000
  /** Maximum reconnect delay — retries forever at this interval. */
  private static RECONNECT_MAX_DELAY_MS = 30_000
  /** Ping interval for keepalive. */
  private static PING_INTERVAL_MS = 15_000

  /** Cached remote arch (detected once per connection). */
  private _remoteArch: string | null = null
  /** SSH ControlMaster socket path — all SSH commands multiplex through one connection. */
  private _controlPath: string | null = null
  /** ControlMaster SSH process — kept alive for the lifetime of this DaemonConnection. */
  private _controlMaster: ChildProcess | null = null

  constructor(hostKey: string, sshTarget: SshTarget) {
    this.hostKey = hostKey
    this.sshTarget = sshTarget
  }

  // ── Binary deployment helpers ──

  /**
   * Detect the remote host's architecture via `uname -m`.
   * Cached per connection — only one SSH round-trip.
   */
  private detectRemoteArch(): string {
    if (this._remoteArch) return this._remoteArch
    const raw = this.sshExec('uname -m').trim()
    this._remoteArch = raw === 'aarch64' ? 'arm64' : 'x64'
    return this._remoteArch
  }

  /** Binary name for the detected remote arch. */
  private get remoteBinaryName(): string {
    return `daemon-linux-${this.detectRemoteArch()}`
  }

  /** Full remote path where the binary is deployed. */
  private get remoteDaemonPath(): string {
    return `/tmp/open-walnut/${this.remoteBinaryName}`
  }

  /**
   * Check if pre-compiled daemon binaries exist locally.
   * Returns the local binary path if available, null otherwise.
   */
  private getLocalBinaryPath(): string | null {
    const binaryPath = path.join(DAEMON_BINARIES_DIR, this.remoteBinaryName)
    try {
      if (fs.statSync(binaryPath).isFile()) return binaryPath
    } catch { /* not built yet */ }
    return null
  }

  get connected(): boolean { return this._connected }
  get disconnectedSince(): number | null { return this._disconnectedSince }

  /**
   * Centralized setter for _connected — fires the pool-level callback
   * whenever the connection state actually changes, so the server can
   * broadcast the new daemon status to the frontend.
   */
  private setConnected(value: boolean): void {
    const changed = this._connected !== value
    this._connected = value
    if (value) {
      this._disconnectedSince = null
    } else if (changed) {
      this._disconnectedSince = Date.now()
    }
    if (changed && onPoolStatusChange) {
      try {
        const result = onPoolStatusChange()
        // Handle async callbacks: swallow unhandled rejection warnings.
        // The registered callback already has its own inner try/catch for logging.
        if (result && typeof (result as unknown as Promise<void>).catch === 'function') {
          ;(result as unknown as Promise<void>).catch(() => {})
        }
      } catch {}
    }
  }

  // ── Event subscription ──

  /**
   * Subscribe to unsolicited daemon events (jsonl, exit, agent).
   * Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const idx = this.eventHandlers.indexOf(handler)
      if (idx >= 0) this.eventHandlers.splice(idx, 1)
    }
  }

  // ── Connection ──

  /**
   * Connect to the remote daemon. If no daemon is running, deploy and start one.
   * Sets up SSH tunnel and WebSocket connection.
   */
  async connect(): Promise<void> {
    if (this._connected || this._connecting) return
    this._connecting = true

    try {
      // Step 0: Establish SSH ControlMaster (one connection for all subsequent commands)
      this.ensureControlMaster()

      // Step 1: Check if daemon is already running
      let daemonPort = await this.checkDaemonRunning()

      if (daemonPort === null) {
        // Step 2: Deploy daemon
        await this.deployDaemon()

        // Step 3: Start daemon
        daemonPort = await this.startDaemon()
      }

      this.remotePort = daemonPort

      // Step 4: Create SSH tunnel
      this.localPort = await this.createTunnel(daemonPort)

      // Step 5: Connect WebSocket
      await this.connectWebSocket(this.localPort)

      this.setConnected(true)
      this._connecting = false

      // Start ping keepalive
      this.startPing()

      log.session.info('DaemonConnection: connected', {
        host: this.hostKey,
        localPort: this.localPort,
        remotePort: daemonPort,
      })

      // Initial connection: recover any sessions that were left in error state
      // from a previous server run (e.g. server restart while sessions were error).
      this.recoverDisconnectedSessions().catch(() => {})
    } catch (err) {
      this._connecting = false
      throw err
    }
  }

  /**
   * Send a command to the daemon and wait for a response.
   */
  async send(cmd: string, params: Record<string, unknown> = {}): Promise<DaemonCommandResult> {
    if (!this._connected || !this.ws) {
      throw new Error(`DaemonConnection not connected to ${this.hostKey}`)
    }

    const id = ++this.cmdCounter
    const message = JSON.stringify({ id, cmd, ...params })

    return new Promise<DaemonCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`daemon command timeout: ${cmd} (${DaemonConnection.COMMAND_TIMEOUT_MS}ms)`))
      }, DaemonConnection.COMMAND_TIMEOUT_MS)

      this.pendingCommands.set(id, { resolve, reject, timer })
      this.ws!.send(message)
    })
  }

  /**
   * Disconnect from the daemon and clean up SSH tunnel.
   * Does NOT stop the daemon — it continues running independently.
   */
  disconnect(): void {
    this._destroyed = true
    this.setConnected(false)
    this._connecting = false

    // Cancel reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Stop ping
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    // Reject pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer)
      pending.reject(new Error('connection closed'))
    }
    this.pendingCommands.clear()

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    // Kill SSH tunnel
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // Stop SSH ControlMaster
    this.stopControlMaster()

    log.session.info('DaemonConnection: disconnected', { host: this.hostKey })
  }

  // ── Private: SSH helpers ──

  private get sshHostString(): string {
    return this.sshTarget.user
      ? `${this.sshTarget.user}@${this.sshTarget.hostname}`
      : this.sshTarget.hostname
  }

  private get baseSshArgs(): string[] {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no']
    if (this.sshTarget.port) args.push('-p', String(this.sshTarget.port))
    // Use ControlMaster socket if available — multiplexes all SSH through one connection
    if (this._controlPath) {
      args.push('-o', `ControlPath=${this._controlPath}`)
    }
    return args
  }

  /**
   * Start an SSH ControlMaster — a persistent background SSH connection that
   * all subsequent SSH commands multiplex through. This avoids opening 5-7
   * separate SSH connections during connect(), which triggers rate-limiting
   * on corporate hosts.
   */
  private ensureControlMaster(): void {
    if (this._controlMaster) return
    const socketPath = path.join(os.tmpdir(), `walnut-ssh-${this.hostKey}-${process.pid}`)
    this._controlPath = socketPath

    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `ControlPath=${socketPath}`,
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPersist=300',  // keep alive 5 min after last use
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ]
    if (this.sshTarget.port) args.push('-p', String(this.sshTarget.port))
    args.push('-fN', this.sshHostString)  // -f: background, -N: no command

    try {
      execFileSync('ssh', args, { timeout: 15_000, stdio: 'pipe' })
      // execFileSync returns when -f backgrounds. ControlMaster is now running.
      log.session.info('DaemonConnection: SSH ControlMaster started', {
        host: this.hostKey, socketPath,
      })
    } catch (err) {
      log.session.warn('DaemonConnection: ControlMaster failed, falling back to individual connections', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      this._controlPath = null
    }
  }

  /**
   * Stop the SSH ControlMaster connection.
   */
  private stopControlMaster(): void {
    if (this._controlPath) {
      try {
        execFileSync('ssh', ['-o', `ControlPath=${this._controlPath}`, '-O', 'exit', this.sshHostString], {
          timeout: 5_000, stdio: 'pipe',
        })
      } catch { /* already gone */ }
      this._controlPath = null
    }
    this._controlMaster = null
  }

  /**
   * Execute a command on the remote host via SSH and return stdout.
   * Uses ControlMaster if available (single TCP connection for all commands).
   */
  private sshExec(remoteCmd: string, timeoutMs = 10_000): string {
    const args = [...this.baseSshArgs, this.sshHostString, remoteCmd]
    return execFileSync('ssh', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  }

  // ── Private: Daemon management ──

  /**
   * Check if daemon is already running on the remote host.
   * Returns the port number if running, null otherwise.
   *
   * Tries the binary first, then falls back to the old node-based daemon
   * (in case a previous source-deploy daemon is still running).
   */
  private async checkDaemonRunning(): Promise<number | null> {
    // Try binary daemon first
    try {
      const result = this.sshExec(`${this.remoteDaemonPath} --status 2>/dev/null`)
      const status = JSON.parse(result)
      if (status.running && status.port) {
        log.session.info('DaemonConnection: daemon already running (binary)', {
          host: this.hostKey, port: status.port, pid: status.pid,
        })
        return status.port
      }
    } catch { /* not running or binary not deployed */ }

    // Fallback: check old node-based daemon (may still be running from previous deploy)
    try {
      const preamble = buildRemotePreamble(this.sshTarget.shell_setup)
      const result = this.sshExec(`${preamble}; node /tmp/open-walnut/daemon.js --status 2>/dev/null`)
      const status = JSON.parse(result)
      if (status.running && status.port) {
        log.session.info('DaemonConnection: daemon already running (node)', {
          host: this.hostKey, port: status.port, pid: status.pid,
        })
        return status.port
      }
    } catch { /* not running */ }

    return null
  }

  /**
   * Deploy daemon to the remote host.
   *
   * Prefers binary deployment (fast, no runtime deps) when pre-compiled binaries
   * are available. Falls back to source-based deploy (node + npm install ws) when
   * binaries haven't been built yet (dev workflow).
   */
  private async deployDaemon(): Promise<void> {
    const localBinary = this.getLocalBinaryPath()

    if (localBinary) {
      await this.deployBinary(localBinary)
    } else {
      log.session.info('DaemonConnection: no binary found, falling back to source deploy', {
        host: this.hostKey, binaryDir: DAEMON_BINARIES_DIR,
      })
      await this.deploySource()
    }
  }

  /**
   * Deploy a pre-compiled binary to the remote host.
   * Much faster than source deploy — no npm install, no node PATH discovery.
   */
  private async deployBinary(localBinaryPath: string): Promise<void> {
    const t0 = Date.now()
    const binarySize = fs.statSync(localBinaryPath).size

    try {
      // Create directory
      this.sshExec('mkdir -p /tmp/open-walnut')

      // Check if remote binary is already up to date by comparing version strings.
      // The binary embeds a version via --define at build time.
      // We read the local version from a sidecar .version file (written by build script)
      // because the binary is cross-compiled for Linux and can't run on the local host.
      let needsDeploy = true
      try {
        const versionFile = localBinaryPath + '.version'
        const localVersion = fs.readFileSync(versionFile, 'utf-8').trim()
        const remoteVersion = this.sshExec(`${this.remoteDaemonPath} --version 2>/dev/null`, 5_000)
        if (localVersion && remoteVersion && localVersion === remoteVersion) {
          needsDeploy = false
          log.session.info('DaemonConnection: binary already up to date', {
            host: this.hostKey, version: localVersion,
          })
        }
      } catch { /* version check failed — deploy fresh */ }

      if (needsDeploy) {
        // Deploy via reverse SSH tunnel + curl.
        // Many corporate hosts kill large SSH data transfers (SCP/pipe >10MB).
        // Instead: start a temporary HTTP server locally, create a reverse SSH
        // tunnel so the remote can reach it, then curl the compressed binary.
        const remotePath = this.remoteDaemonPath
        const gzPath = localBinaryPath + '.gz'

        // Compress if needed (cached alongside binary)
        if (!fs.existsSync(gzPath)) {
          const { execFileSync: execF } = await import('node:child_process')
          execF('gzip', ['-c', localBinaryPath], { stdio: ['pipe', fs.openSync(gzPath, 'w'), 'pipe'] })
        }

        // Start temporary HTTP server on random port
        const { createServer: createHttpServer } = await import('node:http')
        const gzData = fs.readFileSync(gzPath)
        const httpServer = createHttpServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': gzData.length })
          res.end(gzData)
        })
        await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
        const httpPort = (httpServer.address() as { port: number }).port

        try {
          // Use reverse tunnel: remote:httpPort → local:httpPort, then curl
          const args = [
            ...this.baseSshArgs,
            '-R', `${httpPort}:127.0.0.1:${httpPort}`,
            this.sshHostString,
            `curl -sf http://127.0.0.1:${httpPort}/ -o ${remotePath}.gz && gunzip -f ${remotePath}.gz && chmod +x ${remotePath}`,
          ]
          const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })

          let stderr = ''
          proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

          const exitCode = await new Promise<number>((resolve, reject) => {
            proc.on('close', resolve)
            proc.on('error', reject)
            setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('deploy timeout (60s)')) }, 60_000)
          })

          if (exitCode !== 0) {
            throw new Error(`binary deploy failed (exit ${exitCode}): ${stderr.slice(0, 300)}`)
          }

          log.session.info('DaemonConnection: binary deployed via reverse tunnel', {
            host: this.hostKey, deployMs: Date.now() - t0,
            bytes: binarySize, gzBytes: gzData.length, binary: this.remoteBinaryName,
          })
        } finally {
          httpServer.close()
        }
      }
    } catch (err) {
      throw new Error(`Failed to deploy daemon binary to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Legacy source-based deploy: pipe daemon.js + npm install ws.
   * Used as fallback when pre-compiled binaries aren't available.
   */
  private async deploySource(): Promise<void> {
    const source = getDaemonSource()
    const t0 = Date.now()
    const preamble = buildRemotePreamble(this.sshTarget.shell_setup)

    try {
      // Create directory and write daemon.js
      this.sshExec('mkdir -p /tmp/open-walnut')

      const args = [...this.baseSshArgs, this.sshHostString, 'cat > /tmp/open-walnut/daemon.js']
      const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })

      await new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`daemon source deploy failed with code ${code}`))
        })
        proc.on('error', reject)
        proc.stdin!.end(source)
      })

      // Ensure 'ws' package is available for the daemon's WebSocket server.
      try {
        this.sshExec(`${preamble}; cd /tmp/open-walnut && node -e "require('ws')" 2>/dev/null || npm install --prefix /tmp/open-walnut ws 2>/dev/null`, 30_000)
      } catch {
        log.session.debug('DaemonConnection: ws install skipped', { host: this.hostKey })
      }

      log.session.info('DaemonConnection: daemon source deployed', {
        host: this.hostKey, deployMs: Date.now() - t0, bytes: source.length,
      })
    } catch (err) {
      throw new Error(`Failed to deploy daemon source to ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Start the daemon on the remote host. Returns the listening port.
   *
   * Uses the binary directly when deployed (no PATH discovery needed).
   * Falls back to node + preamble for source-based deployments.
   */
  private async startDaemon(): Promise<number> {
    try {
      // Determine the start command based on what was deployed.
      // Binary: direct execution. Source: needs node PATH discovery.
      let startCmd: string
      if (this.getLocalBinaryPath()) {
        // Binary deploy — run directly, no PATH setup needed
        startCmd = `nohup ${this.remoteDaemonPath} --start > /tmp/open-walnut/daemon-start.log 2>&1 & ` +
          'sleep 2 && cat /tmp/open-walnut/daemon.port'
      } else {
        // Source deploy — needs node PATH discovery
        const preamble = buildRemotePreamble(this.sshTarget.shell_setup)
        startCmd = `${preamble}; nohup node /tmp/open-walnut/daemon.js --start > /tmp/open-walnut/daemon-start.log 2>&1 & ` +
          'sleep 2 && cat /tmp/open-walnut/daemon.port'
      }

      const output = this.sshExec(startCmd, 20_000)

      const port = parseInt(output.trim(), 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        // Read the startup log for diagnostics
        let startLog = ''
        try { startLog = this.sshExec('cat /tmp/open-walnut/daemon-start.log 2>/dev/null', 5_000) } catch {}
        throw new Error(`Invalid daemon port: "${output.trim()}". Startup log: ${startLog.slice(0, 500)}`)
      }

      log.session.info('DaemonConnection: daemon started', { host: this.hostKey, port })
      return port
    } catch (err) {
      throw new Error(`Failed to start daemon on ${this.hostKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Create an SSH tunnel from localPort to remote daemonPort.
   * Returns the local port number.
   */
  private async createTunnel(remotePort: number): Promise<number> {
    // Find a free local port
    const { createServer } = await import('node:net')
    const localPort = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })

    // Create SSH tunnel (ssh -L localPort:localhost:remotePort -N host)
    const args = [
      ...this.baseSshArgs,
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      '-N',  // No remote command — just tunnel
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      this.sshHostString,
    ]

    this.tunnel = spawn('ssh', args, {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.tunnel.unref()

    // Monitor tunnel death for auto-reconnect
    this.tunnel.on('exit', (code) => {
      log.session.warn('DaemonConnection: SSH tunnel died', {
        host: this.hostKey, code, localPort, remotePort,
      })
      this.tunnel = null
      this.handleConnectionLost()
    })

    // Wait for tunnel to be ready — poll until the local port accepts connections.
    // SSH tunnel needs time to establish the port forwarding. Fixed sleeps are unreliable.
    const tunnelReady = await this.waitForTunnel(localPort, 10_000)
    if (!tunnelReady) {
      throw new Error(`SSH tunnel created but port ${localPort} not accepting connections after 10s`)
    }

    log.session.info('DaemonConnection: SSH tunnel created', {
      host: this.hostKey, localPort, remotePort,
    })

    return localPort
  }

  /**
   * Wait for the SSH tunnel local port to accept TCP connections.
   * Polls every 200ms up to timeoutMs.
   */
  private async waitForTunnel(localPort: number, timeoutMs: number): Promise<boolean> {
    const { createConnection } = await import('node:net')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port: localPort }, () => {
          sock.destroy()
          resolve(true)
        })
        sock.on('error', () => { sock.destroy(); resolve(false) })
        sock.setTimeout(500, () => { sock.destroy(); resolve(false) })
      })
      if (ok) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  /**
   * Connect directly to a WebSocket URL, bypassing SSH deploy/tunnel.
   * Used by tests to connect RemoteSessionManager to a local MockDaemon.
   */
  async connectDirect(wsUrl: string): Promise<void> {
    if (this._connected) return
    await this.connectWebSocket(wsUrl)
    this.setConnected(true)
    this.startPing()
  }

  /**
   * Connect WebSocket through the SSH tunnel (or directly via URL).
   */
  private connectWebSocket(urlOrPort: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = typeof urlOrPort === 'string' ? urlOrPort : `ws://127.0.0.1:${urlOrPort}`
      const ws = new WebSocket(url, { handshakeTimeout: 10_000 })

      ws.on('open', () => {
        this.ws = ws
        this.lastPongAt = Date.now()
        resolve()
      })

      ws.on('error', (err) => {
        if (!this._connected) {
          reject(new Error(`WebSocket connection failed: ${err.message}`))
        } else {
          log.session.warn('DaemonConnection: WebSocket error', {
            host: this.hostKey, error: err.message,
          })
        }
      })

      ws.on('close', () => {
        if (this._connected) {
          log.session.warn('DaemonConnection: WebSocket closed', { host: this.hostKey })
          this.handleConnectionLost()
        }
      })

      ws.on('message', (data) => {
        this.handleMessage(typeof data === 'string' ? data : data.toString())
      })

      ws.on('pong', () => {
        this.lastPongAt = Date.now()
      })

      // Timeout
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timeout'))
      }, 10_000)

      ws.on('open', () => clearTimeout(timer))
    })
  }

  // ── Private: Message handling ──

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) } catch { return }

    // Command response (has 'id' field)
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingCommands.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(msg.id)
        pending.resolve(msg as unknown as DaemonCommandResult)
      }
      return
    }

    // Unsolicited event (has 'ev' field)
    if ('ev' in msg) {
      const event = msg as unknown as DaemonEvent
      for (const handler of this.eventHandlers) {
        try { handler(event) } catch {}
      }
    }
  }

  // ── Private: Reconnection ──

  private handleConnectionLost(): void {
    if (this._destroyed || !this._connected) return

    this.setConnected(false)

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }

    // Stop ping
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    log.session.info('DaemonConnection: connection lost, scheduling reconnect', {
      host: this.hostKey, delayMs: DaemonConnection.RECONNECT_DELAY_MS,
    })

    // Schedule reconnect with exponential backoff (2s → 4s → 8s → … → 60s max), forever
    this.scheduleReconnect(DaemonConnection.RECONNECT_DELAY_MS)
  }

  private scheduleReconnect(delayMs: number): void {
    if (this._destroyed || this._connected || this.reconnectTimer) return

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this._destroyed || this._connected) return
      try {
        await this.reconnect()
      } catch (err) {
        log.session.warn('DaemonConnection: reconnect failed, will retry', {
          host: this.hostKey,
          error: err instanceof Error ? err.message : String(err),
          nextDelayMs: Math.min(delayMs * 2, DaemonConnection.RECONNECT_MAX_DELAY_MS),
        })
        this.scheduleReconnect(Math.min(delayMs * 2, DaemonConnection.RECONNECT_MAX_DELAY_MS))
      }
    }, delayMs)
  }

  /**
   * Reconnect to the daemon after connection loss.
   * The daemon is still running — we just need a new tunnel + WebSocket.
   */
  private async reconnect(): Promise<void> {
    if (this._destroyed) return

    log.session.info('DaemonConnection: attempting reconnect', { host: this.hostKey })

    // Kill old tunnel if any
    if (this.tunnel) {
      try { this.tunnel.kill('SIGTERM') } catch {}
      this.tunnel = null
    }

    // Check if daemon is still running
    let daemonPort = await this.checkDaemonRunning()

    if (daemonPort === null) {
      // Daemon died — redeploy and restart
      log.session.info('DaemonConnection: daemon died, redeploying', { host: this.hostKey })
      await this.deployDaemon()
      daemonPort = await this.startDaemon()
    }

    this.remotePort = daemonPort

    // Create new tunnel
    this.localPort = await this.createTunnel(daemonPort)

    // Connect WebSocket
    await this.connectWebSocket(this.localPort)

    this.setConnected(true)
    this.startPing()

    log.session.info('DaemonConnection: reconnected', {
      host: this.hostKey, localPort: this.localPort, remotePort: daemonPort,
    })

    // Auto-recover sessions that were marked error due to disconnect
    this.recoverDisconnectedSessions().catch(() => {})
  }

  /** After successful reconnect, recover sessions marked error due to connection loss. */
  private async recoverDisconnectedSessions(): Promise<void> {
    try {
      const { listSessions, updateSessionRecord } = await import('../core/session-tracker.js')
      const { bus, EventNames } = await import('../core/event-bus.js')
      const sessions = await listSessions()

      for (const s of sessions) {
        if (s.host !== this.hostKey) continue
        if (s.process_status !== 'error') continue
        if (!s.errorMessage?.includes('Connection lost')) continue
        if (s.archived) continue

        // Ask daemon if this session's process is still alive
        try {
          const result = await this.send('status', { sid: s.claudeSessionId })
          if (result.ok && result.alive) {
            await updateSessionRecord(s.claudeSessionId, {
              process_status: 'running',
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reconnected',
              status_changed_by: 'daemon',
            } as any)
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: s.claudeSessionId,
              taskId: s.taskId,
              process_status: 'running',
            }, ['*'], { source: 'daemon-reconnect', urgency: 'urgent' })
            log.session.info('DaemonConnection: auto-recovered session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
            })
          } else {
            // Process died during disconnect — mark stopped so session is resumable.
            // Don't inject a message; user's next message will trigger --resume naturally.
            await updateSessionRecord(s.claudeSessionId, {
              process_status: 'stopped',
              errorMessage: undefined,
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'daemon_reported_exit',
              status_changed_by: 'daemon',
            } as any)
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: s.claudeSessionId,
              taskId: s.taskId,
              process_status: 'stopped',
            }, ['*'], { source: 'daemon-reconnect', urgency: 'urgent' })
            log.session.info('DaemonConnection: cleared error on dead session after reconnect', {
              sessionId: s.claudeSessionId, host: this.hostKey,
            })
          }
        } catch (err) {
          log.session.debug('DaemonConnection: failed to probe session during recovery', {
            sessionId: s.claudeSessionId, host: this.hostKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.session.warn('DaemonConnection: recoverDisconnectedSessions failed', {
        host: this.hostKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      // Detect stale connection: if no pong received for 2 ping intervals, connection is dead
      if (this.lastPongAt > 0 && Date.now() - this.lastPongAt > DaemonConnection.PING_INTERVAL_MS * 2) {
        log.session.warn('DaemonConnection: no pong received, connection stale', {
          host: this.hostKey,
          lastPongAgoMs: Date.now() - this.lastPongAt,
        })
        this.handleConnectionLost()
        return
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, DaemonConnection.PING_INTERVAL_MS)
  }
}

// ── Pool-level status change callback ──

let onPoolStatusChange: (() => void) | null = null

/**
 * Register a callback that fires whenever any DaemonConnection's
 * connected state changes.  Used by server.ts to broadcast daemon
 * status to the frontend via WebSocket.
 */
export function setOnDaemonStatusChange(cb: () => void): void {
  onPoolStatusChange = cb
}

// ── Connection Pool ──

/** Pool of DaemonConnections — one per remote host. */
const connectionPool = new Map<string, DaemonConnection>()
/** Pending connection promises — prevents concurrent connect() races. */
const connectingPromises = new Map<string, Promise<DaemonConnection>>()

/**
 * Get or create a DaemonConnection for a remote host.
 * Returns a connected connection ready for commands.
 * Thread-safe: concurrent callers share the same connect() promise.
 */
export async function getDaemonConnection(hostKey: string, sshTarget: SshTarget): Promise<DaemonConnection> {
  // Fast path: already connected
  const existing = connectionPool.get(hostKey)
  if (existing?.connected) return existing

  // Dedup: if another caller is already connecting, wait for their result
  const pending = connectingPromises.get(hostKey)
  if (pending) return pending

  // Create and connect
  let conn = connectionPool.get(hostKey)
  if (!conn) {
    conn = new DaemonConnection(hostKey, sshTarget)
    connectionPool.set(hostKey, conn)
  }

  const promise = conn.connect().then(() => {
    connectingPromises.delete(hostKey)
    return conn!
  }).catch((err) => {
    connectingPromises.delete(hostKey)
    throw err
  })

  connectingPromises.set(hostKey, promise)
  return promise
}

/**
 * Disconnect all daemon connections. Called on server shutdown.
 */
export function disconnectAllDaemons(): void {
  for (const [key, conn] of connectionPool) {
    conn.disconnect()
  }
  connectionPool.clear()
}

/** Status of a single daemon connection. */
export interface DaemonStatus {
  host: string
  connected: boolean
}

/**
 * Get status of all daemon connections.
 * Used by the health notification panel to show remote host connectivity.
 */
/**
 * Check if a daemon connection for the given host is alive.
 * Used by the unified session liveness check.
 */
export function isDaemonConnected(hostKey: string): boolean {
  return connectionPool.get(hostKey)?.connected ?? false
}

export function getDaemonDisconnectedSince(hostKey: string): number | null {
  return connectionPool.get(hostKey)?.disconnectedSince ?? null
}

export function getDaemonPoolStatus(): DaemonStatus[] {
  const result: DaemonStatus[] = []
  for (const [host, conn] of connectionPool) {
    result.push({ host, connected: conn.connected })
  }
  return result
}

/**
 * Probe a remote daemon to check if a session's process is still alive.
 * Returns { alive: true/false } if daemon is reachable, null if not connected.
 * Used by session-health-monitor to auto-recover connection-lost sessions.
 */
export async function probeDaemonSession(
  hostKey: string,
  sessionId: string,
): Promise<{ alive: boolean } | null> {
  const conn = connectionPool.get(hostKey)
  if (!conn?.connected) return null
  try {
    const result = await conn.send('status', { sid: sessionId })
    // result.ok = daemon recognized the session; result.alive = OS process is still running. Both required.
    return { alive: !!(result.ok && result.alive) }
  } catch (err) {
    log.session.debug('probeDaemonSession: status probe failed', {
      hostKey, sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

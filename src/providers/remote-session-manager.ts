/**
 * RemoteSessionManager — SessionManager implementation for remote sessions via daemon.
 *
 * Delegates all operations to a DaemonConnection (WebSocket → remote daemon).
 * The daemon manages the Claude CLI process on the remote machine.
 *
 * KEY DIFFERENCES from LocalSessionManager:
 * - No local JSONL file — daemon streams events via WebSocket, we track lastEventAt in memory
 * - No local FIFO — daemon writes to remote FIFO
 * - No PID monitoring — daemon sends exit events
 * - Image paths are rewritten (local → remote on send, remote → local on receive)
 *
 * ARCHITECTURE:
 *   Walnut → RemoteSessionManager → DaemonConnection → WebSocket → SSH tunnel → daemon
 *   daemon → Claude CLI (FIFO + JSONL monitoring) → WebSocket → Walnut
 */

import fs from 'node:fs'
import path from 'node:path'
import { REMOTE_IMAGES_DIR } from '../constants.js'
import { log } from '../logging/index.js'
import { getDaemonConnection, DaemonConnection, type DaemonEvent } from './daemon-connection.js'
import {
  findLocalImagePaths,
  findRemoteImagePaths,
  findRelativeImageNames,
} from './session-io.js'
import type { SshTarget } from './session-io.js'
import type {
  SessionManager,
  TransportStartOptions,
  TransportStartResult,
  TransportAttachOptions,
  TransportAttachResult,
} from './session-manager.js'

export class RemoteSessionManager implements SessionManager {
  private conn: DaemonConnection | null = null
  private sshTarget: SshTarget
  private hostKey: string
  private _pid: number | null = null
  private _remoteOutputFile: string | null = null
  private _hasPipe = false
  private _fileSize = 0
  private _imageCache = new Map<string, string>()
  private unsubscribeEvent: (() => void) | null = null
  private _onOutput: ((event: { line: string }) => void) | null = null
  private _onExit: ((code: number) => void) | null = null
  private _sid: string | null = null
  /**
   * Old sid kept during the async rename transition. Events may still arrive
   * from the daemon tagged with the old sid while it processes the rename command.
   * Cleared once the daemon confirms the rename is complete.
   */
  private _prevSid: string | null = null
  private _lastEventAt = 0

  readonly isRemote = true
  readonly processName = 'daemon'

  private _directWsUrl: string | undefined

  constructor(
    private tmpId: string,
    hostKey: string,
    sshTarget: SshTarget,
    directWsUrl?: string,
  ) {
    this.hostKey = hostKey
    this.sshTarget = sshTarget
    this._directWsUrl = directWsUrl
  }

  // ── Properties ──

  get pid(): number | null { return this._pid }
  /** Remote sessions have no local output file. Returns null. */
  get outputFile(): string | null { return null }
  get hasPipe(): boolean { return this._hasPipe }
  get tailOffset(): number { return this._fileSize }
  get fileSize(): number { return this._fileSize }
  get host(): string | null { return this.hostKey }
  get imageCache(): Map<string, string> { return this._imageCache }
  get lastEventAt(): number { return this._lastEventAt }

  // ── Connection ──

  /**
   * Establish connection to the daemon. Uses direct WebSocket in test mode,
   * SSH tunnel in production.
   */
  private async ensureConnected(): Promise<DaemonConnection> {
    if (this._directWsUrl) {
      this.conn = new DaemonConnection(this.hostKey, this.sshTarget)
      await this.conn.connectDirect(this._directWsUrl)
    } else {
      this.conn = await getDaemonConnection(this.hostKey, this.sshTarget)
    }
    return this.conn
  }

  // ── Startup ──

  async start(opts: TransportStartOptions): Promise<TransportStartResult> {
    await this.ensureConnected()

    // Subscribe to daemon events (clean up any leaked listener from a prior start/resume)
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
      this.unsubscribeEvent = null
    }
    this._onOutput = opts.onOutput
    this._onExit = opts.onExit
    this._sid = this.tmpId
    this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))

    // Upload local images to remote host and rewrite paths before sending
    const preparedMessage = await this.prepareOutbound(opts.message)

    const result = await this.conn.send('start', {
      sid: this.tmpId,
      args: ['claude', ...opts.args],
      cwd: opts.cwd,
      message: preparedMessage,
      resume: opts.resume ?? false,
    })

    if (!result.ok) {
      throw new Error(`Daemon start failed: ${result.error}`)
    }

    this._pid = (result.pid as number) ?? null
    this._remoteOutputFile = result.outputFile as string ?? null
    this._hasPipe = true

    // Capture initial file size (for resume offset tracking)
    const fileSize = (result.offset as number) ?? 0
    this._fileSize = fileSize

    log.session.info('RemoteSessionManager: session started', {
      host: this.hostKey,
      sid: this.tmpId,
      pid: this._pid,
      resume: opts.resume,
    })

    return {
      pid: this._pid!,
      // Remote sessions use a sentinel path — not a real local file.
      // Callers should check isRemote before attempting file I/O.
      outputFile: `remote://${this.hostKey}/${this._sid}`,
      fileSize,
    }
  }

  // ── Attach ──

  async attach(opts: TransportAttachOptions): Promise<TransportAttachResult> {
    await this.ensureConnected()

    // Clean up any leaked listener from a prior attach/start
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
      this.unsubscribeEvent = null
    }
    this._onOutput = opts.onOutput
    this._onExit = opts.onExit
    this._sid = opts.sessionId
    this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))

    const result = await this.conn!.send('attach', {
      sid: opts.sessionId,
      fromOffset: opts.fromOffset ?? 0,
    })

    if (!result.ok) {
      throw new Error(`Daemon attach failed: ${result.error}`)
    }

    this._pid = (result.pid as number) ?? null
    const alive = (result.alive as boolean) ?? false

    log.session.info('RemoteSessionManager: attached to session', {
      host: this.hostKey,
      sid: opts.sessionId,
      pid: this._pid,
      alive,
    })

    return {
      pid: this._pid ?? 0,
      alive,
      outputFile: `remote://${this.hostKey}/${this._sid}`,
    }
  }

  // ── Messaging ──

  writeMessage(message: string): boolean {
    // hasPipe is cleared when the daemon reports process exit. Without this check,
    // writeMessage optimistically returns true but the daemon's FIFO write fails
    // silently → message lost → caller never gets a result → timeout.
    if (!this.conn?.connected || !this._sid || !this._hasPipe) return false

    // Fire-and-forget: upload local images then send rewritten message via daemon
    this.prepareOutbound(message).then((prepared) => {
      return this.conn!.send('send', { sid: this._sid, message: prepared })
    }).then((result) => {
      if (!result.ok) {
        log.session.warn('RemoteSessionManager: send failed', {
          host: this.hostKey, sid: this._sid, reason: result.reason || result.error,
        })
      }
    }).catch((err) => {
      log.session.warn('RemoteSessionManager: send error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
    })

    return true // Optimistic — actual delivery status comes via daemon events
  }

  writeSyntheticUserEvent(_message: string, _walnutMessageId: string): void {
    // No-op for remote sessions.
    // Synthetic user events were only written to the local mirror file for chat history replay.
    // With no local mirror, the session-chat.ts real-time stream already handles display.
    // The canonical JSONL on the remote host is the source of truth for history.
  }

  // ── Process Control ──

  async stop(): Promise<void> {
    if (!this.conn?.connected || !this._sid) return

    try {
      await this.conn.send('stop', { sid: this._sid })
    } catch (err) {
      log.session.warn('RemoteSessionManager: stop error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  kill(): void {
    if (!this.conn?.connected || !this._sid) return

    // Fire-and-forget
    this.conn.send('stop', { sid: this._sid }).catch(() => {})
    this._hasPipe = false
  }

  async interrupt(): Promise<void> {
    this._hasPipe = false
    await this.stop()
  }

  async isAlive(): Promise<boolean> {
    if (!this._sid) return false

    // Disconnected ≠ dead. Short disconnects (< 5min) → assume alive, wait for reconnect.
    // Long disconnects (> 5min) → let health monitor mark error.
    if (!this.conn?.connected) {
      const since = this.conn?.disconnectedSince
      if (since && (Date.now() - since) > 5 * 60 * 1000) {
        return false // exceeded grace period
      }
      return true // short disconnect — assume process is still alive
    }

    try {
      const result = await this.conn.send('status', { sid: this._sid })
      return result.ok === true && result.alive === true
    } catch {
      return true // send failed (possibly reconnecting) — assume alive
    }
  }

  // ── Session Management ──

  renameForSession(sessionId: string): void {
    if (!this._sid || this._sid === sessionId) return

    const oldSid = this._sid
    this._prevSid = oldSid  // Keep old sid for event matching during async rename
    this._sid = sessionId

    // Rename remote files via daemon.
    // IMPORTANT: Do NOT clear _prevSid on rename completion. The daemon may still
    // emit events with the old sid for in-flight JSONL lines that were queued before
    // the rename was processed. _prevSid is kept for the lifetime of this manager
    // to ensure no events are dropped during the rename transition.
    if (this.conn?.connected) {
      this.conn.send('rename', { oldSid, newSid: sessionId }).catch((err) => {
        log.session.warn('RemoteSessionManager: rename failed', {
          host: this.hostKey, oldSid, newSid: sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  detach(): void {
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
      this.unsubscribeEvent = null
    }
    this._onOutput = null
    this._onExit = null
  }

  async cleanup(): Promise<void> {
    this.detach()
  }

  deletePipe(): void {
    this._hasPipe = false
  }

  // ── Message Processing ──

  async prepareOutbound(message: string): Promise<string> {
    // Upload local images to remote host via daemon
    const localPaths = findLocalImagePaths(message)
    if (localPaths.length === 0) return message

    if (!this.conn?.connected) return message

    let rewritten = message
    for (const localPath of localPaths) {
      try {
        const data = fs.readFileSync(localPath)
        const remotePath = `/tmp/open-walnut-images/${path.basename(localPath)}`

        await this.conn.send('fs.write', {
          path: remotePath,
          data: data.toString('base64'),
          encoding: 'base64',
        })

        rewritten = rewritten.split(localPath).join(remotePath)
      } catch (err) {
        log.session.warn('RemoteSessionManager: image upload failed', {
          localPath, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return rewritten
  }

  processInbound(text: string, sessionId: string, cwd?: string): string {
    // Download remote images and rewrite paths to local
    const remotePaths = findRemoteImagePaths(text)
    let rewritten = text
    const localHome = process.env.HOME || '/root'

    for (const remotePath of remotePaths) {
      // Skip local paths
      if (remotePath.startsWith(localHome) || remotePath.startsWith(REMOTE_IMAGES_DIR)) continue

      let localPath = this._imageCache.get(remotePath)
      if (!localPath) {
        localPath = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(remotePath))
        this._imageCache.set(remotePath, localPath)

        if (!fs.existsSync(localPath)) {
          // Download via daemon fs.read (fire-and-forget)
          this.downloadRemoteFile(remotePath, localPath).catch(() => {})
        }
      }
      rewritten = rewritten.split(remotePath).join(localPath)
    }

    // Handle relative image names
    if (cwd) {
      const relNames = findRelativeImageNames(rewritten)
      for (const relName of relNames) {
        const basename = path.basename(relName)
        const cwdPath = `${cwd.replace(/\/$/, '')}/${relName}`

        if (this._imageCache.has(cwdPath)) continue

        let localPath = this._imageCache.get(`rel:${relName}`)
        if (!localPath) {
          localPath = path.join(REMOTE_IMAGES_DIR, sessionId, basename)
          this._imageCache.set(`rel:${relName}`, localPath)

          if (!fs.existsSync(localPath)) {
            this.downloadRemoteFile(cwdPath, localPath).catch(() => {})
          }
        }

        const escaped = relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nameRe = new RegExp(`(?<=^|[\\s"'\`=:(])${escaped}(?=[\\s"'\`),;\\]}]|$)`, 'g')
        rewritten = rewritten.replace(nameRe, () => localPath!)
      }
    }

    return rewritten
  }

  // ── Streaming Control ──

  flushTail(): void {
    // No-op for daemon — events are already delivered via WebSocket
  }

  stopTail(): void {
    // No-op — handled by detach/unsubscribe
  }

  // ── Private ──

  private handleDaemonEvent(event: DaemonEvent): void {
    if (!this._sid) return

    switch (event.ev) {
      case 'jsonl':
        if ((event.sid === this._sid || event.sid === this._prevSid) && event.line) {
          this._lastEventAt = Date.now()
          this._fileSize += Buffer.byteLength(event.line + '\n', 'utf-8')

          // Forward to handler
          this._onOutput?.({ line: event.line })
        }
        break

      case 'exit':
        if (event.sid === this._sid || event.sid === this._prevSid) {
          this._lastEventAt = Date.now()
          this._hasPipe = false
          this._onExit?.(event.code ?? 1)
        }
        break

      case 'agent':
        // Subagent events — forward as-is (handled by session-chat.ts)
        break
    }
  }

  /**
   * Download a file from the remote host via daemon fs.read.
   */
  private async downloadRemoteFile(remotePath: string, localPath: string): Promise<void> {
    if (!this.conn?.connected) return

    try {
      const dir = path.dirname(localPath)
      fs.mkdirSync(dir, { recursive: true })

      const result = await this.conn.send('fs.read', { path: remotePath, encoding: 'base64' })
      if (result.ok && result.data) {
        const buf = Buffer.from(result.data as string, 'base64')
        fs.writeFileSync(localPath, buf)
      }
    } catch (err) {
      log.session.warn('RemoteSessionManager: file download failed', {
        remotePath, localPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// Re-export for convenience
export { findLocalImagePaths, findRemoteImagePaths, findRelativeImageNames }

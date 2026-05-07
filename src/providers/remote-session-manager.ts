/**
 * RemoteSessionManager — SessionManager implementation for remote sessions via daemon.
 *
 * Delegates all operations to a DaemonConnection (WebSocket → remote daemon).
 * The daemon manages the Claude CLI process on the remote machine.
 *
 * KEY DIFFERENCES from a hypothetical local-only manager:
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
  private sshTarget: SshTarget | null
  private hostKey: string
  private _pid: number | null = null
  private _remoteOutputFile: string | null = null
  private _hasPipe = false
  private _fileSize = 0
  private _imageCache = new Map<string, string>()
  private unsubscribeEvent: (() => void) | null = null
  private _onOutput: ((event: { line: string }) => void) | null = null
  private _onExit: ((code: number, stderr?: string) => void) | null = null
  private _sid: string | null = null
  /**
   * Old sid kept during the async rename transition. Events may still arrive
   * from the daemon tagged with the old sid while it processes the rename command.
   * Cleared once the daemon confirms the rename is complete.
   */
  private _prevSid: string | null = null
  private _lastEventAt = 0
  // UUIDs of JSONL events already delivered to downstream. Used to dedup
  // events arriving via two paths — the daemon's realtime push, or any
  // future catch-up / resync mechanism (daemon's attach replay, full
  // periodic pull). Claude Code assigns each message a uuid in its JSONL
  // output; collisions across different sources are intentional (same
  // logical event). No uuid (e.g. `system.init` synthesized by daemon or
  // walnut) means always deliver.
  private _seenUuids: Set<string> = new Set()

  get isRemote(): boolean { return this.hostKey !== '__local__' }
  readonly processName = 'daemon'

  private _directWsUrl: string | undefined

  constructor(
    private tmpId: string,
    hostKey: string,
    sshTarget: SshTarget | null,
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
   * Establish connection to the daemon. Uses direct WebSocket for local daemon
   * or test mode, SSH tunnel for remote production hosts.
   */
  private async ensureConnected(): Promise<DaemonConnection> {
    if (this._directWsUrl) {
      this.conn = new DaemonConnection(this.hostKey, this.sshTarget)
      await this.conn.connectDirect(this._directWsUrl)
    } else if (this.sshTarget) {
      this.conn = await getDaemonConnection(this.hostKey, this.sshTarget)
    } else {
      throw new Error(`RemoteSessionManager: no directWsUrl and no sshTarget for host "${this.hostKey}"`)
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

    // Quick Start spill file: upload to the same absolute path on the remote host
    // before the session starts. The message already references this path as a
    // pointer prompt, so no rewrite is needed. Failure here is fatal — the session
    // would otherwise launch with Claude unable to Read the referenced context.
    // Skip for local daemon — same filesystem, file already exists at that path.
    if (opts.spillFile && this.isRemote) {
      await this.uploadSpillFile(opts.spillFile.localPath)
    }

    // Upload local images to remote host and rewrite paths before sending
    const preparedMessage = await this.prepareOutbound(opts.message)

    const startPayload = {
      sid: this.tmpId,
      args: ['claude', ...opts.args],
      cwd: opts.cwd,
      message: preparedMessage,
      resume: opts.resume ?? false,
      mode: opts.mode,
    }

    let result: Record<string, unknown>
    try {
      result = await this.conn!.send('start', startPayload)
    } catch (err) {
      // Stale/dead connection — reconnect and retry with idempotent probe
      if (isDaemonConnError(err)) {
        log.session.warn('RemoteSessionManager: start failed, reconnecting', {
          host: this.hostKey, sid: this.tmpId,
          error: err instanceof Error ? err.message : String(err),
        })
        result = await this.retryStartAfterReconnect(startPayload)
      } else {
        throw err
      }
    }

    if (!result.ok) {
      throw new Error(`Daemon start failed on host "${this.hostKey}": ${result.error}`)
    }

    // Detect spawn failures: daemon returns ok but pid is missing when
    // posix_spawn fails (e.g. cwd doesn't exist on remote host).
    if (!result.pid) {
      throw new Error(`Daemon spawn failed on host "${this.hostKey}": no PID returned (cwd: "${opts.cwd}"). The working directory may not exist on the remote host.`)
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

  /**
   * Reconnect and retry start with idempotent probe — checks if daemon already
   * started the session (response lost on stale connection) before re-spawning.
   */
  private async retryStartAfterReconnect(
    startPayload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Clear local reference — do NOT disconnect() the shared pool connection.
    // disconnect() sets _destroyed=true which permanently kills auto-reconnect.
    // The pool's getDaemonConnection() will reconnect if needed.
    this.conn = null
    await this.ensureConnected()

    // Re-subscribe event listener on the fresh connection
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
    }
    this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))

    // Idempotent probe: check if daemon already started this sid
    const sid = startPayload.sid as string
    try {
      const status = await this.conn!.send('status', { sid })
      if (status.ok && status.exists && status.alive) {
        log.session.info('RemoteSessionManager: session already alive after reconnect, attaching', {
          host: this.hostKey, sid, pid: status.pid,
        })
        // Session was started by the lost command — attach instead of re-starting.
        // Use tracked _fileSize so we skip already-processed bytes and avoid replaying
        // the entire JSONL (which causes duplicate content blocks → repeated text in UI).
        // _fileSize === 0 means no bytes were delivered yet, so fromOffset 0 replays all — correct.
        const attachResult = await this.conn!.send('attach', { sid, fromOffset: this._fileSize || 0 })
        // Merge pid from status into attach result for consistent return shape
        return { ...attachResult, pid: status.pid, outputFile: status.outputFile, offset: this._fileSize || 0 }
      }
    } catch {
      // Status probe failed — daemon may not know this session, safe to retry start
    }

    // Session doesn't exist on daemon — safe to retry start
    log.session.info('RemoteSessionManager: retrying start after reconnect', {
      host: this.hostKey, sid,
    })
    return this.conn!.send('start', startPayload)
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

    const attachPayload = {
      sid: opts.sessionId,
      fromOffset: opts.fromOffset ?? 0,
      mode: opts.mode,
    }

    let result: Record<string, unknown>
    try {
      result = await this.conn!.send('attach', attachPayload)
    } catch (err) {
      // Stale/dead connection — reconnect and retry (attach is idempotent)
      if (isDaemonConnError(err)) {
        log.session.warn('RemoteSessionManager: attach failed, reconnecting', {
          host: this.hostKey, sid: opts.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Clear local reference — do NOT disconnect() the shared pool connection.
        // disconnect() sets _destroyed=true which permanently kills auto-reconnect.
        // The pool's getDaemonConnection() will reconnect if needed.
        this.conn = null
        await this.ensureConnected()
        if (this.unsubscribeEvent) this.unsubscribeEvent()
        this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))
        result = await this.conn!.send('attach', attachPayload)
      } else {
        throw err
      }
    }

    if (!result.ok) {
      throw new Error(`Daemon attach failed on host "${this.hostKey}": ${result.error}`)
    }

    this._pid = (result.pid as number) ?? null
    const alive = (result.alive as boolean) ?? false

    log.session.info('RemoteSessionManager: attached to session', {
      host: this.hostKey,
      sid: opts.sessionId,
      pid: this._pid,
      alive,
    })

    const pendingCtrl = result.pendingCtrl as { reqId: string; toolName: string; request: Record<string, unknown>; receivedAt: number } | null | undefined

    return {
      pid: this._pid ?? 0,
      alive,
      outputFile: `remote://${this.hostKey}/${this._sid}`,
      pendingCtrl: pendingCtrl ?? null,
    }
  }

  // ── Re-attach after daemon reconnect ──
  //
  // When the SSH tunnel / daemon WebSocket drops, the daemon's close handler
  // calls stopWatching() for every session this connection was watching (see
  // daemon-source.ts:1438). After reconnect, the daemon has no watcher for
  // this session's JSONL file, so newly-produced events never reach walnut —
  // `_lastEventAt` stops advancing, and SessionHealthMonitor eventually kills
  // the session even though the CLI is still producing output remotely.
  //
  // Call this on every successful reconnect to tell the daemon "I want JSONL
  // events for <sid> again, starting from byte offset X". The daemon's
  // cmdAttach will installStartWatching(ws, sid, offset) → new watcher for
  // the new ws. The onEvent listener is also re-bound to the new connection
  // so JSONL events reach this.handleDaemonEvent() again.
  async reattachWatcher(): Promise<boolean> {
    if (!this._sid || !this._onOutput) return false
    try {
      await this.ensureConnected()
      // Rebind event listener on the (possibly new) DaemonConnection instance.
      if (this.unsubscribeEvent) {
        this.unsubscribeEvent()
        this.unsubscribeEvent = null
      }
      this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))

      // Resume from the last byte walnut has processed — avoids replaying
      // content the UI has already rendered (would cause duplicate blocks).
      const result = await this.conn!.send('attach', {
        sid: this._sid,
        fromOffset: this._fileSize || 0,
      })
      if (result.ok) {
        log.session.info('RemoteSessionManager: reattached watcher after reconnect', {
          host: this.hostKey, sid: this._sid, fromOffset: this._fileSize || 0,
        })
        return true
      }
      log.session.warn('RemoteSessionManager: reattach failed', {
        host: this.hostKey, sid: this._sid, error: result.error,
      })
      return false
    } catch (err) {
      log.session.warn('RemoteSessionManager: reattach exception', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  // ── Messaging ──

  async writeMessage(message: string): Promise<boolean> {
    // Strict ack: we await the daemon's `cmdSend` reply and return false on any
    // failure (FIFO write ENXIO/EAGAIN, session not found, transport error).
    // Caller (SessionRunner.processNext) takes the false and falls through to
    // gracefulStop + --resume respawn, so the current message is not drained
    // from the queue until delivery is truly confirmed. Previously this method
    // returned true optimistically and the fire-and-forget daemon reply only
    // logged a warning — any ENXIO silently lost the message.
    if (!this.conn?.connected || !this._sid) return false

    // Capture conn/sid synchronously — they may change during the async image upload
    // (e.g. renameForSession(), detach(), or a concurrent start() call).
    const conn = this.conn
    const sid = this._sid

    try {
      const prepared = await this.prepareOutbound(message)
      const result = await conn.send('send', { sid, message: prepared })
      if (result.ok) {
        // Bump lastEventAt on successful delivery. Without this, the
        // SessionHealthMonitor idle-timeout check (default 30 min) uses a
        // stale last-JSONL-event timestamp and can kill a session that was
        // idle for >30 min but just received a fresh user message — the
        // remote CLI is actively working on the new turn, but health monitor
        // sees no inbound JSONL event yet and assumes the session is dead.
        // (Local sessions don't hit this because their lastEventAt is derived
        // from file mtime, and the FIFO write updates the file.)
        this._lastEventAt = Date.now()
        return true
      }

      const reason = String(result.reason || result.error || '')
      log.session.warn('RemoteSessionManager: send failed', {
        host: this.hostKey, sid, reason,
      })
      // FIFO write failed — CLI process is dead or pipe is broken.
      // Fire onExit once per transport death so downstream cleanup runs; the
      // `_hasPipe` flag guards against double-fire if the daemon already pushed
      // an `exit` event. Returning false (below) is independent of that guard
      // so a stopped session still gets respawned on the next send.
      if (reason.includes('not found') || reason === 'ENXIO' || reason === 'EAGAIN') {
        if (this._hasPipe) {
          this._hasPipe = false
          this._onExit?.(1)
        }
      }
      return false
    } catch (err) {
      log.session.warn('RemoteSessionManager: send error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  async writeRaw(json: string): Promise<boolean> {
    // control_response for --permission-prompt-tool stdio. Routed through the
    // daemon's `sendRaw` command (daemon-core.handleSendRawCommand), which
    // writes the line to the session FIFO without the `{type:"user",...}`
    // wrapping that cmdSend applies.
    if (!this.conn?.connected || !this._sid) return false
    const conn = this.conn
    const sid = this._sid
    try {
      const result = await conn.send('sendRaw', { sid, raw: json })
      if (result.ok) return true
      const reason = String(result.reason || result.error || '')
      log.session.warn('RemoteSessionManager: writeRaw failed', {
        host: this.hostKey, sid, reason,
      })
      if (reason.includes('not found') || reason === 'ENXIO' || reason === 'EAGAIN') {
        if (this._hasPipe) {
          this._hasPipe = false
          this._onExit?.(1)
        }
      }
      return false
    } catch (err) {
      log.session.warn('RemoteSessionManager: writeRaw error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  writeSyntheticUserEvent(_message: string, _walnutMessageId: string): void {
    // No-op for remote sessions.
    // Synthetic user events were only written to the local mirror file for chat history replay.
    // With no local mirror, the session-chat.ts real-time stream already handles display.
    // The canonical JSONL on the remote host is the source of truth for history.
  }

  async setMode(mode: string): Promise<boolean> {
    if (!this.conn?.connected || !this._sid) return false
    try {
      const result = await this.conn.send('setMode', { sid: this._sid, mode })
      return result.ok === true
    } catch {
      return false
    }
  }

  // ── Process Control ──

  async stop(): Promise<void> {
    if (!this.conn?.connected || !this._sid) {
      log.session.info('RemoteSessionManager.stop: skipped', {
        host: this.hostKey, sid: this._sid,
        connConnected: !!this.conn?.connected, hasSid: !!this._sid,
      })
      return
    }

    log.session.info('RemoteSessionManager.stop: sending stop cmd to daemon', { host: this.hostKey, sid: this._sid })
    try {
      const result = await this.conn.send('stop', { sid: this._sid })
      log.session.info('RemoteSessionManager.stop: daemon acked', {
        host: this.hostKey, sid: this._sid, result,
      })
    } catch (err) {
      log.session.warn('RemoteSessionManager: stop error', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  kill(): void {
    if (!this.conn?.connected || !this._sid) {
      log.session.info('RemoteSessionManager.kill: skipped', {
        host: this.hostKey, sid: this._sid,
        connConnected: !!this.conn?.connected, hasSid: !!this._sid,
      })
      return
    }

    log.session.info('RemoteSessionManager.kill: sending stop cmd to daemon (fire-and-forget)', {
      host: this.hostKey, sid: this._sid,
    })
    // Fire-and-forget — but log the outcome so we can tell if daemon actually received it
    this.conn.send('stop', { sid: this._sid })
      .then(result => log.session.info('RemoteSessionManager.kill: daemon acked', {
        host: this.hostKey, sid: this._sid, result,
      }))
      .catch(err => log.session.warn('RemoteSessionManager.kill: daemon error', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      }))
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
    // Local daemon: same filesystem — no path rewriting needed
    if (!this.isRemote) return message
    if (!this.conn?.connected) return message

    let rewritten = message

    // Upload local images to remote host via daemon (path rewritten to remote location)
    const imagePaths = findLocalImagePaths(message)
    for (const localPath of imagePaths) {
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

  /**
   * Upload a Quick Start spill file to the remote host at the same absolute path.
   * Both local and remote use /tmp/ so the path identity holds. Throws on failure
   * — callers (start()) treat a missing spill file as fatal because Claude's
   * pointer prompt references it.
   */
  private async uploadSpillFile(localPath: string): Promise<void> {
    if (!this.conn?.connected) {
      throw new Error(`Cannot upload spill file: daemon not connected (host "${this.hostKey}")`)
    }
    const data = fs.readFileSync(localPath)
    await this.conn.send('fs.write', {
      path: localPath,
      data: data.toString('base64'),
      encoding: 'base64',
    })
    log.session.info('RemoteSessionManager: uploaded spill file to remote', {
      path: localPath, size: data.length, host: this.hostKey,
    })
  }

  processInbound(text: string, sessionId: string, cwd?: string): string {
    // Local daemon: same filesystem — no path rewriting needed
    if (!this.isRemote) return text

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
          this._fileSize += Buffer.byteLength(event.line + '\n', 'utf-8') // feeds fromOffset in retryStartAfterReconnect()

          // UUID-based dedup. The daemon's cmdAttach catch-up may replay
          // bytes that were already delivered via realtime push before a
          // tunnel flap; and any future fullResync path will also replay.
          // Skip lines whose uuid we've already forwarded. Lines without a
          // uuid (e.g. system/init) always pass through — they're rare and
          // usually idempotent at the UI layer anyway.
          try {
            const parsed = JSON.parse(event.line) as { uuid?: unknown }
            const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null
            if (uuid) {
              if (this._seenUuids.has(uuid)) {
                return
              }
              this._seenUuids.add(uuid)
            }
          } catch {
            // Non-JSON or malformed line — pass through. Downstream parser
            // will log and skip; we don't second-guess it.
          }

          // Forward to handler
          this._onOutput?.({ line: event.line })
        }
        break

      case 'exit':
        if (event.sid === this._sid || event.sid === this._prevSid) {
          this._lastEventAt = Date.now()
          this._hasPipe = false
          this._onExit?.(event.code ?? 1, event.stderr)
        }
        break

      case 'session_state':
        // Daemon-authoritative state broadcast (running | dead). On dead,
        // fire onExit so the session runner transitions to stopped. This is
        // a backstop for cases where the `exit` event is lost (rare) and also
        // the single entry point for daemon-side reap detection (idle scan,
        // reconcile, ENXIO pre-check, orphan poll).
        if (event.sid === this._sid || event.sid === this._prevSid) {
          const state = event.state as string | undefined
          if (state === 'dead') {
            this._lastEventAt = Date.now()
            if (this._hasPipe) {
              this._hasPipe = false
              this._onExit?.((event.exitCode as number | undefined) ?? 1)
            }
          }
        }
        break

      case 'stderr_tail':
        // Emitted by daemon on every `result` JSONL record. Log-only for now —
        // grep this when a stuck/empty-result turn happens to see what the remote
        // Claude CLI wrote to stderr (MCP init errors, validation failures, etc).
        if ((event.sid === this._sid || event.sid === this._prevSid) && typeof event.tail === 'string') {
          log.session.info('RemoteSessionManager: CLI stderr tail', {
            sessionId: this._sid, sid: event.sid, tail: event.tail,
          })
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

// ── Helpers ──

/** Match daemon connection errors that are worth retrying after reconnect. */
function isDaemonConnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message
  return msg.includes('daemon command timeout') || msg.includes('not connected')
}

// Re-export for convenience
export { findLocalImagePaths, findRemoteImagePaths, findRelativeImageNames }

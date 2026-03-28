/**
 * LocalSessionManager — SessionManager implementation for local sessions.
 *
 * Wraps the existing LocalIO class and local spawn logic from ClaudeCodeSession.
 * The Claude CLI process runs on the local machine with:
 *   - stdin: named FIFO (for follow-up messages)
 *   - stdout: JSONL file (tailed for real-time streaming)
 *   - stderr: error file (for diagnostics)
 *
 * DESIGN: This is a thin adapter over LocalIO. It does NOT duplicate
 * LocalIO's file management — it delegates to it. The spawn logic
 * is extracted from ClaudeCodeSession.send() (local branch).
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { LocalIO } from './session-io.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { log } from '../logging/index.js'
import type {
  SessionManager,
  TransportStartOptions,
  TransportStartResult,
  TransportAttachOptions,
  TransportAttachResult,
} from './session-manager.js'

export class LocalSessionManager implements SessionManager {
  private io: LocalIO
  private _pid: number | null = null
  private _outputFile: string | null = null
  private _imageCache = new Map<string, string>()
  /** CLI command to use for spawning (default: 'claude') */
  private cliCommand: string

  readonly host = null
  readonly isRemote = false

  constructor(tmpId: string, outputFileOverride?: string, cliCommand?: string) {
    this.io = new LocalIO(tmpId, outputFileOverride)
    this.cliCommand = cliCommand ?? 'claude'
    this._outputFile = this.io.outputFile
  }

  // ── Properties ──

  get pid(): number | null { return this._pid }
  get outputFile(): string | null { return this._outputFile }
  get hasPipe(): boolean { return this.io.hasPipe }
  get tailOffset(): number { return this.io.tailOffset }
  get fileSize(): number { return this.io.fileSize }
  get processName(): string { return this.io.processName }
  get imageCache(): Map<string, string> { return this._imageCache }

  /**
   * Last activity time derived from output file mtime.
   * Called on every health check cycle (~30s). Acceptable since local files
   * are on the same filesystem and statSync is fast for local paths.
   */
  get lastEventAt(): number {
    if (!this._outputFile) return 0
    try { return fs.statSync(this._outputFile).mtimeMs } catch { return 0 }
  }

  // ── Startup ──

  async start(opts: TransportStartOptions): Promise<TransportStartResult> {
    const isResume = opts.resume === true && !opts.fork

    // Create FIFO + output files
    const { pipeFd, outputFd, stderrFd } = this.io.createFiles(isResume)

    // Capture file size before spawn (for resume offset tracking)
    const fileSizeBeforeSpawn = isResume ? this.io.fileSize : 0

    // Build clean env: remove CLAUDECODE to prevent nested detection
    const { CLAUDECODE: _drop, ...cleanEnv } = process.env

    // Spawn the local Claude CLI process
    const proc = spawn(this.cliCommand, opts.args, {
      detached: true,
      stdio: [pipeFd, outputFd, stderrFd],
      cwd: opts.cwd || process.cwd(),
      env: { ...cleanEnv, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    })

    // Write initial message to FIFO and close parent fd
    this.io.writeInitialMessage(pipeFd, opts.message)

    // Close fds in parent — child inherited copies
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)

    this._pid = proc.pid ?? null
    this._outputFile = this.io.outputFile
    proc.unref()

    log.session.info('LocalSessionManager: session spawned (detached, FIFO stdin)', {
      pid: proc.pid,
      outputFile: this.io.outputFile,
      hasPipe: this.io.hasPipe,
      resume: isResume,
      fork: opts.fork,
    })

    // Handle spawn errors
    proc.on('error', (err) => {
      log.session.error('LocalSessionManager: spawn error', { error: err.message })
    })

    // Capture exit code and invoke onExit callback
    proc.on('exit', (code) => {
      opts.onExit(code ?? 1)
    })

    // Start tailing from the correct offset
    const tailFromOffset = isResume ? fileSizeBeforeSpawn : 0
    this.io.startTail((line) => opts.onOutput({ line }), tailFromOffset)

    return {
      pid: this._pid!,
      outputFile: this.io.outputFile,
      fileSize: fileSizeBeforeSpawn,
    }
  }

  // ── Attach ──

  async attach(opts: TransportAttachOptions): Promise<TransportAttachResult> {
    // Recover FIFO pipe from disk (survives server restart)
    this.io.recoverPipe(opts.sessionId)

    const offset = opts.fromOffset ?? this.io.fileSize
    this.io.startTail((line) => opts.onOutput({ line }), offset)

    // Check if the process is alive
    // We don't have a PID here — the caller should set it from the session record
    const alive = this._pid !== null && await isProcessAliveAsync(this._pid, 'claude')

    return {
      pid: this._pid ?? 0,
      alive,
      outputFile: this.io.outputFile,
    }
  }

  /**
   * Set the PID externally (e.g. from session record during attach).
   * This is needed because attach() doesn't spawn — it reconnects to an existing process.
   */
  setPid(pid: number): void {
    this._pid = pid
  }

  // ── Messaging ──

  async writeMessage(message: string): Promise<boolean> {
    return await this.io.write(message)
  }

  writeSyntheticUserEvent(message: string, walnutMessageId: string): void {
    const outputFile = this._outputFile
    if (!outputFile) return
    const event = JSON.stringify({
      type: 'user',
      subtype: 'walnut-injected',
      message: { role: 'user', content: message },
      walnutMessageId,
      timestamp: new Date().toISOString(),
    })
    fsp.appendFile(outputFile, event + '\n').catch((err) => {
      log.session.debug('LocalSessionManager: writeSyntheticUserEvent failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // ── Process Control ──

  async stop(): Promise<void> {
    if (this._pid === null) return
    if (!await isProcessAliveAsync(this._pid, 'claude')) return

    log.session.info('LocalSessionManager: gracefulStop SIGINT', { pid: this._pid })

    // Phase 1: SIGINT — 5s grace period for Claude CLI to finish its on-stop hook
    // (save conversation, write result event, flush JSONL)
    try { process.kill(this._pid, 'SIGINT') } catch { return }

    const deadline1 = Date.now() + 5_000
    while (Date.now() < deadline1 && await isProcessAliveAsync(this._pid, 'claude')) {
      await new Promise(r => setTimeout(r, 200))
    }

    // Phase 2: SIGTERM fallback — 2s grace period (process is unresponsive to SIGINT)
    if (await isProcessAliveAsync(this._pid, 'claude')) {
      log.session.warn('LocalSessionManager: SIGINT timeout, sending SIGTERM', { pid: this._pid })
      try { process.kill(this._pid, 'SIGTERM') } catch { return }
      const deadline2 = Date.now() + 2_000
      while (Date.now() < deadline2 && await isProcessAliveAsync(this._pid, 'claude')) {
        await new Promise(r => setTimeout(r, 200))
      }
    }

    // 300ms buffer for child process cleanup (fd close, temp file removal)
    await new Promise(r => setTimeout(r, 300))
  }

  kill(): void {
    this.io.deletePipe()
    if (this._pid !== null) {
      try { process.kill(this._pid, 'SIGTERM') } catch { /* already dead */ }
    }
  }

  async interrupt(): Promise<void> {
    this.io.deletePipe()

    if (this._pid !== null) {
      // Phase 1: SIGINT
      try { process.kill(this._pid, 'SIGINT') } catch { /* dead */ }

      const deadline1 = Date.now() + 5_000
      while (Date.now() < deadline1 && await isProcessAliveAsync(this._pid, 'claude')) {
        await new Promise(r => setTimeout(r, 200))
      }

      // Phase 2: SIGTERM
      if (await isProcessAliveAsync(this._pid, 'claude')) {
        try { process.kill(this._pid, 'SIGTERM') } catch { /* dead */ }
        const deadline2 = Date.now() + 3_000
        while (Date.now() < deadline2 && await isProcessAliveAsync(this._pid, 'claude')) {
          await new Promise(r => setTimeout(r, 200))
        }
      }

      await new Promise(r => setTimeout(r, 500))
    }
  }

  async isAlive(): Promise<boolean> {
    if (this._pid === null) return false
    return isProcessAliveAsync(this._pid, 'claude')
  }

  // ── Session Management ──

  renameForSession(sessionId: string): void {
    this.io.renameForSession(sessionId)
    this._outputFile = this.io.outputFile
  }

  detach(): void {
    this.io.stopTail()
  }

  async cleanup(): Promise<void> {
    await this.io.cleanup()
  }

  deletePipe(): void {
    this.io.deletePipe()
  }

  // ── Message Processing ──

  async prepareOutbound(message: string): Promise<string> {
    // Local sessions: no image transfer needed
    return message
  }

  processInbound(text: string, _sessionId: string, _cwd?: string): string {
    // Local sessions: no image rewriting needed
    return text
  }

  // ── Streaming Control ──

  flushTail(): void {
    this.io.flushTail()
  }

  stopTail(): void {
    this.io.stopTail()
  }
}

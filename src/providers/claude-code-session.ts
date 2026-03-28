/**
 * Claude Code Session — event-bus-driven, crash-resilient proxy to `claude -p`.
 *
 * ARCHITECTURE NOTE:
 * This is the ONLY provider that spawns Claude Code CLI processes.
 * The main agent (open-walnut's "brain") uses Bedrock SDK directly via agent/model.ts.
 * This file manages delegated coding sessions — long-running claude -p workers
 * that execute tasks in the background, returning results via the event bus.
 *
 * DETACHED MODE:
 * Sessions are spawned detached with stdout redirected to a JSONL file.
 * The server tails that file for real-time streaming. On server restart,
 * it reconnects to sessions that are still alive (PID check + file tail).
 *
 * ClaudeCodeSession: spawns `claude -p --output-format stream-json --verbose`
 * with stdout→file, tails the output file, and emits incremental bus events:
 *   - session:text-delta for text content blocks
 *   - session:tool-use for tool call blocks
 *   - session:tool-result for tool result blocks
 * When process exits (detected via PID liveness check), emits session:result.
 *
 * SessionRunner: subscribes to session:start / session:send on the bus,
 * manages active ClaudeCodeSession instances, reconnects on startup.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { bus, EventNames, eventData } from '../core/event-bus.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { SESSION_STREAMS_DIR } from '../constants.js'
import { log } from '../logging/index.js'
import { markProcessing, removeProcessed, revertToPending, loadQueue, getAllSessionsWithPending } from '../core/session-message-queue.js'
// Image transfer for remote sessions: RemoteSessionManager.prepareOutbound() uploads
// local images via daemon and rewrites paths inside start() and writeMessage().
import type { SshTarget } from './session-io.js'
import { createSessionManager, registerSessionManager, unregisterSessionManager } from './session-manager.js'
import type { SessionManager } from './session-manager.js'
import { recoverStateFromJsonl, extractImageFilePathFromInput } from '../core/session-history.js'
import type { SessionRecord, SessionMode, ProcessStatus, TaskPhase } from '../core/types.js'
import type { SessionServerClient } from './session-server-client.js'
import { sanitizeInitModel, CONTEXT_WINDOW_DEFAULT } from '../agent/providers/defaults.js'

// ── JSONL types from `claude -p --output-format stream-json --verbose` ──

/**
 * System init event — first line of JSONL output, contains session_id and metadata.
 *
 * EMPIRICAL FINDING (from real CLI tests):
 * The `permissionMode` field is present in EVERY `system` event with subtype `init`.
 * Values observed: "plan", "bypassPermissions", "acceptEdits", "default".
 * This is the ground truth for what mode the CLI is actually running in.
 */
interface StreamInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd?: string
  model?: string
  tools?: string[]
  permissionMode?: string
}

/**
 * System status event — emitted by CLI when permission mode changes mid-session.
 *
 * EMPIRICAL FINDING (from real CLI tests):
 * When Claude calls EnterPlanMode, the CLI emits a `system` event with subtype `status`
 * containing the NEW `permissionMode`. This is how we detect mid-session mode changes.
 *
 * Test evidence (test-bypass-enterplan.jsonl):
 *   Line 0: SYSTEM subtype=init permissionMode=bypassPermissions  ← startup
 *   Line 2: TOOL_USE → EnterPlanMode
 *   Line 3: SYSTEM subtype=status permissionMode=plan             ← mode changed!
 *
 * NOTE: ExitPlanMode does NOT emit a system status event in `-p` mode.
 * It returns is_error=true because CLI needs interactive user approval.
 * See the ExitPlanMode handler in handleStreamLine() for that case.
 */
interface StreamStatusEvent {
  type: 'system'
  subtype: 'status'
  permissionMode?: string
  session_id?: string
}

/** Content block within an assistant message */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | unknown[]
}

/** Assistant or user message event */
interface StreamMessageEvent {
  type: 'assistant' | 'user'
  /** Non-null when this event belongs to a subagent Task */
  parent_tool_use_id?: string | null
  message: {
    id?: string
    role: 'assistant' | 'user'
    model?: string
    content: ContentBlock[]
    stop_reason?: string | null
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  session_id: string
}

/** Final result event — last line */
interface StreamResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  result: string
  session_id: string
  duration_ms?: number
  total_cost_usd?: number
  num_turns?: number
  usage?: { input_tokens: number; output_tokens: number }
}

type StreamEvent = StreamInitEvent | StreamStatusEvent | StreamMessageEvent | StreamResultEvent

/**
 * Map CLI permissionMode string to our internal SessionMode.
 *
 * CLI values (from JSONL system events):
 *   "bypassPermissions" → 'bypass'
 *   "acceptEdits"       → 'accept'
 *   "plan"              → 'plan'
 *   "default"           → 'default'
 */
function mapPermissionMode(cliMode: string): SessionMode | null {
  switch (cliMode) {
    case 'bypassPermissions': return 'bypass'
    case 'acceptEdits': return 'accept'
    case 'plan': return 'plan'
    case 'default': return 'default'
    default: return null
  }
}

// ── Helpers for PID-death handler ──

/**
 * Check if a JSONL output file contains a 'result' event line.
 * Returns { hasResult: true } for successful results, { hasResult: false }
 * otherwise. If the result has is_error:true (e.g. --resume "No conversation
 * found"), returns { hasResult: false, errorMessage } so the caller can
 * surface the error to the user instead of silently swallowing it.
 */
function outputFileCheckResult(filePath: string, fromOffset = 0): { hasResult: boolean; errorMessage?: string } {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const stat = fs.fstatSync(fd)
      // Only scan data written after fromOffset (current turn).
      // On resume, the file contains previous turns' events — including old
      // result events that would cause a false positive if we scanned them.
      const scanStart = Math.max(fromOffset, 0)
      if (stat.size <= scanStart) return { hasResult: false }  // No new data written this turn
      const bytesToRead = stat.size - scanStart
      const buf = Buffer.alloc(bytesToRead)
      fs.readSync(fd, buf, 0, bytesToRead, scanStart)
      const data = buf.toString('utf-8')
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'result') {
            if (event.is_error) {
              // --resume failure or other CLI error — extract message
              const errors: string[] = Array.isArray(event.errors) ? event.errors : []
              return { hasResult: false, errorMessage: errors[0] || 'Claude Code returned an error result' }
            }
            return { hasResult: true }
          }
        } catch { continue }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return { hasResult: false }
}

/**
 * Determine if SSH stderr content is benign (not a real error).
 * SSH sessions always produce stderr from the EXIT trap (`cat JSONL.err >&2`)
 * which copies Claude CLI's diagnostic output. We don't want to treat normal
 * SSH disconnect messages or Claude CLI startup noise as session errors.
 */
function isBenignSshStderr(stderr: string): boolean {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(line => {
    // SSH connection close messages
    if (/^Connection to .+ closed\.?$/i.test(line)) return true
    // Normal process termination (SIGTERM=15, SIGHUP=1) — but NOT SIGKILL=9 (OOM)
    if (/^Killed:\s*\d+$/i.test(line) || /killed by signal (1|15)\b/i.test(line)) return true
    // SSH mux messages
    if (/^(Shared connection to .+ closed|ControlSocket .+)$/i.test(line)) return true
    return false
  })
}

// Re-export types and helpers from session-io for backwards compatibility
export type { SshTarget } from './session-io.js'
export { shellQuote } from './session-io.js'

// Exported for testing
export { outputFileCheckResult }

// ── ClaudeCodeSession ──

const MAX_FULL_TEXT = 100 * 1024 // 100KB cap on accumulated text
const LIVENESS_INTERVAL_MS = 3000

export class ClaudeCodeSession {
  private pid: number | null = null
  private fullText = ''
  private claudeSessionId: string | null = null
  private _cwd: string | null = null
  private _active = false
  private _exitCode: number | null = null
  /** Session-lifetime flag: survives across turns, checked by handleProcessDeath and
   *  server-restart recovery to suppress spurious events from dead/old processes.
   *  Set true on kill/interrupt/respawn; set false when a new turn begins. */
  private resultEmitted = false
  /** Per-turn flag: reset on writeMessage()/send(), prevents duplicate JSONL result
   *  events within a single turn (e.g., tailer emits result, then PID-death handler fires). */
  private _turnResultEmitted = false
  /** Byte offset in the output file where the current turn started (for resume). */
  private _turnStartOffset = 0
  /** Cumulative cost from the last result event — used to detect stale/replayed results. */
  private _lastResultCost: number | undefined
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private _outputFile: string | null = null
  private cliCommand: string
  /** Direct WebSocket URL for daemon (test-only, bypasses SSH). Set by SessionRunner. */
  _testDaemonUrl: string | undefined
  /** Host key from config.hosts — null means local execution */
  private _host: string | null = null

  // Status tracking
  private _processStatus: ProcessStatus = 'stopped'
  private _mode: SessionMode = 'default'
  private _activity: string | undefined
  /** Model ID from JSONL assistant messages (e.g. "claude-opus-4-6"). */
  private _model: string | undefined
  /** Full model string from system init (e.g. "global.anthropic.claude-opus-4-6-v1[1m]"). */
  private _initModel: string | undefined
  /** CLI model string passed to --model (e.g. "opus[1m]"). Preserved for resume. */
  private _cliModel: string | undefined
  /** The session ID we expect after a --resume. If Claude returns a different ID,
   *  we rename the existing record instead of creating a phantom new one. */
  private _expectedSessionId: string | null = null

  /** Auto-generated title set by SessionRunner before first send */
  pendingTitle?: string
  /** Auto-generated description set by SessionRunner before first send */
  pendingDescription?: string
  /** Source plan session ID (set when this session was created from a plan) */
  fromPlanSessionId?: string
  /** Source session ID when this session was forked from another session */
  forkedFromSessionId?: string

  /** Plan file path captured from Write tool_use targeting ~/.claude/plans/ */
  planFile: string | null = null
  /** True when ExitPlanMode tool_use is detected in the JSONL stream */
  planCompleted = false
  /** Plan content captured from the most recent Write to ~/.claude/plans/ */
  private _lastPlanWriteContent: string | null = null
  /** True when we've already auto-replied to AskUserQuestion this turn. Reset on new turn. */
  private _askUserIntercepted = false
  /** Timestamp when spawn() was called — used to measure time-to-init for diagnostics. */
  private _spawnTs = 0
  /** Timestamp of the last message delivery (FIFO write or --resume spawn). */
  private _lastMessageDeliveryTs = 0
  /** Timestamp of the last JSONL event received from the output file. */
  private _lastJsonlEventTs = 0
  /** Output file size at the time of last message delivery — used to detect stalled output. */
  private _fileSizeAtDelivery = 0
  /** Timer for diagnosing "Running but no response" — fires if no JSONL event arrives after message delivery. */
  private _stallDiagTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-session cache for remote→local image path rewriting (avoids re-downloading). */
  private _remoteImageCache = new Map<string, string>()
  /** Cache tool_use input file paths for image tools — used to resolve tool_result image content blocks to file paths. */
  private _toolInputFilePaths = new Map<string, string>()
  /** Session manager for all session I/O (local + remote). Null before first send(). */
  private _transport: SessionManager | null = null

  /** Resolves with the Claude session ID once the system init event arrives. */
  readonly sessionReady: Promise<string>
  private _resolveSessionReady!: (id: string) => void
  private _rejectSessionReady!: (err: Error) => void

  constructor(
    readonly taskId: string,
    readonly project: string,
    cliCommand?: string,
  ) {
    this.cliCommand = cliCommand ?? 'claude'
    this.sessionReady = new Promise<string>((resolve, reject) => {
      this._resolveSessionReady = resolve
      this._rejectSessionReady = reject
    })
    // Prevent unhandled rejection if nobody awaits sessionReady (e.g., taskless sessions)
    this.sessionReady.catch(() => {})
  }

  get active(): boolean {
    return this._active
  }

  get sessionId(): string | null {
    return this.claudeSessionId
  }

  get outputFile(): string | null {
    return this._outputFile
  }

  get processPid(): number | null {
    return this.pid
  }

  get processStatus(): ProcessStatus {
    return this._processStatus
  }

  /**
   * Mark this session's process as dead externally (e.g. pre-flight check
   * discovered the PID is gone before a FIFO write).
   * Clears the pipe so the next processNext() falls through to --resume.
   */
  markProcessDead(): void {
    this._transport?.deletePipe()
    this._active = false
    this._processStatus = 'stopped'
  }

  get mode(): SessionMode {
    return this._mode
  }

  get activity(): string | undefined {
    return this._activity
  }

  get host(): string | null {
    return this._host
  }

  get cwd(): string | null {
    return this._cwd
  }

  /** Session manager for all session I/O. Null before first send(). */
  get transport(): SessionManager | null {
    return this._transport
  }

  /** Whether this session has an active write pipe (FIFO). */
  get hasPipe(): boolean {
    return this._transport?.hasPipe ?? false
  }

  /**
   * Send a message to Claude Code via detached spawn.
   * stdout is redirected to a JSONL file; a tailer reads it for streaming.
   *
   * When `host` and `sshTarget` are provided, the claude process is spawned on
   * a remote machine via SSH. The JSONL stdout is piped back through the SSH
   * connection to the local output file, so JsonlTailer works identically.
   */
  send(
    message: string,
    cwd?: string,
    resumeSessionId?: string,
    mode?: string,
    model?: string,
    appendSystemPrompt?: string,
    host?: string,
    sshTarget?: SshTarget,
    forkSession?: boolean,
  ): void {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']

    // Store mode and set initial activity
    if (mode === 'bypass') {
      this._mode = 'bypass'
      this._activity = 'implementing'
      args.push('--permission-mode', 'bypassPermissions')
    } else if (mode === 'accept') {
      this._mode = 'accept'
      args.push('--permission-mode', 'acceptEdits')
    } else if (mode === 'plan') {
      this._mode = 'plan'
      this._activity = 'planning'
      args.push('--permission-mode', 'plan')
    } else {
      this._mode = 'default'
    }
    // Map picker short IDs → full CLI model identifiers.
    // The CLI understands [1m] suffix for 1M context window.
    // Map picker keys to CLI aliases. Non-1M models (opus, sonnet, haiku)
    // pass through as-is via fallback — CLI resolves them per provider.
    const MODEL_CLI_MAP: Record<string, string> = {
      'opus-1m':   'opus[1m]',
      'sonnet-1m': 'sonnet[1m]',
    }
    const cliModel = MODEL_CLI_MAP[model ?? ''] ?? (model || 'opus[1m]')
    this._cliModel = cliModel
    args.push('--model', cliModel)
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
      if (forkSession) {
        // Fork creates a NEW session ID — don't claim the source ID as ours
        args.push('--fork-session')
        this.claudeSessionId = null
        this._expectedSessionId = null
      } else {
        this.claudeSessionId = resumeSessionId
        this._expectedSessionId = resumeSessionId  // track expected ID to detect resume failure
      }
    } else {
      this.claudeSessionId = null
      this._expectedSessionId = null
    }

    if (appendSystemPrompt) {
      args.push('--append-system-prompt', appendSystemPrompt)
    }

    // Both local and SSH sessions use stream-json stdin via SessionIO
    args.push('--input-format', 'stream-json')

    // Store host key for liveness checks and record persistence
    this._host = host ?? null

    // Kill any existing process before spawning a new one.
    // This prevents multiple processes competing for the same Claude session
    // (e.g., after server restart, startup recovery re-processes queued messages
    // while the old process from the previous server instance is still alive).
    if (this.pid !== null) {
      log.session.info('killing old process before respawn', { taskId: this.taskId, oldPid: this.pid })
      try { process.kill(this.pid, 'SIGTERM') } catch { /* already dead */ }
    }
    this.resultEmitted = true  // Suppress spurious events from old process
    // Stop monitoring (tailer + liveness) BEFORE replacing transport
    this.stopMonitoring()
    if (this._transport) {
      // Detach first to unsubscribe event listeners from the shared DaemonConnection,
      // preventing duplicate agent_complete / result emissions from the old transport.
      this._transport.detach()
      this._transport.deletePipe()
      if (this.claudeSessionId) unregisterSessionManager(this.claudeSessionId)
      this._transport = null
    }

    this._active = true
    this._processStatus = 'running'
    this._exitCode = null
    this.resultEmitted = false
    this._turnResultEmitted = false
    this._lastResultCost = undefined  // Fresh session — no previous cost to compare
    this._askUserIntercepted = false
    this.fullText = ''
    this._cwd = cwd ?? null

    const isResume = !!resumeSessionId && !forkSession
    const tmpId = isResume ? resumeSessionId : crypto.randomBytes(8).toString('hex')

    this._spawnTs = Date.now()
    const transport = createSessionManager(tmpId, host ?? undefined, sshTarget, undefined, this.cliCommand, this._testDaemonUrl)
    this._transport = transport

    // Start asynchronously — transport.start() handles FIFO, spawn, and tailing
    transport.start({
      args,
      cwd: cwd ?? process.cwd(),
      message,
      resume: isResume,
      fork: forkSession,
      onOutput: (event) => this.handleStreamLine(event.line),
      onExit: (code) => {
        this._exitCode = code
        if (code !== 0) {
          log.session.warn('session process exited with non-zero code', {
            taskId: this.taskId, exitCode: code, host, isRemote: !!sshTarget,
          })
        }
      },
    }).then((result) => {
      this.pid = result.pid
      this._outputFile = result.outputFile
      this._turnStartOffset = result.fileSize

      // Register in the global session manager registry (for liveness checks, health monitor)
      if (this.claudeSessionId) {
        registerSessionManager(this.claudeSessionId, transport)
      }

      log.session.info('session spawned via transport', {
        taskId: this.taskId,
        project: this.project,
        host,
        pid: result.pid,
        outputFile: result.outputFile,
        resume: isResume,
        fork: !!forkSession,
        isRemote: !!sshTarget,
        spawnMs: Date.now() - this._spawnTs,
      })

      // Persist outputFile + PID for resume recovery
      if (isResume && resumeSessionId) {
        import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
          updateSessionRecord(resumeSessionId, {
            outputFile: this._outputFile ?? undefined,
            pid: this.pid ?? undefined,
            process_status: 'running',
          }).catch(() => {}),
        ).catch(() => {})
      }
    }).catch((err) => {
      log.session.error('transport start failed', {
        taskId: this.taskId, host, isRemote: !!sshTarget,
        error: err instanceof Error ? err.message : String(err),
      })
      this._rejectSessionReady(err)
      if (!this.resultEmitted) {
        this.resultEmitted = true
        this._active = false
        this._processStatus = 'stopped'
        this._activity = undefined
        this.emitStatusChanged('AGENT_COMPLETE')
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          error: err instanceof Error ? err.message : String(err),
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })
      }
    })

    this._outputFile = transport.outputFile
    this.emitStatusChanged('IN_PROGRESS')
    this.startLivenessMonitor()
    this.startStallDiagTimer('resume-spawn')
  }

  /**
   * Attach to an existing running process (for reconnection after restart).
   * Does NOT spawn — just tails the output file and monitors PID.
   */
  static async attachToExisting(
    record: SessionRecord,
    cliCommand?: string,
    testDaemonUrl?: string,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(record.taskId, record.project, cliCommand)
    session._testDaemonUrl = testDaemonUrl
    session.claudeSessionId = record.claudeSessionId
    session.pid = record.pid ?? null
    session._outputFile = record.outputFile ?? null
    session._cwd = record.cwd ?? null
    session._active = true
    session._processStatus = record.process_status ?? 'running'
    session._mode = record.mode ?? 'default'
    session._activity = record.activity
    session.planFile = record.planFile ?? null
    session.planCompleted = record.planCompleted ?? false
    session._host = record.host ?? null
    // Restore model from session record so context % works after server restart.
    // _initModel is in-memory only (set from init events); old init events aren't
    // re-processed since the JSONL tailer starts from current offset.
    if (record.model) {
      session._initModel = record.model
      const shortModel = record.model.replace(/^.*\./, '').replace(/[-_]v\d+.*$/, '') || record.model
      session._model = shortModel
    }
    if (record.cliModel) {
      session._cliModel = record.cliModel
    }

    // ── resultEmitted recovery after server restart ──
    // `resultEmitted` is ephemeral — it lives only on the ClaudeCodeSession instance
    // in memory and is lost when the server restarts. New instances always start
    // with resultEmitted=false (the field default). Without recovery, the PID-death
    // liveness handler would emit a *synthetic* session:result for every session
    // that was already fully processed (git pull, usage tracking, task phase update,
    // triage dispatch) before the restart — flooding the user with stale notifications.
    //
    // We use the linked task's phase as the durable proxy for "server already
    // handled this result":
    //   - The main-ai handler in server.ts advances task.phase to AGENT_COMPLETE
    //     only AFTER completing all result bookkeeping
    //   - tasks.json is written to disk and persists across restarts
    //   - If task.phase is past IN_PROGRESS, the server already processed the real result
    //
    // Race window: theoretically the server could crash between setting task.phase
    // and flushing tasks.json to disk. In practice this window is sub-millisecond.
    // Worst case: one extra triage notification — acceptable.
    let taskPhaseIsTerminal = false
    if (record.taskId) {
      try {
        const { getTask } = await import('../core/task-manager.js')
        const task = await getTask(record.taskId)
        if (task && task.phase !== 'TODO' && task.phase !== 'IN_PROGRESS') {
          taskPhaseIsTerminal = true
        }
      } catch { /* task not found — assume non-terminal */ }
    }
    session.resultEmitted = taskPhaseIsTerminal
      || record.process_status === 'error'

    // Create the appropriate session manager for attach:
    //   - Local sessions → LocalSessionManager (FIFO recovery + file tailing)
    //   - Remote sessions → RemoteSessionManager (WebSocket to remote daemon)
    //
    // CRITICAL: Pass record.outputFile so LocalSessionManager uses the correct path from
    // when the session was created. Without this, SESSION_STREAMS_DIR may point to a
    // different directory after server restart (e.g. if WALNUT_HOME changed).
    if (record.claudeSessionId) {
      let sshTarget: SshTarget | undefined
      if (record.host) {
        try {
          const { getConfig } = await import('../core/config-manager.js')
          const config = await getConfig()
          const hostDef = config.hosts?.[record.host]
          if (hostDef) {
            const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
            if (hostname) {
              sshTarget = {
                hostname,
                user: hostDef.user,
                port: hostDef.port,
                shell_setup: hostDef.shell_setup,
              }
            }
          }
        } catch {
          log.session.warn('failed to resolve host config for attach', {
            sessionId: record.claudeSessionId,
            host: record.host,
          })
        }
      }

      const transport = createSessionManager(
        record.claudeSessionId,
        record.host ?? undefined,
        sshTarget,
        record.outputFile ?? undefined,
        cliCommand,
        testDaemonUrl,
      )
      session._transport = transport

      // Register in the global session manager registry
      registerSessionManager(record.claudeSessionId, transport)

      // Set PID on the transport before attach (LocalSessionManager needs it for liveness checks)
      if (record.pid && 'setPid' in transport) {
        (transport as { setPid(pid: number): void }).setPid(record.pid)
      }
    }

    // Recover state from CloudCode canonical JSONL (source of truth).
    // The session record in sessions.json may be stale if the server crashed
    // before an async updateSessionRecord() completed. The CloudCode JSONL
    // is maintained by Claude CLI itself and always has the ground truth.
    let jsonlByteLength = 0
    try {
      const recovered = await recoverStateFromJsonl(record.claudeSessionId, record.cwd, record.host)
      if (recovered) {
        if (recovered.mode) session._mode = recovered.mode as SessionMode
        if (recovered.model) {
          session._initModel = recovered.model
          const shortModel = recovered.model.replace(/^.*\./, '').replace(/[-_]v\d+.*$/, '') || recovered.model
          session._model = shortModel
        }
        if (recovered.planFile) session.planFile = recovered.planFile
        if (recovered.planCompleted != null) session.planCompleted = recovered.planCompleted
        if (recovered.activity) session._activity = recovered.activity
        if (recovered.jsonlByteLength) jsonlByteLength = recovered.jsonlByteLength
        // Belt-and-suspenders: if the JSONL has a result event (hasResult),
        // reinforce resultEmitted even if tasks.json was momentarily stale.
        if (recovered.workStatus === 'agent_complete' || recovered.workStatus === 'await_human_action') {
          session.resultEmitted = true
        }
        log.session.info('recovered state from canonical JSONL', {
          sessionId: record.claudeSessionId,
          recovered,
        })
        // Patch the in-memory record directly so other code paths that read it
        // (reconciler, API responses) see the corrected values immediately.
        // The next updateSessionRecord() call from any code path will persist these.
        if (recovered.mode) record.mode = recovered.mode as SessionRecord['mode']
        if (recovered.model) record.model = recovered.model
        if (recovered.planFile) record.planFile = recovered.planFile
        if (recovered.planCompleted != null) record.planCompleted = recovered.planCompleted
      }
    } catch (err) {
      log.session.warn('state recovery from canonical JSONL failed, using session record', {
        sessionId: record.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log.session.info('attaching to existing session', {
      taskId: record.taskId,
      sessionId: record.claudeSessionId,
      pid: record.pid,
      outputFile: record.outputFile,
      hasFifo: session._transport?.hasPipe ?? false,
    })

    // Attach the transport: recovers FIFO (local) or reconnects WebSocket (daemon),
    // then starts tailing from AFTER the data we already recovered.
    // For remote sessions, transport.fileSize is 0 (no local file) — use the JSONL
    // byte length from recovery so the daemon skips already-processed events.
    // Without this, the daemon replays from byte 0, re-sending stale result events
    // that override the session's current running/idle state.
    if (session._transport && record.claudeSessionId) {
      const fromOffset = session._transport.fileSize || jsonlByteLength
      try {
        await session._transport.attach({
          sessionId: record.claudeSessionId,
          fromOffset,
          onOutput: (event) => session.handleStreamLine(event.line),
          onExit: (code) => {
            session._exitCode = code
          },
        })
      } catch (err) {
        log.session.warn('transport attach failed, session may not stream', {
          sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    session.startLivenessMonitor()

    return session
  }

  /**
   * Detach from the session without killing the process.
   * Stops tailing and liveness monitoring. The process continues running.
   */
  detach(): void {
    log.session.info('session detached', { taskId: this.taskId, pid: this.pid, hasPipe: this._transport?.hasPipe })
    this.stopMonitoring()
    this._transport?.detach()
    this._active = false
  }

  /**
   * Kill the running process.
   * Marks resultEmitted so no spurious events are emitted.
   */
  kill(): void {
    log.session.info('session killed', { taskId: this.taskId, pid: this.pid })
    this.resultEmitted = true
    this.stopMonitoring()
    this._transport?.kill()
    this._active = false
  }

  /**
   * Write a follow-up message via the named FIFO (stream-json stdin).
   * Returns true if the message was written successfully.
   * Returns false if the FIFO is gone — caller should fall back to --resume spawn.
   *
   * Named pipes survive server restarts: the FIFO file persists on disk,
   * and any server instance can open it for writing.
   */
  async writeMessage(message: string): Promise<boolean> {
    if (!this._transport) return false
    const ok = await this._transport.writeMessage(message)
    if (!ok) return false
    this._processStatus = 'running'  // Back to running from idle
    this._activity = undefined
    this.resultEmitted = false
    this._turnResultEmitted = false  // New turn starting — allow result emission
    this._turnStartOffset = this._transport?.fileSize ?? 0  // Track where this turn's data begins
    this._askUserIntercepted = false
    this._toolInputFilePaths.clear()  // Fresh turn — clear stale cached tool input paths
    this.emitStatusChanged('IN_PROGRESS')
    // Persist running state to session tracker so API consumers (frontend tree, etc.)
    // see the updated status immediately — not just WebSocket subscribers.
    if (this.claudeSessionId) {
      import('../core/session-tracker.js').then(({ updateSessionRecord }) => {
        updateSessionRecord(this.claudeSessionId!, {
          process_status: 'running',
          activity: undefined,
          last_status_change: new Date().toISOString(),
        }).catch(() => {})
      }).catch(() => {})
    }
    log.session.info('message sent to session via FIFO', { taskId: this.taskId, sessionId: this.claudeSessionId, messageLength: message.length })
    this.startStallDiagTimer('fifo-write')
    return true
  }

  /**
   * Append a synthetic user-text event to the local output file.
   * Claude Code's stdout stream does NOT echo user text messages — only tool_results
   * and assistant responses appear in the JSONL. This means the local streams file
   * never sees user messages, and the frontend relies entirely on optimistic copies
   * that can fail to dedup.
   *
   * Writes ONLY to the streams file (_outputFile), never to canonical JSONL.
   * The walnutMessageId enables deterministic dedup against optimistic copies.
   *
   * NOTE: Remote sessions have _outputFile=null (RemoteSessionManager.outputFile
   * returns null), so this is effectively a no-op for remote sessions.
   * RemoteSessionManager overrides this method as an explicit no-op.
   */
  writeSyntheticUserEvent(message: string, walnutMessageId: string): void {
    if (this._transport) {
      this._transport.writeSyntheticUserEvent(message, walnutMessageId)
      return
    }
    // Fallback for pre-transport sessions (e.g. during init before send())
    const outputFile = this._outputFile
    if (!outputFile) return
    const event = JSON.stringify({
      type: 'user',
      subtype: 'walnut-injected',
      message: { role: 'user', content: message },
      walnutMessageId,
      timestamp: new Date().toISOString(),
    })
    const line = event + '\n'
    // Write to streams capture file only (_outputFile).
    // ⛔ NEVER write to canonical JSONL (~/.claude/projects/<cwd>/<sessionId>.jsonl).
    // Canonical is owned by Claude Code; writing entries without uuid/parentUuid
    // breaks the conversation tree and causes --resume to lose all history.
    // The streams file is sufficient: tailer reads it for real-time display,
    // and walnutMessageId enables frontend dedup.
    fsp.appendFile(outputFile, line).catch((err) => {
      log.session.debug('writeSyntheticUserEvent failed on streams file (non-fatal)', {
        sessionId: this.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Gracefully stop the running process before respawning.
   * Uses SIGINT (Claude Code saves session state on Ctrl+C) + wait, with SIGTERM fallback.
   * This ensures session data is flushed to disk so --resume can find it.
   *
   * Unlike interrupt(), this does NOT clean up FIFO or modify session state —
   * it ONLY stops the process. The caller (processNext) will spawn a new process immediately after.
   *
   * THIS IS CRITICAL: Without graceful stop, send() would SIGTERM the old process,
   * which doesn't give Claude Code time to flush session state. Then --resume fails,
   * creates a new session with a different ID, and activeProcessing gets permanently stuck.
   */
  async gracefulStop(): Promise<void> {
    if (!this._transport) return
    log.session.info('gracefulStop: using transport', { taskId: this.taskId })
    await this._transport.stop()
    log.session.info('gracefulStop: complete', { taskId: this.taskId })
  }

  /**
   * Interrupt the running session: close stdin pipe, gracefully stop the process,
   * and wait for it to exit so session state is flushed to disk.
   *
   * Two-phase shutdown:
   *   1. SIGINT (like Ctrl+C) — Claude Code handles this gracefully and saves session state
   *   2. SIGTERM (fallback) — if SIGINT doesn't kill within 5s
   *
   * Waits for the process to actually exit before returning, so --resume
   * can find the saved session. Without this wait, the new --resume process
   * races against the dying process's disk flush and fails with
   * "No conversation found with session ID".
   */
  async interrupt(): Promise<void> {
    log.session.info('session interrupted', { taskId: this.taskId, pid: this.pid })
    this.resultEmitted = true
    this.stopMonitoring()
    if (this._transport) {
      await this._transport.interrupt()
    }
    this._active = false
    this._processStatus = 'stopped'
    this._activity = undefined
  }

  // ── Private ──

  private startLivenessMonitor(): void {
    // Skip liveness polling for remote daemon sessions — the daemon already monitors
    // process liveness on the remote host and reports exit events via WebSocket.
    // Polling isAlive() over SSH is redundant and fragile: a momentary tunnel glitch
    // or rename race causes false negatives → premature handleProcessDeath().
    if (this._transport?.isRemote) return

    this.livenessTimer = setInterval(async () => {
      if (this.pid === null || this.resultEmitted) {
        this.stopLivenessMonitor()
        return
      }

      if (!this._transport) return

      if (!await this._transport.isAlive()) {
        log.session.info('session process exited (transport check)', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          pid: this.pid,
          isRemote: this._transport.isRemote,
        })
        this.handleProcessDeath()
      }
    }, LIVENESS_INTERVAL_MS)
  }

  /**
   * Handle process death detected by liveness monitor.
   */
  private handleProcessDeath(): void {
    // Process is dead — clean up via transport
    this._transport?.deletePipe()
    this._transport?.flushTail()
    this._transport?.stopTail()

    this._active = false
    this._processStatus = 'stopped'
    this.stopLivenessMonitor()

    // Reject sessionReady with detailed diagnostics.
    let initStderr = ''
    if (this._outputFile) {
      try {
        initStderr = fs.readFileSync(this._outputFile + '.err', 'utf-8').slice(0, 2048).trim()
      } catch { /* no stderr file */ }
    }
    const parts = ['process died before session init']
    if (this._host) parts.push(`[SSH → ${this._host}]`)
    if (this._exitCode !== null) parts.push(`[exit code: ${this._exitCode}]`)
    if (this.pid) parts.push(`[pid: ${this.pid}]`)
    if (initStderr) parts.push(`stderr: ${initStderr}`)
    else parts.push('(no stderr captured)')
    const errMsg = parts.join(' ')
    log.session.error('session init failed — process died before init event', {
      taskId: this.taskId,
      pid: this.pid,
      exitCode: this._exitCode,
      host: this._host,
      stderr: initStderr || undefined,
      outputFile: this._outputFile,
      timeSinceSpawnMs: this._spawnTs ? Date.now() - this._spawnTs : undefined,
    })
    this._rejectSessionReady(new Error(errMsg))

    // If no result was emitted by the tailer, determine fallback behavior.
    if (!this.resultEmitted && !this._turnResultEmitted) {
      const { hasResult: hasResultInFile, errorMessage: resultErrorMessage } = this._outputFile
        ? outputFileCheckResult(this._outputFile, this._turnStartOffset)
        : { hasResult: false, errorMessage: undefined }

      this.resultEmitted = true
      this._turnResultEmitted = true

      if (hasResultInFile) {
        this._activity = undefined
        this.emitStatusChanged('AGENT_COMPLETE')
        if (this.claudeSessionId) {
          this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
            log.session.warn('persistSessionRecord failed (PID died, result found)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
          })
        }
        log.session.info('session PID died — result found in output file (tailer race)', {
          taskId: this.taskId,
          sessionId: this.claudeSessionId,
          host: this._host,
        })
        bus.emit(EventNames.SESSION_RESULT, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          result: this.fullText,
          isError: false,
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })
      } else if (resultErrorMessage) {
        // Result event exists but is_error:true — e.g. --resume "No conversation found".
        // Surface the error instead of silently treating it as success.
        this._activity = undefined
        this.emitStatusChanged('AGENT_COMPLETE')
        log.session.error('session PID died — error result in output file', {
          taskId: this.taskId,
          sessionId: this.claudeSessionId,
          host: this._host,
          errorMessage: resultErrorMessage,
        })
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          error: resultErrorMessage,
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })
      } else {
        let stderr = ''
        if (this._outputFile) {
          try {
            stderr = fs.readFileSync(this._outputFile + '.err', 'utf-8').slice(0, 10240).trim()
          } catch { /* No stderr file */ }
        }

        const isRealError = stderr && !isBenignSshStderr(stderr)

        if (isRealError) {
          this._activity = undefined
          this.emitStatusChanged('AGENT_COMPLETE')
          bus.emit(EventNames.SESSION_ERROR, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            error: stderr,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        } else {
          this._activity = undefined
          this.emitStatusChanged('AGENT_COMPLETE')
          if (this.claudeSessionId) {
            this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
              log.session.warn('persistSessionRecord failed (PID died, no result)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
            })
          }
          log.session.warn('session PID died but no result event', {
            taskId: this.taskId,
            host: this._host,
            stderr: stderr ? stderr.slice(0, 200) : undefined,
          })
          bus.emit(EventNames.SESSION_RESULT, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            result: this.fullText,
            isError: false,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        }
      }
    }
  }

  private stopLivenessMonitor(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private stopMonitoring(): void {
    this.stopLivenessMonitor()
    this._transport?.stopTail()
    this.clearStallDiagTimer()
  }

  /**
   * Start a diagnostic timer after message delivery (FIFO write or --resume spawn).
   * If no JSONL event arrives within 30s, log comprehensive state for debugging
   * "Running but no response" issues. Does NOT kill anything — purely diagnostic.
   *
   * Motivation: users report sessions stuck at "Running" with no output. Root causes
   * vary widely — FIFO write silently failing, Claude process hung on tool execution,
   * tailer not attached, output file on wrong path. Without diagnostics at the moment
   * of stall, we can't distinguish these cases from logs alone. The 30s threshold
   * balances early detection vs false positives (some tool calls legitimately take 20s+).
   */
  private startStallDiagTimer(trigger: 'fifo-write' | 'resume-spawn'): void {
    this.clearStallDiagTimer()
    this._lastMessageDeliveryTs = Date.now()
    this._fileSizeAtDelivery = this._transport?.fileSize ?? 0

    this._stallDiagTimer = setTimeout(async () => {
      this._stallDiagTimer = null
      const now = Date.now()
      const currentFileSize = this._transport?.fileSize ?? 0
      const fileSizeGrew = currentFileSize > this._fileSizeAtDelivery
      const pidAlive = this._transport
        ? await this._transport.isAlive()
        : (this.pid !== null && await isProcessAliveAsync(this.pid, 'claude'))
      const msSinceDelivery = now - this._lastMessageDeliveryTs
      const msSinceLastEvent = this._lastJsonlEventTs ? now - this._lastJsonlEventTs : -1
      const hasTailer = !!this._transport

      log.session.warn('STALL DIAGNOSTIC: no JSONL event 30s after message delivery', {
        trigger,
        sessionId: this.claudeSessionId,
        taskId: this.taskId,
        pid: this.pid,
        pidAlive,
        host: this._host,
        processStatus: this._processStatus,
        hasPipe: this._transport?.hasPipe ?? false,
        hasTailer,
        fileSizeAtDelivery: this._fileSizeAtDelivery,
        currentFileSize,
        fileSizeGrew,
        msSinceDelivery,
        msSinceLastEvent,
        outputFile: this._outputFile,
        usingTransport: !!this._transport,
      })
    }, 30_000)
  }

  /** Clear the stall diagnostic timer. Called when any JSONL event arrives or session stops. */
  private clearStallDiagTimer(): void {
    if (this._stallDiagTimer) {
      clearTimeout(this._stallDiagTimer)
      this._stallDiagTimer = null
    }
  }

  /**
   * Rewrite remote image paths in text to local paths for remote sessions.
   * No-op for local sessions. Uses transport.processInbound() for remote.
   */
  private rewriteRemoteImages(text: string): string {
    if (!this._transport?.isRemote) return text
    const sessionId = this.claudeSessionId ?? 'unknown'
    return this._transport.processInbound(text, sessionId, this._cwd ?? undefined)
  }

  /**
   * Handle a single JSONL line from the stream-json output.
   * Parses the JSON, extracts the event type, and emits bus events.
   */
  /** Track whether we've received any JSONL line yet (for first-line timing). */
  private _firstLineSeen = false

  private handleStreamLine(line: string): void {
    // Clear stall diagnostic timer — we're receiving output, session is responsive
    this._lastJsonlEventTs = Date.now()
    this.clearStallDiagTimer()

    if (!this._firstLineSeen) {
      this._firstLineSeen = true
      log.session.info('first JSONL line received from output', {
        taskId: this.taskId,
        isRemote: !!this._host,
        host: this._host,
        timeSinceSpawnMs: this._spawnTs ? Date.now() - this._spawnTs : undefined,
        linePreview: line.slice(0, 120),
      })
    }

    let event: StreamEvent
    try {
      event = JSON.parse(line) as StreamEvent
    } catch {
      log.session.warn('malformed JSONL line skipped', { sessionId: this.claudeSessionId, taskId: this.taskId, linePreview: line.slice(0, 80) })
      return
    }

    try {
      switch (event.type) {
      case 'system': {
        const sys = event as unknown as Record<string, unknown>

        // ── Init handling (first time only) ──
        // compact_boundary also carries session_id — guard with subtype check
        if (sys.session_id && (sys.subtype === 'init' || !this.claudeSessionId)) {
          const newId = sys.session_id as string
          const expectedId = this._expectedSessionId
          const oldSessionId = this.claudeSessionId
          this.claudeSessionId = newId
          this._expectedSessionId = null
          const initElapsedMs = this._spawnTs ? Date.now() - this._spawnTs : undefined
          log.session.info('session ID from init', {
            sessionId: newId,
            taskId: this.taskId,
            timeToInitMs: initElapsedMs,
            isRemote: !!this._host,
            host: this._host,
          })

          // Rename output file + FIFO to use the real session ID
          if (this._transport) {
            // Update registry: unregister old tmpId → register with real session ID
            if (oldSessionId && oldSessionId !== newId) {
              unregisterSessionManager(oldSessionId)
            }
            this._transport.renameForSession(newId)
            this._outputFile = this._transport.outputFile
            registerSessionManager(newId, this._transport)
          }

          // Capture model from init event — sanitize ANSI codes and validate.
          // sanitizeInitModel strips real ANSI escapes (\x1b[...) while preserving
          // the legitimate [1m] context window marker, then rejects malformed results.
          const rawModel = typeof sys.model === 'string' && sys.model
            ? sanitizeInitModel(sys.model)
            : undefined
          if (rawModel) {
            this._initModel = rawModel
            // Extract short model ID for display (e.g. "claude-opus-4-6" or "claude-opus-4-6[1m]")
            const shortModel = rawModel.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || rawModel
            this._model = shortModel
          } else if (typeof sys.model === 'string' && sys.model) {
            // sanitizeInitModel rejected the string — log so we can diagnose.
            log.session.warn('init model failed validation, using raw', {
              rawModel: sys.model, sessionId: newId,
            })
            // Fall back to raw string with only ESC-prefix ANSI stripped
            // eslint-disable-next-line no-control-regex
            const fallback = sys.model.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            this._initModel = fallback
            const shortModel = fallback.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || fallback
            this._model = shortModel
          }

          // Persist session record BEFORE resolving sessionReady — callers must not
          // receive the session ID until sessions.json is written.  Without this,
          // concurrent starts could return an ID that has no matching record.
          // handleStreamLine is sync, so we wrap in an async IIFE.
          const initModel = rawModel
          ;(async () => {
            try {
              if (expectedId && expectedId !== newId) {
                // Resume failed — Claude created a new session. Rename the original record's
                // ID to the new ID so history/UI stays connected.
                log.session.warn('resume produced different session ID, renaming record', {
                  expectedSessionId: expectedId, actualSessionId: newId, taskId: this.taskId,
                })
                const { renameSessionId } = await import('../core/session-tracker.js')
                const renamed = await renameSessionId(expectedId, newId, {
                  outputFile: this._outputFile ?? undefined,
                  pid: this.pid ?? undefined,
                })
                if (!renamed) {
                  // Original record not found — fall back to creating a fresh record
                  await this.persistSessionRecord(newId, this._cwd ?? undefined)
                }
              } else {
                await this.persistSessionRecord(newId, this._cwd ?? undefined)
              }
              // Write model after persist — record is guaranteed to exist now
              if (initModel) {
                const { updateSessionRecord } = await import('../core/session-tracker.js')
                await updateSessionRecord(newId, { model: initModel })
              }
            } catch (err) {
              // Persist failed — log loudly but still resolve so the session isn't stuck.
              // The session process IS running, just not registered.
              log.session.error('CRITICAL: session record persist failed — session will be unregistered', {
                sessionId: newId, taskId: this.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            } finally {
              // Always resolve — the process is already alive regardless of persist outcome
              this._resolveSessionReady(newId)
            }
          })()

          // Re-emit status now that claudeSessionId is set (first emit at spawn had null ID)
          this.emitStatusChanged('IN_PROGRESS')
        }

        // Parse permissionMode from ANY system event (init or status).
        // - init: every CLI startup/resume → ground truth verification
        // - status: EnterPlanMode → real-time mode change detection
        // ExitPlanMode does NOT emit system event → handled by tool_use detection above.
        const permMode = sys.permissionMode
        if (typeof permMode === 'string') {
          const mapped = mapPermissionMode(permMode)
          if (mapped && mapped !== this._mode) {
            const oldMode = this._mode
            this._mode = mapped
            if (this.claudeSessionId) {
              import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                updateSessionRecord(this.claudeSessionId!, { mode: mapped }).catch(() => {}),
              )
            }
            this.emitStatusChanged('IN_PROGRESS')
            log.session.info('mode updated from JSONL system event', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
              oldMode, newMode: mapped,
              subtype: sys.subtype,
            })
          }
        }

        // ── System event notifications for UI ──
        // Guard: claudeSessionId is null before the init event arrives.
        if (this.claudeSessionId) {
          const sid = this.claudeSessionId
          if (sys.subtype === 'status' && sys.status === 'compacting') {
            this._activity = 'compacting context'
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'compact' as const, message: 'Compacting context...',
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'compact_boundary') {
            const meta = sys.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined
            const pre = meta?.pre_tokens
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'compact' as const, message: 'Context compacted',
              detail: pre ? `${Math.round(pre / 1000)}K tokens` : undefined,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'error_during_execution') {
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'error' as const, message: String(sys.error || 'Execution error'),
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'success') {
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'info' as const, message: 'Operation succeeded',
            }, ['main-ai'], { source: 'session-runner' })
          } else if (sys.subtype && sys.subtype !== 'init' && sys.subtype !== 'status') {
            // Catch-all: unknown future subtypes
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'info' as const, message: String(sys.subtype),
            }, ['main-ai'], { source: 'session-runner' })
          }
        }

        break
      }

      case 'assistant': {
        const msg = event as StreamMessageEvent
        if (!Array.isArray(msg.message?.content)) break
        const parentToolUseId = msg.parent_tool_use_id ?? undefined
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            // Rewrite remote image paths to local paths (no-op for local sessions)
            const text = this.rewriteRemoteImages(block.text)
            if (this.fullText.length < MAX_FULL_TEXT) {
              this.fullText += text
            }
            log.session.debug('JSONL event: text-delta', { sessionId: this.claudeSessionId, taskId: this.taskId })
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: text,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (block.type === 'tool_use') {
            this._activity = `Using ${block.name}`

            // Cache image file paths from tool inputs (e.g. Read tool's file_path).
            // When the tool_result comes back with base64 image content blocks,
            // we use the cached path instead of the base64 data.
            if (block.id && block.input) {
              const imgPath = extractImageFilePathFromInput(block.input as Record<string, unknown>)
              if (imgPath) this._toolInputFilePaths.set(block.id, imgPath)
            }

            // Capture plan file path and content (Claude writes plan to ~/.claude/plans/{slug}.md)
            if (block.name === 'Write' && typeof block.input?.file_path === 'string') {
              if (block.input.file_path.includes('.claude/plans/')) {
                this.planFile = block.input.file_path
                if (typeof block.input.content === 'string') {
                  this._lastPlanWriteContent = block.input.content
                }
              }
            }

            /**
             * ExitPlanMode detection — plan phase is complete.
             *
             * ┌─────────────────────────────────────────────────────────────────┐
             * │ SESSION MODE TRANSITION — HOW IT WORKS END-TO-END              │
             * │                                                                │
             * │ PROBLEM (empirically verified via 4 real CLI tests):           │
             * │ In `-p` (non-interactive) mode, ExitPlanMode returns           │
             * │ is_error=true because the CLI needs an interactive user to     │
             * │ approve the plan. The CLI does NOT switch permissions and      │
             * │ does NOT emit a system status event.                           │
             * │                                                                │
             * │ Therefore Walnut keeps the mode unchanged here. The session      │
             * │ stays 'plan' until the user explicitly clicks Execute, which   │
             * │ sends mode:'bypass' via the /execute-continue route.           │
             * │                                                                │
             * │ FLOW (plan session):                                           │
             * │  1. send(--permission-mode plan) → _mode = 'plan'             │
             * │  2. Claude plans, calls ExitPlanMode                           │
             * │  3. CLI returns is_error=true (can't exit without user)        │
             * │  4. THIS HANDLER: planCompleted=true, _mode stays 'plan'      │
             * │  5. emitStatusChanged() → WS → UI shows Execute button        │
             * │  6. updateSessionRecord(planCompleted, planFile) → sessions    │
             * │  7. Turn ends, process stops                                   │
             * │  8. Human clicks Execute → POST /execute-continue              │
             * │  9. Route explicitly sends mode:'bypass' to processNext()      │
             * │     → --permission-mode bypassPermissions                      │
             * │ 10. CLI starts in bypass → Claude can Write/Edit/Bash          │
             * │                                                                │
             * │ FLOW (bypass session, voluntary planning):                     │
             * │  1. send(--permission-mode bypass) → _mode = 'bypass'         │
             * │  2. Claude voluntarily plans, calls ExitPlanMode               │
             * │  3. THIS HANDLER: _mode unchanged (still 'bypass')            │
             * │  4. No spurious "Plan" badge, resume stays bypass              │
             * │                                                                │
             * │ Test evidence:                                                 │
             * │  - test-plan-exit-then-bash.jsonl: ExitPlanMode is_error=true, │
             * │    no system status event, Claude stays in plan mode           │
             * │  - test-bypass-enterplan.jsonl: EnterPlanMode DOES emit        │
             * │    system status event (asymmetric behavior)                   │
             * │  - Session 7035c120: bypass session called ExitPlanMode,       │
             * │    old code overwrote mode to 'plan' (wrong!)                  │
             * └─────────────────────────────────────────────────────────────────┘
             */
            if (block.name === 'ExitPlanMode') {
              this.planCompleted = true
              this._activity = 'plan complete'
              // Keep _mode unchanged — a plan session stays 'plan', a bypass session stays 'bypass'.
              // Execute routes pass mode:'bypass' explicitly, so record.mode is not used for that.

              // Persist planCompleted + planFile immediately so the flag survives crashes/restarts.
              if (this.claudeSessionId) {
                import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                  updateSessionRecord(this.claudeSessionId!, { planCompleted: true, planFile: this.planFile ?? undefined })
                    .catch(() => {}),
                )
              }
              // Notify frontend so it can show the Execute button once the session stops
              this.emitStatusChanged('IN_PROGRESS')
            }

            // ── AskUserQuestion auto-intercept ──
            // In -p (non-interactive) mode, AskUserQuestion never reaches the user.
            // Claude often calls it repeatedly (7+ times), wasting tokens.
            // Auto-inject a corrective message once per turn so Claude stops trying.
            if (block.name === 'AskUserQuestion' && !this._askUserIntercepted && this._transport?.hasPipe) {
              this._askUserIntercepted = true
              const correction = 'You are running in non-interactive (-p) mode. '
                + 'The user cannot see AskUserQuestion — it will always fail here. '
                + 'Instead, print your questions or assumptions directly in your text output, and wait for user response.'
              Promise.resolve(this._transport?.writeMessage(correction)).then((injected) => {
                log.session.info('auto-intercepted AskUserQuestion in -p mode', {
                  sessionId: this.claudeSessionId,
                  taskId: this.taskId,
                  injected: injected ?? false,
                })
              }).catch(() => {})
            }

            // For ExitPlanMode, resolve plan content: prefer captured Write content, fall back to input.plan
            const exitPlanContent = block.name === 'ExitPlanMode'
              ? (this._lastPlanWriteContent
                ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : null))
              : null

            log.session.debug('JSONL event: tool-use', { sessionId: this.claudeSessionId, taskId: this.taskId, toolName: block.name })
            bus.emit(EventNames.SESSION_TOOL_USE, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              toolName: block.name,
              toolUseId: block.id,
              input: block.input,
              ...(exitPlanContent ? { planContent: exitPlanContent } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
            }, ['main-ai'], { source: 'session-runner' })
          }
        }

        // ── Emit context window usage from assistant message ──
        // Skip subagent messages — Agent/Task tool calls produce assistant messages
        // with their own independent (smaller) context windows.  Without this guard,
        // the UI bounces between parent (248K) and subagent (50K) context percentages.
        // parent_tool_use_id is null for parent conversation, set for subagents.
        if (parentToolUseId) break
        // Context % = totalInput / contextWindowSize * 100
        //   totalInput = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        //   These three fields are mutually exclusive (no overlap):
        //     - input_tokens: tokens NOT read from or written to cache
        //     - cache_creation_input_tokens: tokens written to cache this request
        //     - cache_read_input_tokens: tokens read from cache
        //   Their sum = total prompt size = context window usage.
        //   NOT capped at 100 — values >100% indicate wrong contextWindowSize detection.
        if (this.claudeSessionId && msg.message) {
          const usage = msg.message.usage
          if (usage) {
            const totalInput = usage.input_tokens
              + (usage.cache_creation_input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
            // Detect context window size:
            //   1) init model string contains [1m] → 1M
            //   2) totalInput > 200K → must be 1M (defense-in-depth: processNext
            //      now preserves record.model on resume, but this catches any
            //      other code path that might lose the [1m] suffix)
            //   3) default → 200K
            const is1M = (this._initModel?.includes('[1m]') ?? false)
              || totalInput > CONTEXT_WINDOW_DEFAULT
            const contextWindowSize = is1M ? 1_000_000 : 200_000
            const contextPercent = Math.round(totalInput / contextWindowSize * 100)
            // Use assistant message model only as fallback when init event didn't
            // provide one. Init model is the source of truth — it reflects the
            // configured --model flag. Claude Code routes Agent subagent calls to
            // cheaper models (Haiku), and those appear as assistant messages with a
            // different model string. Legit model switches (via /model command)
            // trigger a --resume which fires a new init event, updating _model there.
            const msgModel = msg.message.model
            if (typeof msgModel === 'string' && msgModel && !this._model) {
              this._model = msgModel
            }
            bus.emit(EventNames.SESSION_USAGE_UPDATE, {
              sessionId: this.claudeSessionId,
              model: this._model,
              contextPercent,
              inputTokens: totalInput,
            }, ['main-ai'], { source: 'session-runner' })
          }
        }
        break
      }

      case 'user': {
        const msg = event as StreamMessageEvent
        // Skip synthetic walnut-injected user events (content is a plain string).
        // Only process Claude Code's canonical user events (content is an array
        // of tool_result blocks). Synthetic events exist in the streams file for
        // history reads — emitting them here would duplicate the optimistic copy.
        if (!Array.isArray(msg.message?.content)) break
        const userParentToolUseId = msg.parent_tool_use_id ?? undefined
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            let resultContent: string
            // If the tool_result has image content blocks, use the cached file path
            // from the tool_use input instead of the base64 data. This keeps the
            // streaming pipeline lightweight — paths are short and the frontend's
            // findImagePaths() detects them and renders via /api/local-image.
            const hasImageBlocks = Array.isArray(block.content) && block.content.some((c: Record<string, unknown>) => c.type === 'image')
            const cachedPath = block.tool_use_id ? this._toolInputFilePaths.get(block.tool_use_id) : undefined
            if (hasImageBlocks && cachedPath) {
              // Use the file path from the tool input — avoids piping 130K+ base64 through the bus
              resultContent = cachedPath
              this._toolInputFilePaths.delete(block.tool_use_id as string)
            } else if (hasImageBlocks) {
              // Image blocks but no cached path (e.g. screenshot tool without file_path input).
              // Don't serialize the base64 blob — just note it's an image.
              resultContent = '[image]'
            } else {
              const rawResult = typeof block.content === 'string'
                ? block.content
                : (block.content != null ? JSON.stringify(block.content) : '')
              resultContent = rawResult
            }
            // Rewrite remote image paths in tool results (no-op for local sessions)
            resultContent = this.rewriteRemoteImages(resultContent)
            log.session.debug('JSONL event: tool-result', { sessionId: this.claudeSessionId, taskId: this.taskId, toolUseId: block.tool_use_id })
            bus.emit(EventNames.SESSION_TOOL_RESULT, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              toolUseId: block.tool_use_id,
              result: resultContent.slice(0, 2000),
              ...(userParentToolUseId ? { parentToolUseId: userParentToolUseId } : {}),
            }, ['main-ai'], { source: 'session-runner' })
          }
        }
        break
      }

      case 'result': {
        // Guard against duplicate result events. Daemon resume can replay old JSONL lines
        // (e.g., if the daemon re-reads from file start), and without this check the old
        // result would emit a second SESSION_RESULT, causing duplicate responses in the UI.
        if (this._turnResultEmitted) {
          log.session.debug('ignoring duplicate result event (already emitted for this turn)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
          })
          break
        }

        const result = event as StreamResultEvent

        // Detect stale/replayed result events for remote sessions.
        // If the cumulative cost is identical to the previous turn's cost, the CLI
        // didn't make an API call — the daemon replayed old JSONL events (e.g., after
        // a FIFO write to a stuck process that echoed the old result without processing).
        // Skip this check for the first result (no previous cost) and for error results.
        if (this._transport?.isRemote
          && this._lastResultCost !== undefined
          && result.total_cost_usd !== undefined
          && result.total_cost_usd === this._lastResultCost
          && !result.is_error) {
          log.session.warn('stale result detected (cost unchanged) — forcing --resume on next message', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            cost: result.total_cost_usd, prevCost: this._lastResultCost,
          })
          // Mark pipe as dead so processNext falls through to --resume spawn
          // instead of writing to a potentially broken FIFO.
          if (this._transport) {
            (this._transport as import('./remote-session-manager.js').RemoteSessionManager).deletePipe()
          }
        }

        // Track cost for stale detection on next turn
        if (result.total_cost_usd !== undefined) {
          this._lastResultCost = result.total_cost_usd
        }

        // On error, keep the original session ID so events reach the frontend
        // (Claude CLI assigns a new throwaway ID even when --resume fails)
        if (result.session_id && !result.is_error) {
          this.claudeSessionId = result.session_id
        }

        // Extract error messages from the result (e.g. "No conversation found with session ID: ...")
        let resultText = result.result ?? this.fullText
        const resultErrors = Array.isArray((result as Record<string, unknown>).errors)
          ? ((result as Record<string, unknown>).errors as string[])
          : undefined
        if (result.is_error && resultErrors?.length) {
          let errorMsg = resultErrors.join('; ')
          // Add cwd hint — Claude CLI uses cwd to resolve session storage path,
          // so a renamed/moved project directory causes "No conversation found"
          if (errorMsg.includes('No conversation found')) {
            errorMsg += ` (cwd: ${this._cwd ?? 'unknown'} — the project directory may have changed since this session was created)`
          }
          resultText = errorMsg
        }

        log.session.info('session result received', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          cost: result.total_cost_usd,
          isError: result.is_error,
          hasFifo: this._transport?.hasPipe ?? false,
          ...(resultErrors?.length ? { errors: resultErrors } : {}),
        })

        if (this.claudeSessionId) {
          this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
            log.session.warn('persistSessionRecord failed (result handler)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
          })
        }

        // Process liveness check for deciding FIFO-alive vs exited.
        // Local: process.kill(pid, 0) — quick and reliable.
        // Remote: local PID check is meaningless (PID is on the remote host).
        //   For remote sessions, trust _hasPipe — it's cleared when the daemon
        //   sends an 'exit' event or when the FIFO write fails (ENXIO/EAGAIN).
        let processStillAlive = false
        if (this._transport?.isRemote) {
          // Remote: process.kill can't reach remote PID. Trust hasPipe instead.
          processStillAlive = this._transport.hasPipe
        } else if (this.pid !== null) {
          try { process.kill(this.pid, 0); processStillAlive = true } catch { /* dead */ }
        }
        if (this._transport?.hasPipe && processStillAlive) {
          // stream-json FIFO mode: process is still alive between turns.
          // Works for both local and remote sessions now that remote uses hasPipe
          // for the liveness signal instead of local PID checks.
          this._processStatus = 'idle'  // Turn done, process alive, waiting for next writeMessage()
          this._activity = undefined
          this.resultEmitted = false  // Ready for next turn
        } else if (this._transport?.isRemote && !result.is_error) {
          // Remote daemon session: process exited (hasPipe was cleared by daemon exit
          // event or FIFO write failure), but daemon connection is still alive.
          // Show 'idle' so user can send follow-up messages (triggers --resume).
          this.resultEmitted = true
          this._active = false
          this._processStatus = 'idle'
          this._activity = undefined
          // Clear PID — the remote process exited. Prevents stale local PID checks.
          this.pid = null
          if (this.claudeSessionId) {
            const sid = this.claudeSessionId
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(sid, { pid: undefined }),
            ).catch(() => {})
          }
        } else {
          // Process is exiting (SSH, interrupted, or natural exit)
          this.resultEmitted = true
          this._active = false
          this._processStatus = 'stopped'
          this._activity = undefined
          this.stopMonitoring()

          // Clear PID from record to prevent stale PID orphan kills on future PID reuse
          if (this.claudeSessionId) {
            const sid = this.claudeSessionId
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(sid, { pid: undefined }),
            ).catch((err) => {
              log.session.warn('failed to clear PID on process exit', { sessionId: sid, error: String(err) })
            })
          }
        }

        this.emitStatusChanged('AGENT_COMPLETE')

        this._turnResultEmitted = true
        log.session.info('session result emitted', { sessionId: this.claudeSessionId, taskId: this.taskId, resultLength: resultText?.length ?? 0 })
        bus.emit(EventNames.SESSION_RESULT, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          result: resultText,
          totalCost: result.total_cost_usd,
          duration: result.duration_ms,
          isError: result.is_error ?? false,
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })

        break
      }

      default:
        log.session.debug('ignoring unknown stream event type', { taskId: this.taskId, type: (event as { type: string }).type })
        break
      }
    } catch (err) {
      log.session.warn('error processing stream event', {
        taskId: this.taskId,
        type: (event as { type: string }).type,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private emitStatusChanged(phase: TaskPhase): void {
    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: this.claudeSessionId,
      taskId: this.taskId,
      process_status: this._processStatus,
      phase,
      mode: this._mode,
      activity: this._activity,
      ...(this.planCompleted ? { planCompleted: true } : {}),
      ...(this.fromPlanSessionId ? { fromPlanSessionId: this.fromPlanSessionId } : {}),
      ...(this.forkedFromSessionId ? { forkedFromSessionId: this.forkedFromSessionId } : {}),
    }, ['*'], { source: 'session-runner', urgency: 'urgent' })
  }

  private async persistSessionRecord(claudeSessionId: string, cwd?: string): Promise<void> {
    const { createSessionRecord } = await import('../core/session-tracker.js')
    await createSessionRecord(claudeSessionId, this.taskId, this.project, cwd, {
      pid: this.pid ?? undefined,
      outputFile: this._outputFile ?? undefined,
      title: this.pendingTitle,
      description: this.pendingDescription,
      mode: this._mode,
      planFile: this.planFile ?? undefined,
      planCompleted: this.planCompleted ? true : undefined,
      host: this._host ?? undefined,
      fromPlanSessionId: this.fromPlanSessionId,
      forkedFromSessionId: this.forkedFromSessionId,
      cliModel: this._cliModel,
    })
  }
}

// ── SessionRunner ──

export class SessionRunner {
  private sessions = new Map<string, ClaudeCodeSession>()
  private cliCommand: string
  private activeProcessing = new Set<string>()
  private batchCounts = new Map<string, number>()
  /** Safety timers that auto-clear stuck activeProcessing entries */
  private activeProcessingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** SDK session server client (set via setSdkClient when session_server.enabled) */
  private sdkClient: SessionServerClient | null = null
  /** Track SDK session IDs mapped to their task IDs for event routing */
  private sdkSessionMap = new Map<string, string>()

  constructor(cliCommand?: string) {
    this.cliCommand = cliCommand ?? 'claude'
  }

  /**
   * Override the CLI command used to spawn sessions.
   * Useful for E2E tests that wire in a mock CLI script.
   */
  setCliCommand(cmd: string): void {
    this.cliCommand = cmd
  }

  /** Direct WebSocket URL for daemon transport (test-only, bypasses SSH). */
  private _testDaemonUrl: string | undefined

  /**
   * Set a direct WebSocket URL for RemoteSessionManager, bypassing SSH.
   * Used by E2E tests with MockDaemon.
   */
  setTestDaemonUrl(url: string | undefined): void {
    this._testDaemonUrl = url
  }

  /**
   * Clear activeProcessing + batchCounts + safety timer for a session.
   * Centralizes cleanup to prevent dangling timers or stale entries.
   */
  private clearActiveProcessing(sessionId: string): void {
    this.activeProcessing.delete(sessionId)
    this.batchCounts.delete(sessionId)
    const timer = this.activeProcessingTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.activeProcessingTimers.delete(sessionId)
    }
  }

  /**
   * Add a session to activeProcessing with a safety timeout.
   * The timeout auto-clears the entry after 60s to prevent permanent stuck state
   * (e.g., if SESSION_RESULT arrives with a mismatched session ID).
   */
  private setActiveProcessing(sessionId: string, batchCount: number): void {
    this.activeProcessing.add(sessionId)
    this.batchCounts.set(sessionId, batchCount)

    // Cancel any existing safety timer for this sessionId
    const existingTimer = this.activeProcessingTimers.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)

    // Set safety timeout — prevents permanent stuck state
    const timer = setTimeout(() => {
      if (this.activeProcessing.has(sessionId)) {
        log.session.warn('activeProcessing safety timeout (60s): force-clearing stuck entry', { sessionId })
        this.activeProcessing.delete(sessionId)
        this.batchCounts.delete(sessionId)
        this.activeProcessingTimers.delete(sessionId)
        // Try to process next messages if any accumulated while stuck
        this.processNext(sessionId).catch(() => {})
      }
    }, 60_000)
    timer.unref()
    this.activeProcessingTimers.set(sessionId, timer)
  }

  /**
   * Set the SDK session server client for SDK-based sessions.
   * When set, new sessions will use the SDK path instead of CLI.
   */
  setSdkClient(client: SessionServerClient): void {
    this.sdkClient = client
  }

  /**
   * Subscribe to the event bus and handle session lifecycle events.
   * Optionally reconnect to sessions that survived a server restart.
   */
  init(reconnectable?: SessionRecord[]): void {
    // Reconnect to surviving sessions + startup recovery (async)
    const startupRecovery = async () => {
      // Phase 1: reconnect to surviving sessions
      if (reconnectable?.length) {
        for (const record of reconnectable) {
          try {
            const session = await ClaudeCodeSession.attachToExisting(record, this.cliCommand, this._testDaemonUrl)
            const mapKey = record.taskId || `reconnected-${record.claudeSessionId}`
            this.sessions.set(mapKey, session)
            log.session.info('reconnected to surviving session', {
              sessionId: record.claudeSessionId,
              taskId: record.taskId,
              pid: record.pid,
            })
          } catch (err) {
            log.session.warn('failed to reconnect to session', {
              sessionId: record.claudeSessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      // Phase 2: load queue from disk, re-process pending messages.
      // Race condition: the REST API starts accepting /send requests before SessionRunner
      // initialization completes. Messages received during this window get persisted to
      // the queue file, but the corresponding SESSION_SEND bus events fire before any
      // subscriber exists — so they're lost. Previously we skipped reconnected (alive)
      // sessions here, assuming their process would handle it. But that's wrong: the
      // queued message never reaches the FIFO because processNext() was never called.
      // Fix: process ALL pending queues including alive sessions. processNext() detects
      // alive sessions and uses the FIFO write path (not --resume spawn), so this is safe.
      await loadQueue()
      const pendingSessions = await getAllSessionsWithPending()
      for (const sessionId of pendingSessions) {
        log.session.info('recovering pending queue messages on startup', { sessionId })
        this.processNext(sessionId).catch((err) => {
          log.session.error('startup queue recovery failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
        })
      }
    }

    startupRecovery().catch((err) => {
      log.session.error('startup recovery failed', { error: err instanceof Error ? err.message : String(err) })
    })

    bus.subscribe('session-runner', async (event) => {
      switch (event.name) {
        case EventNames.SESSION_START: {
          const startData = eventData<'session:start'>(event)
          log.session.info('session start requested', { taskId: startData.taskId, host: startData.host, cwd: startData.cwd, mode: startData.mode })
          if (this.sdkClient?.connected) {
            log.session.info('session routing', { taskId: startData.taskId, type: 'sdk' })
            await this.handleStartSdk(startData)
          } else {
            log.session.info('session routing', { taskId: startData.taskId, type: 'cli' })
            await this.handleStart(startData)
          }
        }
          break

        case EventNames.SESSION_SEND: {
          const sendData = eventData<'session:send'>(event)
          log.session.info('session send requested', { sessionId: sendData.sessionId, messageLength: sendData.message.length })
          // Route to SDK if this session is tracked as an SDK session
          if (this.sdkSessionMap.has(sendData.sessionId)) {
            await this.handleSendSdk(sendData.sessionId, sendData.message, sendData.mode as SessionMode | undefined, sendData.interrupt)
          } else {
            await this.handleSend(sendData)
          }
        }
          break

        case EventNames.SESSION_RESULT:
        case EventNames.SESSION_ERROR: {
          const { sessionId } = eventData<'session:result'>(event)
          if (!sessionId) break

          // Persist process_status to sessions.json.
          // Trust the in-memory processStatus that handleStreamEvent() already computed
          // (idle for FIFO-alive and remote --resume, stopped for dead processes).
          // Don't re-derive — that caused a bug where remote --resume sessions
          // (active=false but processStatus='idle') were incorrectly written as 'stopped'.
          {
            const isError = event.name === EventNames.SESSION_ERROR
              || (eventData<'session:result'>(event) as { isError?: boolean }).isError === true
            const errorMessage = isError
              ? ((eventData<'session:error'>(event) as { error?: string }).error ?? 'Unknown error').slice(0, 1000)
              : undefined
            const cliSession = this.findSessionByClaudeId(sessionId)
            const status = isError ? 'error' : (cliSession?.processStatus ?? 'stopped')

            import('../core/session-tracker.js').then(({ updateSessionRecord, getSessionByClaudeId }) => {
              updateSessionRecord(sessionId, {
                process_status: status,
                errorMessage: isError ? errorMessage : undefined,
                activity: undefined,
                last_status_change: new Date().toISOString(),
                status_reason: isError ? 'api_error' : (status === 'idle' ? 'turn_completed' : 'normal_completion'),
                status_changed_by: 'session-runner',
              } as any).then(() => {
                // Clear task session slot only when truly stopped/error
                if (status === 'stopped' || status === 'error') {
                  getSessionByClaudeId(sessionId).then(rec => {
                    if (rec?.taskId) {
                      import('../core/task-manager.js').then(({ clearSessionSlot }) => {
                        clearSessionSlot(rec.taskId!, sessionId).catch(() => {})
                      }).catch(() => {})
                    }
                  }).catch(() => {})
                }
              }).catch(() => {})
            }).catch(() => {})
          }

          // Clear activeProcessing — try direct match first, fall back to taskId match.
          // Session ID can change when --resume fails and Claude creates a new session.
          let resolvedSessionId = sessionId
          if (!this.activeProcessing.has(sessionId)) {
            const taskId = eventData<'session:result'>(event).taskId
            if (taskId) {
              for (const activeId of this.activeProcessing) {
                // The session object's sessionId was already updated to the new ID,
                // so we can't match via findSessionByClaudeId(activeId).
                // Instead, check if any session in our Map has this taskId and its
                // old sessionId is the one stuck in activeProcessing.
                for (const [mapKey, session] of this.sessions) {
                  if ((mapKey === taskId || session.taskId === taskId) && activeId !== sessionId) {
                    resolvedSessionId = activeId
                    log.session.warn('SESSION_RESULT: sessionId mismatch — matched via taskId', {
                      expectedSessionId: activeId,
                      actualSessionId: sessionId,
                      taskId,
                    })
                    break
                  }
                }
                if (resolvedSessionId !== sessionId) break
              }
            }
          }

          const batchCount = this.batchCounts.get(resolvedSessionId) ?? 1
          this.clearActiveProcessing(resolvedSessionId)

          // Remove completed messages from disk
          removeProcessed(sessionId).catch((err) => {
            log.session.warn('failed to remove processed queue messages', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })

          // Tell frontend how many optimistic messages to clear
          bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
            sessionId,
            count: batchCount,
          }, ['main-ai'], { source: 'session-runner' })

          // Process next batch if any new messages arrived during processing
          this.processNext(sessionId).catch((err) => {
            log.session.error('processNext failed after result/error', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })
          break
        }
      }
    })
  }

  /**
   * Detach from all sessions (they survive) and unsubscribe.
   * Use this for graceful server shutdown — sessions continue running.
   */
  destroy(): void {
    for (const [, session] of this.sessions) {
      session.detach()
    }
    this.sessions.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.sdkSessionMap.clear()
    if (this.sdkClient) {
      this.sdkClient.destroy()
      this.sdkClient = null
    }
    // Disconnect all daemon connections (SSH tunnels) on server shutdown
    import('./daemon-connection.js').then(({ disconnectAllDaemons }) => {
      disconnectAllDaemons()
    }).catch(() => {})
    bus.unsubscribe('session-runner')
  }

  /**
   * Kill all sessions and unsubscribe.
   * Use this for explicit "stop everything" (e.g., tests, user request).
   */
  destroyAndKill(): void {
    for (const [, session] of this.sessions) {
      session.kill()
    }
    // Stop SDK sessions via session server
    if (this.sdkClient?.connected) {
      for (const [sessionId] of this.sdkSessionMap) {
        this.sdkClient.stopSession({ sessionId }).catch(() => {})
      }
    }
    this.sessions.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.sdkSessionMap.clear()
    if (this.sdkClient) {
      this.sdkClient.destroy()
      this.sdkClient = null
    }
    bus.unsubscribe('session-runner')
  }

  /**
   * Get a session by task ID.
   */
  getByTaskId(taskId: string): ClaudeCodeSession | undefined {
    return this.sessions.get(taskId)
  }

  /**
   * Find a live session by its Claude session ID (iterates all sessions).
   */
  findByClaudeId(claudeSessionId: string): ClaudeCodeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === claudeSessionId) return session
    }
    return undefined
  }

  /**
   * Kill orphaned claude processes from stopped/terminal sessions.
   * Scans sessions.json for sessions with PIDs where process_status is 'stopped'
   * or in terminal state, but the OS process is still alive.
   * This prevents accumulation of zombie claude processes over time.
   */
  private async killOrphanedSessionProcesses(): Promise<void> {
    try {
      const { listSessions, isTerminalSession } = await import('../core/session-tracker.js')
      const sessions = await listSessions()

      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Kill processes for sessions that are stopped/error or in terminal state
        const shouldBeDeadByStatus = s.process_status === 'stopped' || s.process_status === 'error'
        if (!shouldBeDeadByStatus && !isTerminalSession(s)) continue

        const processName = s.host ? 'ssh' : 'claude'
        if (!await isProcessAliveAsync(s.pid, processName)) continue

        // Process is alive but session is done — kill it
        log.session.warn('killing orphaned session process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
        })

        try { process.kill(s.pid, 'SIGTERM') } catch { /* already dead */ }
        killed++
      }

      if (killed > 0) {
        log.session.info('killed orphaned session processes', { count: killed })
      }
    } catch (err) {
      log.session.warn('killOrphanedSessionProcesses failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Find an in-memory CLI session by its Claude session ID.
   */
  private findSessionByClaudeId(claudeSessionId: string): ClaudeCodeSession | undefined {
    for (const [, session] of this.sessions) {
      if (session.sessionId === claudeSessionId) return session
    }
    return undefined
  }

  /**
   * Public entry point for starting a session.
   * Returns the Claude session ID once the process emits its init event.
   * The tool can await this to include the session ID in its response.
   *
   * Routes to SDK session server when sdkClient is set, otherwise falls back to CLI.
   */
  async startSession(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    // Route to SDK session server when available and connected
    if (this.sdkClient?.connected) {
      return this.handleStartSdk(data)
    }

    const startTs = Date.now()
    const { sessionReady, title } = await this.handleStart(data)
    const handleStartMs = Date.now() - startTs
    if (handleStartMs > 2000) {
      log.session.warn('handleStart took unexpectedly long', {
        taskId: data.taskId,
        host: data.host,
        handleStartMs,
      })
    }

    // Session init timeout. Local new sessions take 1-2s from the console.
    // Remote adds SSH/wssh/shell overhead (~5-10s). 90s for remote gives margin
    // while timing logs (first JSONL line, timeToInitMs) collect data to find
    // the real bottleneck — remote new sessions shouldn't take >10s but sometimes
    // exceed 30s for unknown reasons (wssh relay? devdesk load?).
    const isRemote = !!data.host
    const initTimeoutMs = isRemote ? 90_000 : 30_000

    let timer: ReturnType<typeof setTimeout>
    const claudeSessionId = await Promise.race([
      sessionReady,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          log.session.error(`session init timeout — ${initTimeoutMs / 1000}s exceeded`, {
            taskId: data.taskId,
            host: data.host,
            isRemote,
            totalElapsedMs: Date.now() - startTs,
            handleStartMs,
          })
          reject(new Error(`session init timed out after ${initTimeoutMs / 1000}s`))
        }, initTimeoutMs)
      }),
    ]).finally(() => clearTimeout(timer!))

    log.session.info('session ready', {
      claudeSessionId,
      host: data.host,
      totalStartMs: Date.now() - startTs,
      handleStartMs,
    })
    return { claudeSessionId, title }
  }

  private async handleStart(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
  }): Promise<{ sessionReady: Promise<string>; title: string }> {
    const { taskId, project, mode, model } = data
    let cwd = data.cwd
    let { message } = data
    log.session.info('starting session', { taskId: taskId || '(taskless)', project, host: data.host })

    // Resolve cwd if not provided — defense-in-depth for RPC/bus paths that
    // bypass the agent tool's resolveSessionContext().
    if (!cwd && taskId) {
      try {
        const { getTask, getProjectMetadata } = await import('../core/task-manager.js')
        const task = await getTask(taskId)
        if (task) {
          // Walk parent chain for task.cwd
          let current: typeof task | undefined = task
          const seen = new Set<string>()
          while (current && !cwd) {
            if (current.cwd) { cwd = current.cwd; break }
            if (!current.parent_task_id || seen.has(current.parent_task_id)) break
            seen.add(current.id)
            current = await getTask(current.parent_task_id).catch(() => undefined)
          }
          // Project metadata default_cwd
          if (!cwd) {
            const metadata = await getProjectMetadata(task.category, task.project)
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          // Last resort: project memory directory
          if (!cwd) {
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
            nodeFs.mkdirSync(projectDir, { recursive: true })
            cwd = projectDir
          }
        }
      } catch (err) {
        log.session.warn('handleStart: cwd resolution failed', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Prune completed taskless sessions to prevent unbounded Map growth
    for (const [key, s] of this.sessions) {
      if (key.startsWith('taskless-') && !s.active) {
        this.sessions.delete(key)
      }
    }

    // Kill orphaned processes from stopped/terminal sessions to prevent accumulation.
    // Over time, claude processes can leak (e.g. idle timeout GC'd, server restart
    // orphaned the in-process timer). This ensures we don't exhaust OS resources.
    await this.killOrphanedSessionProcesses()

    const mapKey = taskId || `taskless-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (taskId) {
      const existing = this.sessions.get(taskId)
      if (existing?.active) {
        log.session.warn('overwriting active session Map entry — old process stays alive', {
          taskId, existingPid: existing.processPid,
        })
      }
    }
    const session = new ClaudeCodeSession(taskId, project ?? '', this.cliCommand)
    session._testDaemonUrl = this._testDaemonUrl
    if (data.fromPlanSessionId) session.fromPlanSessionId = data.fromPlanSessionId
    if (data.forkedFromSessionId) session.forkedFromSessionId = data.forkedFromSessionId
    this.sessions.set(mapKey, session)

    // Auto-generate title + description
    let taskTitle: string | undefined
    let taskCategory: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        taskCategory = task?.category
      } catch (err) {
        log.session.warn('failed to update task phase on session start', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Use agent-provided title if available, otherwise auto-generate
    if (data.title) {
      session.pendingTitle = data.title
    } else {
      const defaultPromptPrefix = 'Working on task:'
      const isCustomPrompt = !message.startsWith(defaultPromptPrefix)

      if (taskTitle && isCustomPrompt) {
        session.pendingTitle = `${taskTitle} — ${message.slice(0, 80)}`
      } else if (taskTitle) {
        session.pendingTitle = taskTitle
      } else {
        session.pendingTitle = message.slice(0, 120)
      }
    }
    session.pendingDescription = message.slice(0, 500)

    let appendSystemPrompt: string | undefined
    const isFork = !!data.forkedFromSessionId

    // If caller provided an appendSystemPrompt (e.g. custom context), use it.
    // Skip for forks — Claude Code's --fork-session handles conversation context natively.
    // Note: plan content is no longer injected here — it's passed as a file path in the message.
    if (data.appendSystemPrompt && !isFork) {
      appendSystemPrompt = data.appendSystemPrompt
      log.session.info('using caller-provided system prompt', { taskId, promptLength: data.appendSystemPrompt.length })
    }

    // Build session context from task info (task details, project memory, etc.)
    if (taskId) {
      try {
        const { buildSessionContext } = await import('../agent/session-context.js')
        const ctx = await buildSessionContext(taskId, cwd, data.host)
        if (ctx.systemPrompt) {
          // Combine: caller-provided prompt takes priority, task context appended after
          appendSystemPrompt = appendSystemPrompt
            ? `${appendSystemPrompt}\n\n---\n\n## Task Context\n\n${ctx.systemPrompt}`
            : ctx.systemPrompt
          log.session.info('session context built', { taskId, promptLength: ctx.systemPrompt.length })
        }
      } catch (err) {
        log.session.warn('failed to build session context', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Resolve SSH host config and session_model default from config
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()

    // Resolve model: explicit caller value > config default > hardcoded 'opus' fallback in send()
    const resolvedModel = model ?? config.agent?.session_model

    // Resolve SSH host config if specified
    let sshTarget: SshTarget | undefined
    if (data.host) {
      const hostDef = config.hosts?.[data.host]
      if (!hostDef) {
        throw new Error(`Unknown host "${data.host}" — configure it in config.yaml under hosts.${data.host}`)
      }
      // Support both 'hostname' and legacy 'ssh' field names
      const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
      if (!hostname) {
        throw new Error(`Host "${data.host}" is missing 'hostname' field in config.yaml`)
      }
      sshTarget = {
        hostname,
        user: hostDef.user,
        port: hostDef.port,
        shell_setup: hostDef.shell_setup,
      }
    }

    // Local images are uploaded to the remote host by RemoteSessionManager.prepareOutbound()
    // called inside start() and writeMessage(). No manual SCP transfer needed.

    const sessionTitle = session.pendingTitle ?? message.slice(0, 120)
    // For forks: pass source session ID as resumeSessionId with forkSession=true.
    // Claude Code's --resume + --fork-session creates a new session with full context.
    const resumeId = isFork ? data.forkedFromSessionId : undefined
    session.send(message, cwd, resumeId, mode, resolvedModel, appendSystemPrompt, data.host, sshTarget, isFork)

    // Record directory usage for the frequent-dirs persistent store (fire-and-forget)
    if (cwd) {
      import('../core/frequent-dirs.js').then(({ recordDirectory }) => {
        recordDirectory(cwd, data.host ?? null, taskCategory).catch(() => {})
      }).catch(() => {})
    }

    bus.emit(EventNames.SESSION_STARTED, {
      taskId,
      project: project ?? '',
      host: data.host,
    }, ['main-ai'], { source: 'session-runner' })

    // Link session to task once the Claude session ID is known.
    // Runs after SESSION_STARTED so the UI updates immediately.
    if (taskId) {
      session.sessionReady.then(async (claudeSessionId) => {
        try {
          const { linkSessionSlot, linkSession } = await import('../core/task-manager.js')
          const slot = mode === 'plan' ? 'plan' : 'exec' as const
          await linkSessionSlot(taskId, claudeSessionId, slot)
          // Use the task from linkSession (has session_id set) so the browser's
          // React state always receives session_id correctly populated.
          const { task } = await linkSession(taskId, claudeSessionId)
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
        } catch (err) {
          log.session.warn('failed to link session to task', { taskId, error: err instanceof Error ? err.message : String(err) })
        }
      }).catch((err) => {
        // Session failed to initialize (SSH failure, timeout, etc.)
        // Notify web-ui so the pending session panel can show an error.
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.session.warn('session init failed — notifying web-ui', { taskId, error: errorMsg, host: data.host })
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: null,
          taskId,
          error: errorMsg,
        }, ['web-ui'], { source: 'session-init-failure' })
      })
    }

    return { sessionReady: session.sessionReady, title: sessionTitle }
  }

  /**
   * Start a session via the SDK session server.
   * Creates a session record in session-tracker and delegates to the session server client.
   */
  private async handleStartSdk(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    if (!this.sdkClient) throw new Error('SDK client not configured')

    const { taskId, message, project, mode } = data
    let cwd = data.cwd
    log.session.info('starting SDK session', { taskId: taskId || '(taskless)', project, host: data.host })

    // Resolve cwd if not provided (same chain as handleStart)
    if (!cwd && taskId) {
      try {
        const { getTask: getTaskFn, getProjectMetadata } = await import('../core/task-manager.js')
        const task = await getTaskFn(taskId)
        if (task) {
          let current: typeof task | undefined = task
          const seen = new Set<string>()
          while (current && !cwd) {
            if (current.cwd) { cwd = current.cwd; break }
            if (!current.parent_task_id || seen.has(current.parent_task_id)) break
            seen.add(current.id)
            current = await getTaskFn(current.parent_task_id).catch(() => undefined)
          }
          if (!cwd) {
            const metadata = await getProjectMetadata(task.category, task.project)
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          if (!cwd) {
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
            nodeFs.mkdirSync(projectDir, { recursive: true })
            cwd = projectDir
          }
        }
      } catch (err) {
        log.session.warn('handleStartSdk: cwd resolution failed', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Auto-generate title (same logic as CLI path)
    let taskTitle: string | undefined
    let sdkTaskCategory: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        sdkTaskCategory = task?.category
      } catch (err) {
        log.session.warn('failed to update task phase on SDK session start', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    let sessionTitle: string
    if (data.title) {
      sessionTitle = data.title
    } else {
      const defaultPromptPrefix = 'Working on task:'
      const isCustomPrompt = !message.startsWith(defaultPromptPrefix)
      if (taskTitle && isCustomPrompt) {
        sessionTitle = `${taskTitle} — ${message.slice(0, 80)}`
      } else if (taskTitle) {
        sessionTitle = taskTitle
      } else {
        sessionTitle = message.slice(0, 120)
      }
    }

    // Build system prompt
    let systemPrompt: string | undefined
    if (data.appendSystemPrompt) {
      systemPrompt = data.appendSystemPrompt
    }
    if (taskId) {
      try {
        const { buildSessionContext } = await import('../agent/session-context.js')
        const ctx = await buildSessionContext(taskId, cwd, data.host)
        if (ctx.systemPrompt) {
          systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n---\n\n## Task Context\n\n${ctx.systemPrompt}`
            : ctx.systemPrompt
        }
      } catch (err) {
        log.session.warn('failed to build SDK session context', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Map session server mode to SDK permission mode
    const sdkMode = mode === 'bypass' ? 'bypass'
      : mode === 'accept' ? 'accept'
        : mode === 'plan' ? 'plan'
          : 'default'

    // Start via session server client
    const result = await this.sdkClient.startSession({
      message,
      cwd,
      mode: sdkMode,
      systemPrompt,
    })

    const claudeSessionId = result.sessionId

    // Track the SDK session
    this.sdkSessionMap.set(claudeSessionId, taskId)

    // Create session record
    const { createSessionRecord } = await import('../core/session-tracker.js')
    await createSessionRecord(claudeSessionId, taskId, project ?? '', cwd, {
      mode: (mode as SessionMode) ?? 'default',
      title: sessionTitle,
      description: message.slice(0, 500),
      host: data.host,
      provider: 'sdk',
      fromPlanSessionId: data.fromPlanSessionId,
    })

    // Link to task
    if (taskId) {
      try {
        const { linkSessionSlot, linkSession } = await import('../core/task-manager.js')
        const slot = mode === 'plan' ? 'plan' : 'exec' as const
        await linkSessionSlot(taskId, claudeSessionId, slot)
        // Use the task from linkSession (has session_id set) so the browser's
        // React state always receives session_id correctly populated.
        const { task } = await linkSession(taskId, claudeSessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
      } catch (err) {
        log.session.warn('failed to link SDK session to task', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Record directory usage for frequent-dirs store (fire-and-forget)
    if (cwd) {
      import('../core/frequent-dirs.js').then(({ recordDirectory }) => {
        recordDirectory(cwd, data.host ?? null, sdkTaskCategory).catch(() => {})
      }).catch(() => {})
    }

    bus.emit(EventNames.SESSION_STARTED, {
      taskId,
      project: project ?? '',
      host: data.host,
      provider: 'sdk',
    }, ['main-ai'], { source: 'session-runner' })

    return { claudeSessionId, title: sessionTitle }
  }

  /**
   * Send a follow-up message to an SDK session.
   */
  private async handleSendSdk(sessionId: string, message: string, mode?: SessionMode, interrupt?: boolean): Promise<void> {
    if (!this.sdkClient) throw new Error('SDK client not configured')

    // Defensive phase rollback — ensure task is IN_PROGRESS when session resumes
    try {
      const { getSessionByClaudeId } = await import('../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record?.taskId) {
        const { getTask, updateTask, touchLastSessionUpdate } = await import('../core/task-manager.js')
        const { shouldRollbackToInProgress } = await import('../core/phase.js')
        const task = await getTask(record.taskId)
        if (task && shouldRollbackToInProgress(task.phase)) {
          await updateTask(record.taskId, { phase: 'IN_PROGRESS' }, { source: 'phase-rollback' })
          log.session.info('handleSendSdk: rolled back phase to IN_PROGRESS', { taskId: record.taskId, oldPhase: task.phase })
        }
        // Touch last_session_update on resume for "Recent" sidebar sort
        touchLastSessionUpdate(record.taskId).catch(err =>
          log.session.warn('touchLastSessionUpdate failed', { taskId: record.taskId, error: String(err) }))
      }
    } catch { /* best-effort — don't block send */ }

    if (interrupt) {
      await this.sdkClient.interrupt({ sessionId })
    }

    if (mode) {
      await this.sdkClient.setMode({ sessionId, mode })
    }

    await this.sdkClient.sendMessage({ sessionId, message })

    // Update session record — always reset on send (user is actively resuming)
    try {
      const { updateSessionRecord } = await import('../core/session-tracker.js')
      await updateSessionRecord(sessionId, {
        activity: 'Processing follow-up...',
        lastActiveAt: new Date().toISOString(),
      })
    } catch (err) {
      log.session.warn('handleSendSdk: status reset failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async handleSend(data: {
    sessionId: string
    message: string
    mode?: string
    model?: string
    interrupt?: boolean
  }): Promise<void> {
    const { sessionId, mode, model, interrupt } = data

    if (interrupt) {
      // Interrupt: gracefully stop the running session (SIGINT + wait for exit),
      // then process next (which spawns --resume with saved session state)
      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          await session.interrupt()
          break
        }
      }

      // Clean up batch tracking for the interrupted turn
      if (this.activeProcessing.has(sessionId)) {
        const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
        this.clearActiveProcessing(sessionId)

        removeProcessed(sessionId).catch(() => {})

        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId,
          count: oldBatchCount,
        }, ['main-ai'], { source: 'session-runner' })
      }
    }

    // Defensive phase rollback (best-effort, don't block send).
    try {
      const { getSessionByClaudeId, updateSessionRecord } = await import('../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record) {
        // Phase rollback
        if (record.taskId) {
          const { getTask, updateTask, touchLastSessionUpdate } = await import('../core/task-manager.js')
          const { shouldRollbackToInProgress } = await import('../core/phase.js')
          const task = await getTask(record.taskId)
          if (task && shouldRollbackToInProgress(task.phase)) {
            await updateTask(record.taskId, { phase: 'IN_PROGRESS' }, { source: 'phase-rollback' })
            log.session.info('handleSend: rolled back phase to IN_PROGRESS', { taskId: record.taskId, oldPhase: task.phase })
          }
          // Touch last_session_update on resume for "Recent" sidebar sort
          touchLastSessionUpdate(record.taskId).catch(err =>
            log.session.warn('touchLastSessionUpdate failed', { taskId: record.taskId, error: String(err) }))
        }
        // Clear stale error message and update activity on resume
        if (record.process_status === 'error' || record.errorMessage) {
          await updateSessionRecord(sessionId, {
            activity: 'Processing follow-up...',
            errorMessage: undefined,  // Clear stale error on resume
          })
          // Emit status change so frontend clears the error banner immediately
          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId,
            taskId: record.taskId,
            process_status: record.process_status,
            phase: 'IN_PROGRESS',
            activity: 'Processing follow-up...',
          }, ['*'], { source: 'session-runner' })
        }
      }
    } catch (err) {
      log.session.warn('handleSend: phase/status reset failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }

    // pendingModel/pendingMode is saved at the RPC layer (session-chat.ts) BEFORE
    // enqueueMessage, preventing a race with concurrent processNext() calls.

    // If model switch requested on an active session, interrupt to force --resume with new model
    if (model && this.activeProcessing.has(sessionId) && !interrupt) {
      log.session.info('handleSend: forcing interrupt for model switch', { sessionId, model })
      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          await session.interrupt()
          break
        }
      }
      // Clean up batch tracking for the interrupted turn
      if (this.activeProcessing.has(sessionId)) {
        const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
        this.clearActiveProcessing(sessionId)
        removeProcessed(sessionId).catch(() => {})
        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId,
          count: oldBatchCount,
        }, ['main-ai'], { source: 'session-runner' })
      }
    }

    // Message is already enqueued by session:send RPC (or send_to_session agent tool).
    // Trigger processing if not already active.
    if (!this.activeProcessing.has(sessionId)) {
      log.session.info('handleSend: triggering processNext', { sessionId, interrupt: !!interrupt })
      this.processNext(sessionId, mode).catch((err) => {
        log.session.error('processNext failed after send', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })
    } else {
      // Session is mid-turn. Try to inject via stdin pipe (like typing in Claude CLI while it's working).
      // With --input-format stream-json, Claude reads stdin between API rounds (tool calls),
      // so the message is injected immediately rather than waiting for the turn to finish.
      this.injectMidTurn(sessionId).catch((err) => {
        log.session.error('injectMidTurn failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })
    }
  }

  /**
   * Inject a message mid-turn via stream-json stdin pipe.
   * Claude reads stdin between API rounds, so the message appears between tool calls.
   * If stdin write fails, the message stays queued for processNext after the turn completes.
   */
  private async injectMidTurn(sessionId: string): Promise<void> {
    // Find the session with this Claude session ID
    let targetSession: ClaudeCodeSession | undefined
    for (const [, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        targetSession = session
        break
      }
    }

    if (!targetSession || !targetSession.hasPipe) {
      log.session.info('handleSend: session already processing, message queued (no FIFO pipe)', { sessionId })
      return
    }

    // Atomically move pending messages to processing state
    const newMsgs = await markProcessing(sessionId)
    if (newMsgs.length === 0) return

    const combined = newMsgs.map((m) => m.message).join('\n\n')

    if (await targetSession.writeMessage(combined)) {
      // Injection succeeded — increment batch count so SESSION_BATCH_COMPLETED
      // includes these messages when the turn eventually completes
      this.batchCounts.set(sessionId, (this.batchCounts.get(sessionId) ?? 0) + newMsgs.length)
      log.session.info('handleSend: message injected mid-turn via stdin', { sessionId, count: newMsgs.length })

      // Write synthetic user events so history has user messages for dedup.
      // Without this, mid-turn injected messages are missing from JSONL history,
      // causing optimistic message dedup to fail (user message appears twice).
      for (const msg of newMsgs) {
        if (msg.id) targetSession.writeSyntheticUserEvent(msg.message, msg.id)
      }

      // Eagerly remove from disk queue — message written to FIFO, no re-delivery on crash
      removeProcessed(sessionId).catch((err) => {
        log.session.warn('eager removeProcessed failed after mid-turn injection', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })

      // Tell frontend these messages have been delivered to the CLI
      bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
        sessionId,
        count: newMsgs.length,
      }, ['main-ai'], { source: 'session-runner' })
    } else {
      // stdin write failed (pipe broken, process died) — revert to pending
      // so processNext can pick them up after the turn completes or on respawn
      await revertToPending(newMsgs)
      log.session.warn('handleSend: mid-turn stdin injection failed, reverted to pending', { sessionId })
    }
  }

  /**
   * Drain all pending messages for a session, combine them, and send as one claude --resume call.
   * @param mode - Optional permission mode override for the resumed session.
   */
  private async processNext(sessionId: string, mode?: string): Promise<void> {
    const msgs = await markProcessing(sessionId)
    if (msgs.length === 0) return

    this.setActiveProcessing(sessionId, msgs.length)

    let combined = msgs.map((m) => m.message).join('\n\n')

    try {
      // Find the session that has this Claude session ID
      let targetSession: ClaudeCodeSession | undefined

      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          targetSession = session
          break
        }
      }

      // Check for pending model/mode switch — requires --resume (can't change via FIFO)
      let resolvedModel: string | undefined
      let resolvedMode: string | undefined
      let hasPendingSwitch = false
      try {
        const { getSessionByClaudeId: getSession, updateSessionRecord: updateRecord } = await import('../core/session-tracker.js')
        const record = await getSession(sessionId)
        if (record?.pendingModel || record?.pendingMode) {
          resolvedModel = record.pendingModel
          resolvedMode = record.pendingMode ?? mode
          hasPendingSwitch = true
          // Clear pending fields
          await updateRecord(sessionId, { pendingModel: undefined, pendingMode: undefined })
          log.session.info('processNext: consuming pending model/mode switch', { sessionId, model: resolvedModel, mode: resolvedMode })
        }
        // Fall back to stored CLI model for --resume so the [1m] context window
        // marker is preserved.  record.cliModel stores the original --model arg
        // (e.g. "opus[1m]").  record.model stores the *reported* model from init
        // events (e.g. "global.anthropic.claude-opus-4-6-v1") which never includes
        // [1m] — using it for resume would silently downgrade to 200K context.
        // Skip malformed model strings (e.g. orphan "]" from old ANSI stripping bug).
        const storedCliModel = record?.cliModel
        const storedModel = record?.model
        if (!resolvedModel && storedCliModel) {
          resolvedModel = storedCliModel
        } else if (!resolvedModel && storedModel
          && (!storedModel.endsWith(']') || storedModel.endsWith('[1m]'))) {
          if (storedModel.endsWith('[1m]')) {
            // Already has context marker — use as-is
            resolvedModel = storedModel
          } else {
            // Backward compat: sessions created before cliModel was persisted
            // only have the reported model (e.g. "global.anthropic.claude-opus-4-6-v1")
            // which never includes [1m].  Infer CLI alias + [1m] from model family
            // so resume preserves 1M context (the default for new sessions).
            const lower = storedModel.toLowerCase()
            if (lower.includes('sonnet')) resolvedModel = 'sonnet[1m]'
            else if (lower.includes('haiku')) resolvedModel = 'haiku'  // haiku has no 1M variant
            else resolvedModel = undefined  // → send() defaults to 'opus[1m]'
          }
        }
      } catch (err) {
        log.session.warn('processNext: failed to read pending model/mode', { sessionId, error: err instanceof Error ? err.message : String(err) })
      }

      // If pending model/mode switch, force --resume path (skip FIFO)
      if (hasPendingSwitch && targetSession) {
        log.session.info('processNext: forcing --resume for model/mode switch', { sessionId, model: resolvedModel, mode: resolvedMode })
        await targetSession.gracefulStop()
      }

      // Build walnutMessageIds from the batch — one synthetic event per queued message.
      // Each optimistic copy in the frontend has a unique queueId; we need a matching
      // walnutMessageId in the JSONL for each one so Layer 1 dedup can remove them all.
      const walnutMessageIds = msgs.map(m => m.id).filter(Boolean)

      // Try stdin write first (stream-json mode — reuses running process)
      if (targetSession && !hasPendingSwitch) {
        // Pre-flight liveness check: verify process is alive before writing to FIFO.
        // Without this, a dead process leaves a stale FIFO on disk — writes succeed
        // (kernel buffers them) but nobody reads, so messages are silently lost.
        const pid = targetSession.processPid
        if (pid && !await isProcessAliveAsync(pid, targetSession.host ? 'ssh' : 'claude')) {
          log.session.warn('processNext: process dead before FIFO write — clearing pipe for --resume', {
            sessionId, pid, host: targetSession.host,
          })
          targetSession.markProcessDead()
          // Fall through to --resume spawn path below
        } else if (await targetSession.writeMessage(combined)) {
          log.session.info('processNext: message sent via stdin (no new process)', { sessionId })

          // Write synthetic user events to streams file so Phase 1 has user messages.
          // One event per queued message so each optimistic copy can dedup by ID.
          for (const wmId of walnutMessageIds) {
            const msgText = msgs.find(m => m.id === wmId)!.message
            targetSession.writeSyntheticUserEvent(msgText, wmId)
          }

          // ── Eagerly remove from disk queue ──
          // Once the message is written to the FIFO, Claude has it. Remove from the
          // persistent queue immediately so a server crash/restart won't re-deliver it.
          // This prevents the infinite loop where: session kills server → restart →
          // loadQueue() resets processing→pending → re-delivers same message → loop.
          removeProcessed(sessionId).catch((err) => {
            log.session.warn('eager removeProcessed failed after FIFO write', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })

          // Tell frontend these messages have been delivered to the CLI
          bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
            sessionId,
            count: msgs.length,
          }, ['main-ai'], { source: 'session-runner' })

          // FIFO stall detection removed — the 120s timer was killing legitimate
          // long-running operations (compaction on large contexts, slow API calls).
          // The 30-min health monitor idle timeout is the proper safety net.

          return
        }
        log.session.info('processNext: writeMessage failed, falling back to --resume spawn', {
          sessionId,
          hasPipe: targetSession.hasPipe,
          processActive: targetSession.active,
          pid: targetSession.processPid,
          host: targetSession.host,
        })

        // Gracefully stop old process before respawning (SIGINT → wait → SIGTERM).
        // This ensures Claude Code flushes session state to disk so --resume can find it.
        // Without this, send() would SIGTERM the old process immediately, which can cause
        // --resume to fail and create a new session with a different ID.
        await targetSession.gracefulStop()
      }

      if (!targetSession) {
        // Session not in memory — create a new one to resume
        const { getSessionByClaudeId } = await import('../core/session-tracker.js')
        const record = await getSessionByClaudeId(sessionId)
        if (record) {
          const session = new ClaudeCodeSession(record.taskId, record.project, this.cliCommand)
          session._testDaemonUrl = this._testDaemonUrl
          this.sessions.set(record.taskId, session)

          // Resolve SSH target if session has a stored host
          let sshTarget: SshTarget | undefined
          if (record.host) {
            try {
              const { getConfig } = await import('../core/config-manager.js')
              const config = await getConfig()
              const hostDef = config.hosts?.[record.host]
              if (hostDef) {
                const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
                if (hostname) {
                  sshTarget = {
                    hostname,
                    user: hostDef.user,
                    port: hostDef.port,
                    shell_setup: hostDef.shell_setup,
                  }
                }
              }
            } catch {
              log.session.warn('failed to resolve host config for resume', { sessionId, host: record.host })
            }
          }

          log.session.info('resuming session via CLI', { sessionId, taskId: record.taskId, messageLength: combined.length, model: resolvedModel })
          session.send(combined, record.cwd ?? undefined, sessionId, resolvedMode ?? mode, resolvedModel, undefined, record.host ?? undefined, sshTarget)

          // Write synthetic user events — send() is sync, _outputFile is set immediately
          for (const wmId of walnutMessageIds) {
            const msgText = msgs.find(m => m.id === wmId)!.message
            session.writeSyntheticUserEvent(msgText, wmId)
          }

          // Eagerly remove from disk queue — message is now baked into --resume args
          removeProcessed(sessionId).catch((err) => {
            log.session.warn('eager removeProcessed failed after --resume spawn', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })

          // Tell frontend these messages have been delivered to the CLI
          bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
            sessionId,
            count: msgs.length,
          }, ['main-ai'], { source: 'session-runner' })

          bus.emit(EventNames.SESSION_STARTED, {
            taskId: record.taskId,
            project: record.project,
            host: record.host,
            resumed: true,
          }, ['main-ai'], { source: 'session-runner' })
          return
        }

        // No record found — throw so the catch block handles cleanup
        throw new Error(`No active session found for session ID: ${sessionId}`)
      }

      // Resolve SSH target if the session was on a remote host, so --resume
      // spawns on the correct machine (not locally).
      let resumeSshTarget: SshTarget | undefined
      const resumeHost = targetSession.host
      if (resumeHost) {
        try {
          const { getConfig } = await import('../core/config-manager.js')
          const config = await getConfig()
          const hostDef = config.hosts?.[resumeHost]
          if (hostDef) {
            const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
            if (hostname) {
              resumeSshTarget = { hostname, user: hostDef.user, port: hostDef.port, shell_setup: hostDef.shell_setup }
            }
          }
        } catch {
          log.session.warn('failed to resolve host config for resume (existing target)', { sessionId, host: resumeHost })
        }
      }

      // Resume the session with the combined message (with optional mode/model override)
      log.session.info('resuming session via CLI (existing target)', { sessionId, taskId: targetSession.taskId, messageLength: combined.length, host: resumeHost, model: resolvedModel })
      targetSession.send(combined, targetSession.cwd ?? undefined, sessionId, resolvedMode ?? mode, resolvedModel, undefined, resumeHost ?? undefined, resumeSshTarget)

      // Write synthetic user events — send() is sync, _outputFile is set immediately
      for (const wmId of walnutMessageIds) {
        const msgText = msgs.find(m => m.id === wmId)!.message
        targetSession.writeSyntheticUserEvent(msgText, wmId)
      }

      // Eagerly remove from disk queue — message is now baked into --resume args
      removeProcessed(sessionId).catch((err) => {
        log.session.warn('eager removeProcessed failed after --resume spawn', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })

      // Tell frontend these messages have been delivered to the CLI
      bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
        sessionId,
        count: msgs.length,
      }, ['main-ai'], { source: 'session-runner' })
    } catch (err) {
      // Clean up activeProcessing + batchCounts on any error (send() EMFILE, lookup failure, etc.)
      this.clearActiveProcessing(sessionId)

      // Remove messages that can't be processed
      removeProcessed(sessionId).catch(() => {})

      // Tell frontend to clear optimistic messages
      bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
        sessionId,
        count: msgs.length,
      }, ['main-ai'], { source: 'session-runner' })

      const errorMsg = err instanceof Error ? err.message : String(err)
      log.session.warn('processNext failed', { sessionId, error: errorMsg })

      bus.emit(EventNames.SESSION_ERROR, {
        sessionId,
        error: errorMsg,
      }, ['main-ai'], { source: 'session-runner' })
    }
  }
}

// ── Singleton ──

export const sessionRunner = new SessionRunner()

// ── Stream file cleanup ──

/**
 * Clean up old JSONL stream files from completed sessions.
 * Deletes files older than 1 hour, but preserves files belonging to
 * non-terminal sessions (they may be needed for reconnection or UI display).
 *
 * @param preserveSessionIds — Set of Claude session IDs whose files should NOT be deleted.
 *   Pass non-terminal session IDs from sessions.json to prevent deleting files that
 *   are still referenced and could cause ENOENT errors during reconnection.
 */
export async function cleanupStreamFiles(preserveSessionIds?: Set<string>): Promise<number> {
  let cleaned = 0
  try {
    const files = await fsp.readdir(SESSION_STREAMS_DIR)
    const now = Date.now()
    const ONE_HOUR = 60 * 60 * 1000

    for (const file of files) {
      // Check if this file belongs to a preserved session
      if (preserveSessionIds) {
        // Extract session ID from filename: {sessionId}.jsonl, {sessionId}.jsonl.err, {sessionId}.pipe
        const baseName = file.replace(/\.(jsonl\.err|jsonl|pipe)$/, '')
        if (preserveSessionIds.has(baseName)) continue
      }

      const filePath = path.join(SESSION_STREAMS_DIR, file)
      try {
        const stat = await fsp.stat(filePath)
        if (now - stat.mtimeMs > ONE_HOUR) {
          await fsp.unlink(filePath)
          cleaned++
        }
      } catch {
        // File may have been deleted by another process
      }
    }

    if (cleaned > 0) {
      log.session.info('cleaned up old stream files', { cleaned, preserved: preserveSessionIds?.size ?? 0 })
    }
  } catch {
    // Directory may not exist yet — not an error
  }
  return cleaned
}

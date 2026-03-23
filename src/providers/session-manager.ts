/**
 * SessionManager — Unified session management abstraction for Claude Code sessions.
 *
 * ARCHITECTURE:
 * ClaudeCodeSession delegates ALL process lifecycle + I/O to a SessionManager.
 * The manager encapsulates HOW and WHERE the Claude CLI process runs:
 *
 *   LocalSessionManager  — Process on local machine (FIFO + file tailing)
 *   RemoteSessionManager — Process on remote machine via walnut-daemon WebSocket
 *
 * WHY:
 * Before this abstraction, ClaudeCodeSession had 60+ lines of if(sshTarget)
 * branches, 5x instanceof RemoteIO checks, and transport logic leaked into
 * session-health-monitor, sessions.ts routes, and session-chat.ts.
 * The daemon architecture also fixes SSH orphan processes and 6-11s latency.
 *
 * DESIGN PRINCIPLE:
 * - SessionManager is the ONLY interface ClaudeCodeSession uses for I/O
 * - No remote/local branching in consumer code
 * - Inline subagents flow through onOutput (parent_tool_use_id in JSONL)
 * - Team members are separate sessions with their own manager instances
 *
 * REGISTRY:
 * A global Map<sessionId, SessionManager> allows any subsystem (health monitor,
 * liveness checks, routes) to look up the active manager for a session.
 * This replaces ad-hoc isDaemonConnected() calls for remote liveness.
 */

import type { SshTarget } from './session-io.js'
import { RemoteSessionManager } from './remote-session-manager.js'
import { LocalSessionManager } from './local-session-manager.js'

// ── Output Events ──

/**
 * A single JSONL line from the Claude CLI output stream.
 * Includes inline subagent events (identified by parent_tool_use_id).
 */
export interface OutputEvent {
  /** Raw JSONL line (unparsed — handleStreamLine does the parsing) */
  line: string
}

// ── Session History ──

/**
 * Complete session history including main JSONL and subagent data.
 * Used by readHistory() for displaying full conversation tree.
 */
export interface SessionHistory {
  /** Main canonical JSONL content */
  main: string
  /** Subagent JSONL files: Map<filename, content> */
  subagents: Map<string, string>
}

// ── Start Options ──

export interface TransportStartOptions {
  /** Claude CLI arguments (e.g. ['-p', '--output-format', 'stream-json', ...]) */
  args: string[]
  /** Working directory for the Claude process */
  cwd: string
  /** Initial message to send */
  message: string
  /** True when resuming an existing session (--resume) */
  resume?: boolean
  /** True when forking a session (--fork-session) */
  fork?: boolean
  /** Callback for each JSONL line from the output stream */
  onOutput: (event: OutputEvent) => void
  /** Callback when the Claude process exits */
  onExit: (code: number) => void
}

// ── Attach Options ──

export interface TransportAttachOptions {
  /** Claude session ID to reattach to */
  sessionId: string
  /** Byte offset to resume streaming from (skip already-processed data) */
  fromOffset?: number
  /** Callback for each JSONL line */
  onOutput: (event: OutputEvent) => void
  /** Callback when the Claude process exits */
  onExit: (code: number) => void
}

// ── Start Result ──

export interface TransportStartResult {
  /** PID of the spawned process (local PID for local, SSH PID for remote) */
  pid: number
  /** Path to the local JSONL output file (for health monitoring, rename, etc.) */
  outputFile: string
  /** Current file size at start time (for resume offset tracking) */
  fileSize: number
}

// ── Attach Result ──

export interface TransportAttachResult {
  /** PID of the process being monitored */
  pid: number
  /** Whether the Claude process is still alive */
  alive: boolean
  /** Path to the local JSONL output file */
  outputFile: string
}

// ── SessionManager Interface ──

/**
 * Unified session manager. ClaudeCodeSession only depends on this interface.
 *
 * Implementations:
 *   LocalSessionManager  — Local filesystem + process spawn
 *   RemoteSessionManager — Remote WebSocket daemon
 *
 * Lifecycle:
 *   start() → [send() | writeMessage()] → [stop() | interrupt() | kill()] → cleanup()
 *   attach() → [send() | writeMessage()] → ...
 */
export interface SessionManager {
  // ── Startup / Attach ──

  /**
   * Start a new Claude CLI process (or resume an existing session).
   * Sets up FIFO, output file, spawns the process, and begins streaming.
   */
  start(opts: TransportStartOptions): Promise<TransportStartResult>

  /**
   * Reattach to a running session after server restart.
   * Recovers FIFO pipe and starts tailing from the given offset.
   */
  attach(opts: TransportAttachOptions): Promise<TransportAttachResult>

  // ── Messaging ──

  /**
   * Write a follow-up message via the FIFO pipe (stream-json format).
   * Returns true if written successfully, false if pipe is broken.
   */
  writeMessage(message: string): boolean

  /**
   * Write a synthetic user event to the output file (for dedup).
   * Claude CLI doesn't echo user messages — this fills the gap.
   */
  writeSyntheticUserEvent(message: string, walnutMessageId: string): void

  // ── Process Control ──

  /**
   * Gracefully stop the process (SIGINT → wait → SIGTERM).
   * Used before respawning — does NOT clean up FIFO or modify session state.
   */
  stop(): Promise<void>

  /**
   * Kill the process immediately (SIGTERM + remote kill for SSH).
   * Marks resultEmitted so no spurious events fire.
   */
  kill(): void

  /**
   * Interrupt: close pipe, gracefully stop, wait for flush.
   * Two-phase: SIGINT → wait 5s → SIGTERM fallback.
   */
  interrupt(): Promise<void>

  /**
   * Check if the underlying process is alive.
   * For local: PID check. For remote: daemon status query.
   */
  isAlive(): Promise<boolean>

  // ── Session Management ──

  /**
   * Rename output + pipe files when the real Claude session ID arrives.
   * Called after the system init event provides the actual session_id.
   */
  renameForSession(sessionId: string): void

  /**
   * Detach from the session without killing it.
   * Stops tailing and monitoring. Process continues running.
   */
  detach(): void

  /**
   * Full cleanup — delete pipe and output files.
   */
  cleanup(): Promise<void>

  /**
   * Delete the FIFO pipe (but not the output file).
   */
  deletePipe(): void

  // ── Message Processing ──

  /**
   * Prepare an outbound message for sending.
   * For remote sessions: upload local images to remote host, rewrite paths.
   * For local sessions: no-op (returns message unchanged).
   */
  prepareOutbound(message: string): Promise<string>

  /**
   * Process inbound text from the Claude response.
   * For remote sessions: download remote images, rewrite paths to local.
   * For local sessions: no-op (returns text unchanged).
   */
  processInbound(text: string, sessionId: string, cwd?: string): string

  // ── Streaming Control ──

  /**
   * Flush any buffered data from the tailer (call when process exits).
   */
  flushTail(): void

  /**
   * Stop tailing the output file.
   */
  stopTail(): void

  // ── Properties ──

  /** PID of the monitored process (local PID or SSH PID). Null before start. */
  readonly pid: number | null

  /** Path to the local JSONL output file. Null before start (or always null for remote). */
  readonly outputFile: string | null

  /** Whether the manager has an active write pipe (FIFO). */
  readonly hasPipe: boolean

  /** Current byte offset in the output file. */
  readonly tailOffset: number

  /** Current size of the output file in bytes. */
  readonly fileSize: number

  /** Process name for liveness checks ('claude' for local, 'daemon' for remote). */
  readonly processName: string

  /** Host key (null for local sessions). */
  readonly host: string | null

  /** Whether this is a remote session. */
  readonly isRemote: boolean

  /**
   * Per-session cache for remote→local image path rewriting.
   * Exposed so ClaudeCodeSession can pass it to processInbound().
   */
  readonly imageCache: Map<string, string>

  /**
   * Timestamp (ms) of the last output event received.
   * Used by health monitor for idle timeout checks.
   *
   * LocalSessionManager: derived from output file mtime (persistent on disk).
   * RemoteSessionManager: in-memory timestamp updated on each daemon event.
   *
   * Returns 0 if no events have been received yet.
   */
  readonly lastEventAt: number
}

// ── Registry ──

const _registry = new Map<string, SessionManager>()

/** Register a SessionManager for a given session ID. */
export function registerSessionManager(sid: string, m: SessionManager): void {
  _registry.set(sid, m)
}

/** Unregister a SessionManager when a session is cleaned up or renamed. */
export function unregisterSessionManager(sid: string): void {
  _registry.delete(sid)
}

/** Look up the active SessionManager for a session ID. */
export function getRegisteredSessionManager(sid: string): SessionManager | undefined {
  return _registry.get(sid)
}

// ── Backward-compat aliases ──

/** @deprecated Use SessionManager instead */
export type SessionTransport = SessionManager

/** @deprecated Use createSessionManager instead */
export const createTransport = createSessionManager

/** @deprecated Use getRegisteredSessionManager instead */
export const getRegisteredTransport = getRegisteredSessionManager

// ── Factory ──

/**
 * Create the appropriate SessionManager based on whether this is local or remote.
 *
 * @param tmpId — temporary ID for file naming (random hex or session ID on resume)
 * @param host — host key from config.hosts (null = local)
 * @param sshTarget — resolved SSH connection parameters
 * @param outputFileOverride — force a specific output file path (for attach)
 */
export function createSessionManager(
  tmpId: string,
  host?: string,
  sshTarget?: SshTarget,
  outputFileOverride?: string,
  cliCommand?: string,
  directWsUrl?: string,
): SessionManager {
  if (host && sshTarget) {
    return new RemoteSessionManager(tmpId, host, sshTarget, directWsUrl)
  }

  return new LocalSessionManager(tmpId, outputFileOverride, cliCommand)
}

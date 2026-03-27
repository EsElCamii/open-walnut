/**
 * Session Health Monitor — periodic liveness checks for non-terminal sessions.
 *
 * Runs every 30 seconds inside the server process. For each non-terminal session:
 *   1. Check isProcessAlive (routes through session manager or daemon connection)
 *   2. If process dead: set process_status='error' (with errorMessage) or 'stopped'+'agent_complete'
 *   3. Clear task session slot on error (agent_complete keeps slot for resume)
 *   4. Emit session:status-changed
 *   5. Check idle timeout: kill sessions whose outputFile mtime exceeds the threshold.
 *      Uses file mtime — persistent on disk, survives server restarts, no state machine dependency.
 */

import fs from 'node:fs'
import { log } from '../logging/index.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { isSessionProcessAlive } from '../utils/session-liveness.js'
import { bus, EventNames } from './event-bus.js'
const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Default idle timeout: 30 minutes */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

export class SessionHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check().catch(() => {}), HEALTH_CHECK_INTERVAL_MS)
    log.session.info('session health monitor started', { intervalMs: HEALTH_CHECK_INTERVAL_MS })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.session.info('session health monitor stopped')
    }
  }

  async check(): Promise<void> {
    const { listNonTerminalSessions, updateSessionRecord } = await import('./session-tracker.js')

    // Kill orphaned processes from terminal/stopped sessions (leaked processes)
    await this.killOrphanedProcesses()

    let sessions
    try {
      sessions = await listNonTerminalSessions()
    } catch (err) {
      log.session.warn('health monitor: failed to list non-terminal sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    if (sessions.length === 0) return

    // Detect stale await_human_action sessions (stuck sub-agents)
    await this.checkStaleAwaitingSessions(sessions, updateSessionRecord)

    // Idle timeout — kill sessions with stale outputFile mtime past the configured threshold
    await this.checkIdleTimeout(sessions, updateSessionRecord)

    for (const session of sessions) {
      const alive = await isSessionProcessAlive(session)

      // alive=true: could be 'running' or 'idle' (don't override idle→running)
      // alive=false: process is dead or unreachable past grace period
      if (!alive && session.process_status !== 'stopped' && session.process_status !== 'error') {
        const now = new Date().toISOString()

        if (session.process_status === 'running' && session.work_status === 'in_progress') {
          // Process died while work was in progress — determine outcome.

          if (session.host) {
            // Remote session: daemon confirms process is dead (or grace period exceeded).
            // Set process_status='error' directly with detail message.
            await updateSessionRecord(session.claudeSessionId, {
              process_status: 'error',
              errorMessage: 'Connection lost — unable to reach remote host',
              activity: undefined,
              last_status_change: now,
            })
            log.session.warn('health monitor: remote session unreachable', {
              sessionId: session.claudeSessionId,
              taskId: session.taskId,
            })
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: session.claudeSessionId,
              taskId: session.taskId,
              process_status: 'error',
              errorMessage: 'Connection lost — unable to reach remote host',
            }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
            continue
          }

          // Local sessions: read the last 8KB of the JSONL file to check for a result event.
          const hasResult = session.outputFile ? this.outputFileHasResult(session.outputFile) : false

          if (hasResult) {
            // Normal completion — process_status 'stopped', work_status 'agent_complete'
            await updateSessionRecord(session.claudeSessionId, {
              process_status: 'stopped',
              work_status: 'agent_complete',
              activity: undefined,
              last_status_change: now,
            })
          } else {
            // Error — process_status 'error' with detail
            await updateSessionRecord(session.claudeSessionId, {
              process_status: 'error',
              errorMessage: 'Process exited without result',
              activity: undefined,
              last_status_change: now,
            })
          }

          // Clear session slot for both normal completion and error —
          // frees the task's 1-session slot so a new session can start.
          if (session.taskId) {
            try {
              const { clearSessionSlot } = await import('./task-manager.js')
              const { task } = await clearSessionSlot(session.taskId, session.claudeSessionId)
              bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: hasResult ? 'session-complete' : 'session-error' })
            } catch (err) {
              log.session.warn('health monitor: failed to clear session slot', {
                sessionId: session.claudeSessionId,
                taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          const newProcessStatus = hasResult ? 'stopped' : 'error'
          log.session.info('health monitor: session process died', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            newProcessStatus,
          })

          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            process_status: newProcessStatus,
            work_status: hasResult ? 'agent_complete' : session.work_status,
          }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
        } else {
          // Process died while idle or in non-in_progress state.
          const forceWorkStatus = session.work_status === 'in_progress'
          const updates: Record<string, unknown> = {
            last_status_change: now,
          }

          if (forceWorkStatus) {
            const hasResult = session.outputFile && !session.outputFile.startsWith('remote://')
              ? this.outputFileHasResult(session.outputFile) : false
            if (hasResult) {
              updates.process_status = 'stopped'
              updates.work_status = 'agent_complete'
            } else {
              updates.process_status = 'error'
              updates.errorMessage = 'Process exited without result'
            }
            updates.activity = undefined
          } else {
            updates.process_status = 'stopped'
          }

          await updateSessionRecord(session.claudeSessionId, updates)

          log.session.info('health monitor: process status updated', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            pid: session.pid,
            previousProcessStatus: session.process_status,
            workStatus: session.work_status,
            ...(forceWorkStatus ? { newProcessStatus: updates.process_status } : {}),
          })

          if (forceWorkStatus) {
            bus.emit(EventNames.SESSION_STATUS_CHANGED, {
              sessionId: session.claudeSessionId,
              taskId: session.taskId,
              process_status: updates.process_status as string,
              work_status: updates.work_status as string | undefined,
            }, ['*'], { source: 'health-monitor', urgency: 'urgent' })
          }
        }
      }
    }
  }

  /**
   * Idle timeout based on SessionManager.lastEventAt (preferred) or file mtime (fallback).
   *
   * Checks ALL non-terminal sessions with a live process. If no output has been
   * produced in more than idle_timeout_minutes (default 30), kill the session.
   *
   * Data sources for "last active" time:
   *   1. SessionManager.lastEventAt — works for both local (file mtime) and remote (in-memory)
   *   2. Fallback: fs.statSync(outputFile).mtimeMs — for sessions without an active manager
   *
   * Skips await_human_action sessions — they're waiting for user input, not truly idle.
   */
  private async checkIdleTimeout(
    sessions: Array<{ claudeSessionId: string; taskId?: string; pid?: number; process_status?: string; work_status?: string; host?: string; outputFile?: string; provider?: string }>,
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    // Read config to get idle_timeout_minutes
    let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
    try {
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      const mins = config.session?.idle_timeout_minutes
      if (mins != null) {
        idleTimeoutMs = mins === 0 ? 0 : mins * 60 * 1000
      }
    } catch (err) {
      log.session.debug('health monitor: config not available, using default idle timeout', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 0 = disabled
    if (idleTimeoutMs <= 0) return

    const now = Date.now()

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')

    for (const session of sessions) {
      if (session.work_status === 'await_human_action') continue  // waiting for user, not idle

      // Check if process is actually alive before spending time on idle check
      if (!await isSessionProcessAlive(session)) continue

      // Determine last activity time:
      // 1. Prefer SessionManager.lastEventAt (works for both local and remote)
      // 2. Fallback to file mtime for local sessions without an active manager
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      let lastActiveMs: number
      if (mgr) {
        lastActiveMs = mgr.lastEventAt
        if (lastActiveMs === 0) continue  // No events received yet — skip
      } else if (session.outputFile && !session.outputFile.startsWith('remote://')) {
        try {
          const stat = fs.statSync(session.outputFile)
          lastActiveMs = stat.mtimeMs
        } catch {
          continue  // Can't stat file — skip
        }
      } else {
        continue  // No manager and no output file (or remote sentinel) — skip
      }

      const idleDurationMs = now - lastActiveMs
      if (idleDurationMs < idleTimeoutMs) continue

      const idleMinutes = Math.round(idleDurationMs / 60_000)
      log.session.info('health monitor: idle timeout — killing session', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        host: session.host,
        idleMinutes,
        thresholdMinutes: Math.round(idleTimeoutMs / 60_000),
        source: mgr ? 'lastEventAt' : 'file-mtime',
      })

      // Graceful kill via session manager if available (handles both local + remote),
      // otherwise fall back to local PID signals.
      if (mgr) {
        mgr.kill()
      } else {
        const pid = session.pid
        if (pid == null) continue  // No PID — can't signal; skip to next session
        try { process.kill(pid, 'SIGINT') } catch { /* already dead */ }
        // Deferred SIGTERM fallback — fire-and-forget, doesn't block health check loop
        setTimeout(() => {
          isProcessAliveAsync(pid, 'claude').then((alive) => {
            if (alive) {
              try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
            }
          }).catch(() => {})
        }, 5_000)
      }

      const updateNow = new Date().toISOString()
      await updateSessionRecord(session.claudeSessionId, {
        process_status: 'stopped',
        activity: undefined,
        last_status_change: updateNow,
      })

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'stopped',
        work_status: session.work_status,
      }, ['*'], { source: 'health-monitor' })
    }
  }

  /**
   * Detect sessions that are "idle" with await_human_action but haven't produced
   * any JSONL output for a long time. These sessions likely have stuck sub-agents.
   * Emits a status change event so the UI shows a warning.
   */
  private async checkStaleAwaitingSessions(
    sessions: Array<{ claudeSessionId: string; taskId?: string; pid?: number; process_status?: string; work_status?: string; outputFile?: string; lastActiveAt?: string }>,
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const STALE_THRESHOLD_MS = 60 * 60 * 1000  // 1 hour with no output = stale

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')

    for (const session of sessions) {
      // Check both running and idle — await_human_action can be in either state
      if (session.process_status === 'stopped' || session.process_status === 'error') continue
      if (session.work_status !== 'await_human_action') continue

      // Determine last activity time via session manager or file mtime
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      let lastActiveMs: number
      if (mgr) {
        lastActiveMs = mgr.lastEventAt
        if (lastActiveMs === 0) continue  // No events yet — not stale
      } else if (session.outputFile && !session.outputFile.startsWith('remote://')) {
        try {
          lastActiveMs = fs.statSync(session.outputFile).mtimeMs
        } catch {
          continue
        }
      } else {
        continue  // No manager and no output file (or remote sentinel) — skip
      }

      const ageMs = Date.now() - lastActiveMs
      if (ageMs < STALE_THRESHOLD_MS) continue  // Still active

      // Output is stale — update activity to warn user
      const staleMinutes = Math.round(ageMs / 60_000)
      log.session.warn('health monitor: await_human_action session has stale output', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        staleMinutes,
      })

      await updateSessionRecord(session.claudeSessionId, {
        activity: `Possibly stuck — no output for ${staleMinutes} min`,
        last_status_change: new Date().toISOString(),
      })

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: session.process_status,
        work_status: 'await_human_action',
        activity: `Possibly stuck — no output for ${staleMinutes} min`,
      }, ['*'], { source: 'health-monitor' })
    }
  }

  /**
   * Kill orphaned OS processes from sessions that are in terminal state
   * (completed/error) or marked stopped but whose process is still alive.
   * These are invisible to the normal health checks (which only scan non-terminal sessions)
   * and accumulate over time, eventually exhausting OS resources.
   */
  private async killOrphanedProcesses(): Promise<void> {
    // Grace period: don't kill processes whose session record changed very recently.
    // The reconciler or other subsystems may have just updated the record, and the
    // current state may be transient. Real orphans are always older than 2 minutes.
    // 2 min = worst-case reconciler duration + a few HEALTH_CHECK_INTERVAL_MS (30s each)
    // cycles to handle transient states created during server startup.
    const ORPHAN_GRACE_MS = 2 * 60 * 1000

    try {
      const { listSessions, isTerminalSession } = await import('./session-tracker.js')
      const sessions = await listSessions()

      // Build set of PIDs actively used by non-terminal, non-stopped sessions.
      // This prevents PID-reuse collisions: OS can recycle a PID from a completed
      // session and assign it to a new active session.
      const activePids = new Set<number>()
      for (const s of sessions) {
        if (s.pid == null) continue
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) {
          activePids.add(s.pid)
        }
      }

      const now = Date.now()
      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Only target sessions that SHOULD have no running process
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) continue

        // Grace period: skip sessions whose record was recently changed.
        // Prevents killing processes during transient reconciler/startup race windows.
        const lastChange = s.last_status_change ?? s.lastActiveAt
        if (lastChange && (now - new Date(lastChange).getTime()) < ORPHAN_GRACE_MS) continue

        // PID reuse protection: skip if this PID is used by an active session
        if (activePids.has(s.pid)) {
          log.session.warn('health monitor: skipping orphan kill — PID reuse collision detected', {
            staleSessionId: s.claudeSessionId, pid: s.pid,
            staleWorkStatus: s.work_status, staleProcessStatus: s.process_status,
          })
          continue
        }

        if (!await isSessionProcessAlive(s)) continue

        log.session.warn('health monitor: killing orphaned process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
          work_status: s.work_status,
        })

        try { process.kill(s.pid, 'SIGTERM') } catch { /* already dead */ }

        // Remote process cleanup is handled by daemon transport when the local tunnel dies.

        killed++
      }

      if (killed > 0) {
        log.session.info('health monitor: killed orphaned processes', { count: killed })
      }
    } catch (err) {
      log.session.debug('health monitor: orphan process cleanup failed, will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private outputFileHasResult(filePath: string): boolean {
    // Only read last ~8KB — result event is always the final JSONL line.
    // Avoids reading 100MB+ files for long sessions.
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const stat = fs.fstatSync(fd)
        const TAIL_BYTES = 8192
        const start = Math.max(0, stat.size - TAIL_BYTES)
        const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size))
        fs.readSync(fd, buf, 0, buf.length, start)
        const tail = buf.toString('utf-8')
        for (const line of tail.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            // A result with is_error:true (e.g. --resume "No conversation found")
            // is NOT a successful completion — treat it as no result.
            if (event.type === 'result') return !event.is_error
          } catch { continue }  // expected: partial JSON lines in tail buffer
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      log.session.debug('health monitor: cannot read output file for result check', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return false
  }
}

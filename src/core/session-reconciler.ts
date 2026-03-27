/**
 * Session Reconciler — detect zombie sessions and identify reconnectable ones.
 *
 * When the Walnut server restarts, non-terminal sessions in sessions.json may be:
 *   1. Still alive (detached process survived) → reconnectable
 *   2. Dead (process died with old server) → mark agent_complete/error
 *
 * Sessions with pid + outputFile are checked via PID liveness.
 * Legacy sessions without these fields are assumed dead.
 */

import { log } from '../logging/index.js'
import { isSessionProcessAlive } from '../utils/session-liveness.js'
import { bus, EventNames } from './event-bus.js'
import type { SessionRecord, Task } from './types.js'

export interface ReconcileResult {
  reconciled: number
  reconnectable: SessionRecord[]
}

/**
 * Reconcile sessions.json against actual process state.
 *
 * For each session not in a terminal state (completed/error):
 *   - If it has pid + outputFile AND the process is alive → reconnectable
 *     (set process_status='running' or 'idle' based on task.phase)
 *   - Otherwise → mark process_status='stopped' and clean up task references
 */
export async function reconcileSessions(): Promise<ReconcileResult> {
  const { listSessions, updateSessionRecord, updateSessionRecordConditionally, isTerminalSession } = await import('./session-tracker.js')
  // Captured before listSessions() so any concurrent write that occurs after our snapshot
  // is detectable: if current.last_status_change > reconcilerStartedAt, the record was
  // modified after we read it and we must skip our stale update.
  const reconcilerStartedAt = new Date().toISOString()

  let sessions: SessionRecord[]
  try {
    sessions = await listSessions()
  } catch (err) {
    log.session.warn('session reconciler: failed to read sessions', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { reconciled: 0, reconnectable: [] }
  }
  // Only reconcile interactive sessions (CLI with detached processes).
  // Embedded types (triage/hook/cron/subagent) have no PID — no process to check.
  // Triage/hook/cron are cleaned up by SessionReaper; subagent sessions are user-visible and persist.
  // All sessions have type set by readStore() migration (runs inside listSessions above).
  const zombieCandidates = sessions.filter(
    (s) => !isTerminalSession(s)
      && s.type === 'interactive'
      && s.process_status !== 'stopped',
  )

  if (zombieCandidates.length === 0) {
    log.session.info('session reconciler: no non-terminal interactive sessions found')
    return { reconciled: 0, reconnectable: [] }
  }

  log.session.info('session reconciler: checking sessions', { count: zombieCandidates.length })

  // Batch-load all tasks for phase lookups
  let taskMap = new Map<string, Task>()
  try {
    const { listTasks } = await import('./task-manager.js')
    const allTasks = await listTasks()
    for (const t of allTasks) taskMap.set(t.id, t)
  } catch {
    // Tasks unavailable — fall back to 'idle' for all process_status decisions
  }

  // Parallel liveness checks — routes to local PID check or remote daemon check
  const results = await Promise.allSettled(zombieCandidates.map(async (session) => {
    const alive = session.outputFile ? await isSessionProcessAlive(session) : false
    return { session, alive }
  }))

  let reconciled = 0
  const reconnectable: SessionRecord[] = []

  // Process results — updateSessionRecord calls are serialized by the write lock
  for (const r of results) {
    if (r.status === 'rejected') {
      log.session.warn('session reconciler: PID check failed', { error: String(r.reason) })
      continue
    }
    const { session, alive } = r.value

    if (alive) {
      // Process survived server restart — reconnectable
      const taskPhase = session.taskId ? taskMap.get(session.taskId)?.phase : undefined
      const correctProcessStatus = taskPhase === 'IN_PROGRESS' ? 'running' : 'idle'
      await updateSessionRecord(session.claudeSessionId, {
        process_status: correctProcessStatus,
      }).catch(() => {})

      log.session.info('session reconciler: session still alive', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId || '(none)',
        pid: session.pid,
        processStatus: correctProcessStatus,
      })
      reconnectable.push(session)
      continue
    }

    // Session is dead — mark as stopped.
    // Task phase progression (e.g. AGENT_COMPLETE) is handled by the task manager.
    // Use conditional update to prevent stale-snapshot race:
    //   - If the record was updated after we started (new process spawned), skip.
    //   - If the PID changed (new process), skip.
    //   - If already stopped, skip (redundant write).
    try {
      // snapshotPid is from the pre-lock snapshot. Inside the predicate below, `current`
      // is the record freshly re-read under the write lock. Comparing the two detects
      // whether a new process was spawned (or the session replaced) between our snapshot
      // and when we acquired the lock.
      const snapshotPid = session.pid
      const now = new Date().toISOString()
      const updated = await updateSessionRecordConditionally(
        session.claudeSessionId,
        {
          process_status: 'stopped',
          activity: undefined,
          last_status_change: now,
        },
        (current) => {
          if (current.last_status_change && current.last_status_change > reconcilerStartedAt) return false
          if (current.pid !== snapshotPid) return false
          if (current.process_status === 'stopped') return false
          return true
        },
      )

      if (!updated) {
        log.session.info('session reconciler: skipped stale update (record changed since snapshot)', {
          sessionId: session.claudeSessionId,
          snapshotPid,
        })
        continue
      }

      reconciled++

      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        process_status: 'stopped',
      }, ['*'], { source: 'reconciler', urgency: 'urgent' })

      log.session.info('session reconciler: marked zombie session stopped', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId || '(none)',
        hadPid: session.pid != null,
      })
    } catch (err) {
      log.session.warn('session reconciler: failed to reconcile session', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.session.info('session reconciler: done', {
    reconciled,
    reconnectable: reconnectable.length,
    total: zombieCandidates.length,
  })

  return { reconciled, reconnectable }
}

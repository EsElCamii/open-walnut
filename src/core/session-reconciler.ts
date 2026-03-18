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
import { isProcessAliveAsync } from '../utils/process.js'
import { bus, EventNames } from './event-bus.js'
import type { SessionRecord } from './types.js'

export interface ReconcileResult {
  reconciled: number
  reconnectable: SessionRecord[]
}

/**
 * Reconcile sessions.json against actual process state.
 *
 * For each session not in a terminal state (completed/error):
 *   - If it has pid + outputFile AND the process is alive → reconnectable
 *     (set process_status='running', keep current work_status)
 *   - Otherwise → mark process_status='stopped', work_status='agent_complete'
 *     (only the agent/human can set 'completed') and clean up task references
 */
export async function reconcileSessions(): Promise<ReconcileResult> {
  const { listSessions, updateSessionRecord, updateSessionRecordConditionally, TERMINAL_WORK_STATUSES } = await import('./session-tracker.js')
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
    (s) => !TERMINAL_WORK_STATUSES.has(s.work_status)
      && s.type === 'interactive'
      && s.process_status !== 'stopped',
  )

  if (zombieCandidates.length === 0) {
    log.session.info('session reconciler: no non-terminal interactive sessions found')
    return { reconciled: 0, reconnectable: [] }
  }

  log.session.info('session reconciler: checking sessions', { count: zombieCandidates.length })

  // Parallel PID liveness checks — all I/O happens concurrently
  const results = await Promise.allSettled(zombieCandidates.map(async (session) => {
    const processName = session.host ? 'ssh' : 'claude'
    const alive = session.pid != null && session.outputFile
      && await isProcessAliveAsync(session.pid, processName)
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
      const correctProcessStatus = session.work_status === 'in_progress' ? 'running' : 'idle'
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

    // Session is dead — mark as agent_complete (not completed).
    // Only the agent or human can determine if the work is truly done.
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
          work_status: 'agent_complete',
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
        work_status: 'agent_complete',
        previousWorkStatus: session.work_status,
      }, ['*'], { source: 'reconciler', urgency: 'urgent' })

      log.session.info('session reconciler: marked zombie session agent_complete', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId || '(none)',
        previousWorkStatus: session.work_status,
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

/**
 * Unified session process liveness check.
 *
 * All callers use this ONE function instead of doing ad-hoc PID checks.
 * The function routes to the right session manager:
 *   - Registry hit → manager.isAlive() (authoritative — asks the actual manager)
 *   - Fallback (after server restart, no active manager):
 *       Remote → isDaemonConnected(host) (best effort)
 *       Local  → isProcessAliveAsync(pid)
 *   - Embedded/SDK sessions → always true (managed externally)
 */
import type { SessionRecord } from '../core/types.js'
import { isProcessAliveAsync } from './process.js'

export async function isSessionProcessAlive(session: SessionRecord): Promise<boolean> {
  // Embedded/SDK: managed by their respective providers, not by PID
  if (session.provider === 'embedded' || session.provider === 'sdk') return true

  // Prefer the registry — the active SessionManager knows the truth
  if (session.claudeSessionId) {
    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')
    const mgr = getRegisteredSessionManager(session.claudeSessionId)
    if (mgr) return mgr.isAlive()
  }

  // Fallback: no active manager (e.g. server just restarted, transport not yet attached)
  // Remote daemon sessions: the PID lives on the remote host.
  // We can't check it locally — instead check if the daemon connection is up.
  if (session.host) {
    const { isDaemonConnected } = await import('../providers/daemon-connection.js')
    return isDaemonConnected(session.host)
  }

  // Local sessions: check PID on this machine
  if (session.pid == null) return false
  return isProcessAliveAsync(session.pid, 'claude')
}

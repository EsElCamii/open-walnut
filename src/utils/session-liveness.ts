/**
 * Unified session process liveness check.
 *
 * All callers use this ONE function instead of doing ad-hoc PID checks.
 * The function routes to the right session manager:
 *   - Registry hit → manager.isAlive() (authoritative — asks the actual manager)
 *   - Fallback (after server restart, no active manager):
 *       Remote → isDaemonConnected(host) with 5min grace period
 *       Local  → process.kill(pid, 0) (pure syscall, no fork)
 *   - Embedded/SDK sessions → always true (managed externally)
 *
 * PID-reuse tradeoff (IMPORTANT — read before changing):
 *   Earlier versions called `isProcessAliveAsync(pid, 'claude')` which shells out to
 *   `ps -p <pid> -o command=` and matched the binary name. That was *binary-verified*
 *   liveness: it would distinguish a real claude process from a recycled PID owned by
 *   some other program. We dropped that verification because this function is invoked
 *   up to 3× per non-terminal session per 30s health-monitor cycle (~3000 forks per
 *   30s at ~985 sessions) and the aggregate `ps` fork cost was wedging the event loop.
 *
 *   In its place we now use `process.kill(pid, 0)` — a pure syscall, no child process.
 *   This is *existence-only* liveness: if some other program happens to hold the same
 *   PID after OS reuse, we will mistakenly report "alive".
 *
 *   The PID-reuse defense therefore does NOT live here. It lives in
 *   killOrphanedProcesses() (src/core/session-health-monitor.ts), which combines:
 *     (1) a ~2-minute grace period on `last_status_change` (real orphans are older);
 *     (2) an `activePids` set collected from live sessions so a PID recycled into a
 *         new session is never killed as an orphan of the old one.
 *   Those two together — not binary verification — are the current defense.
 */
import type { SessionRecord } from '../core/types.js'

export async function isSessionProcessAlive(session: SessionRecord): Promise<boolean> {
  // Embedded/SDK: managed by their respective providers, not by PID
  if (session.provider === 'embedded' || session.provider === 'sdk') return true

  // If the session was already marked stopped (e.g. by health monitor idle timeout),
  // it's definitively dead — no need to probe PIDs or daemon connections.
  if (session.process_status === 'stopped' || session.process_status === 'error') return false

  // Prefer the registry — the active SessionManager knows the truth
  if (session.claudeSessionId) {
    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')
    const mgr = getRegisteredSessionManager(session.claudeSessionId)
    if (mgr) return mgr.isAlive()
  }

  // Fallback: no active manager (e.g. server just restarted, transport not yet attached)
  // Remote daemon sessions: the PID lives on the remote host.
  // We can't check it locally — instead check if the daemon connection is up.
  // Short disconnects (< 5min) → assume alive (tunnel may be reconnecting).
  if (session.host) {
    const { isDaemonConnected, getDaemonDisconnectedSince } = await import('../providers/daemon-connection.js')
    if (isDaemonConnected(session.host)) return true
    // Disconnected — check grace period
    const since = getDaemonDisconnectedSince(session.host)
    if (since && (Date.now() - since) > 5 * 60 * 1000) return false // > 5min
    return true // short disconnect — assume alive
  }

  // Local sessions: check PID on this machine.
  // Pure syscall — no child process fork. See file header for why we skip binary verification.
  if (session.pid == null) return false
  try {
    process.kill(session.pid, 0)
    return true
  } catch {
    return false
  }
}

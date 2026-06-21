/**
 * Forensic Observability — invariant engine.
 *
 * Crashes are caught by error handling. The hard class is "silent success":
 * a turn that reports success but is actually wrong (truncated, never delivered,
 * routed to the wrong transport). These rules assert what a *healthy* turn looks
 * like and fire the moment a turn completes, so the bug is caught proactively
 * instead of discovered hours later via cross-layer grep.
 *
 * Rules are pure + synchronous — they run on the turn-completion hot path.
 */

import type { InvariantRule, InvariantViolation, TurnEvent } from './types.js';

/**
 * Seed rules. Keep each rule narrow and high-signal — a noisy invariant trains
 * the user to ignore incidents, which defeats the purpose.
 */
export const INVARIANT_RULES: InvariantRule[] = [
  {
    // The exact bug from 2026-06-04 session 1fc886da: CLI emitted result/success
    // but the last assistant message had stop_reason=null → the stream was cut
    // mid-message yet reported as a clean success. Team turns legitimately emit
    // intermediate results, so they're excluded.
    id: 'truncated-success',
    description: 'A successful turn must end with a real stop_reason (not null/empty).',
    severity: 'error',
    check: (t: TurnEvent) => {
      if (t.teamActive) return null; // intermediate team results legitimately lack a final stop_reason
      if (t.isError) return null; // genuine errors are handled elsewhere
      const succeeded = t.subtype === 'success' || t.isError === false;
      if (!succeeded) return null;
      // stopReason undefined = we didn't capture it (don't false-alarm); null/'' = truncation.
      if (t.stopReason === null || t.stopReason === '') {
        return `success turn ended with stopReason=${JSON.stringify(t.stopReason)} (truncated mid-stream)`;
      }
      return null;
    },
  },
  {
    // A delivered message that never produces a result within a generous window
    // means the turn stalled (issue #1: "delivery stops"). We only flag when we
    // actually have a deliveryMs but a wildly long one paired with no real output.
    id: 'empty-success',
    description: 'A successful, non-team turn should produce some output text.',
    severity: 'warn',
    check: (t: TurnEvent) => {
      if (t.teamActive || t.isError) return null;
      const succeeded = t.subtype === 'success' || t.isError === false;
      if (!succeeded) return null;
      // Only flag when we positively know the result was empty (resultLen===0),
      // not when it's merely unset (resultLen undefined = not measured).
      if (t.resultLen === 0) {
        return 'success turn produced zero result text (possible silent no-op)';
      }
      return null;
    },
  },
  {
    // Issue #2 fingerprint: the felt "grey/QUEUED for ages". deliveryMs is the
    // enqueue→delivered wait the user actually felt. 30s is far beyond any
    // healthy path (local stdin ~150ms, remote mid-turn ~250ms).
    id: 'slow-delivery',
    description: 'enqueue→delivered should be well under 30s.',
    severity: 'warn',
    check: (t: TurnEvent) => {
      if (typeof t.deliveryMs !== 'number') return null;
      if (t.deliveryMs >= 30_000) {
        return `enqueue→delivered took ${Math.round(t.deliveryMs / 1000)}s (path=${t.deliveryPath ?? '?'})`;
      }
      return null;
    },
  },
];

/**
 * Evaluate all rules against a turn. Returns the violations (empty = healthy).
 * Never throws — a buggy rule must not break turn completion.
 */
export function evaluateInvariants(turn: TurnEvent, rules: InvariantRule[] = INVARIANT_RULES): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const rule of rules) {
    try {
      const reason = rule.check(turn);
      if (reason) {
        out.push({ ruleId: rule.id, severity: rule.severity, reason });
      }
    } catch {
      // A rule that throws is a bug in the rule, not an unhealthy turn — skip it.
    }
  }
  return out;
}

/**
 * Forensic Observability — turn recorder (the single hot-path entry point).
 *
 * Called once per completed turn from claude-code-session.ts. It:
 *   1. Emits the wide TURN EVENT as a structured log (`obs` subsystem) — this is
 *      the metric source (deliveryMs/durationMs/numTurns…) and the trace anchor.
 *   2. Runs the invariant engine; on violation, opens an Incident (auto-captures
 *      an evidence bundle + notifies) via the registered incident sink.
 *
 * The incident sink is injected (registerIncidentSink) so the heavy modules
 * (bundle capture, persistence, notification) can be built and wired separately
 * without this hot-path module importing them directly. If no sink is
 * registered, violations are still logged — recording never depends on the sink.
 */

import { log } from '../../logging/index.js';
import { evaluateInvariants } from './invariants.js';
import type { InvariantViolation, TurnEvent } from './types.js';

/**
 * Sink that turns invariant violations into a durable incident (+ bundle +
 * notification). Implemented by the incident module and registered at startup.
 * Must be fire-and-forget safe; recorder never awaits it on the hot path.
 */
export type IncidentSink = (turn: TurnEvent, violations: InvariantViolation[]) => void;

let incidentSink: IncidentSink | null = null;

/** Register the incident sink (called once at server startup). */
export function registerIncidentSink(sink: IncidentSink): void {
  incidentSink = sink;
}

/**
 * Record one completed turn. Safe to call fire-and-forget — never throws, never
 * blocks delivery. `partial` lets callers omit `ts` (stamped here).
 */
export function recordTurn(partial: Omit<TurnEvent, 'ts'> & { ts?: number }): void {
  try {
    const turn: TurnEvent = { ...partial, ts: partial.ts ?? Date.now() };

    // 1. Wide event — one fat structured record. `obs` subsystem so it's easy to
    // filter (walnut-logs.sh) and later map to an OTel span/metric set.
    log.obs.info('turn', {
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      host: turn.host ?? 'local',
      model: turn.model,
      hasPipe: turn.hasPipe,
      pid: turn.pid ?? null,
      isError: turn.isError,
      subtype: turn.subtype,
      numTurns: turn.numTurns,
      stopReason: turn.stopReason,
      durationMs: turn.durationMs,
      resultLen: turn.resultLen,
      deliveryMs: turn.deliveryMs,
      deliveryPath: turn.deliveryPath,
      teamActive: turn.teamActive,
      backgroundActive: turn.backgroundActive,
    });

    // 2. Invariants — catch "silent success" the moment it happens.
    const violations = evaluateInvariants(turn);
    if (violations.length === 0) return;

    const worst = violations.some(v => v.severity === 'error') ? 'error' : 'warn';
    log.obs[worst === 'error' ? 'error' : 'warn']('invariant violation', {
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      violations: violations.map(v => `${v.ruleId}: ${v.reason}`),
    });

    // 3. Hand off to the incident sink (durable record + bundle + notify).
    // Fire-and-forget: a missing/slow sink must not affect turn completion.
    if (incidentSink) {
      try {
        incidentSink(turn, violations);
      } catch (err) {
        log.obs.warn('incident sink threw', {
          sessionId: turn.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Recording must never break a turn.
    log.obs.warn('recordTurn failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

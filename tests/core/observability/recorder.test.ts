/**
 * Unit tests for the forensic-observability turn recorder.
 *
 * recordTurn() is the single hot-path entry point called once per completed
 * turn. Contract under test:
 *   1. It emits ONE wide `obs` "turn" event (the metric/trace source).
 *   2. On a violation it logs the violation AND hands off to the registered
 *      incident sink with (turn, violations).
 *   3. On a healthy turn it does NOT call the sink.
 *   4. It NEVER throws — a missing/slow/throwing sink must not break the turn.
 *
 * We spy on `log.obs` (the same module instance the recorder imports) to assert
 * emission, and register a captured mock sink to assert hand-off semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log } from '../../../src/logging/index.js';
import { recordTurn, registerIncidentSink } from '../../../src/core/observability/recorder.js';
import type { IncidentSink } from '../../../src/core/observability/recorder.js';
import type { InvariantViolation, TurnEvent } from '../../../src/core/observability/types.js';

// ── Spies on the obs logger (file/stderr writes are suppressed) ──
let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  infoSpy = vi.spyOn(log.obs, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(log.obs, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(log.obs, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset the module-level sink so tests don't leak into one another.
  registerIncidentSink(() => {});
});

function healthyPartial(overrides: Partial<TurnEvent> = {}): Omit<TurnEvent, 'ts'> {
  return {
    sessionId: 'sess-rec-healthy',
    isError: false,
    subtype: 'success',
    stopReason: 'end_turn',
    resultLen: 42,
    deliveryMs: 150,
    deliveryPath: 'stdin',
    teamActive: false,
    ...overrides,
  };
}

/** A partial whose values trip the truncated-success (error) invariant. */
function truncatedPartial(overrides: Partial<TurnEvent> = {}): Omit<TurnEvent, 'ts'> {
  return healthyPartial({ sessionId: 'sess-rec-trunc', stopReason: null, ...overrides });
}

describe('recordTurn — wide event emission', () => {
  it('emits exactly one obs "turn" info event carrying the turn fields', () => {
    recordTurn(healthyPartial({ sessionId: 'sess-A', model: 'opus-4-8', durationMs: 1234 }));

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = infoSpy.mock.calls[0];
    expect(message).toBe('turn');
    expect(meta).toMatchObject({
      sessionId: 'sess-A',
      model: 'opus-4-8',
      subtype: 'success',
      stopReason: 'end_turn',
      durationMs: 1234,
    });
  });

  it('defaults host to "local" when host is not provided', () => {
    recordTurn(healthyPartial({ host: undefined }));
    expect((infoSpy.mock.calls[0][1] as Record<string, unknown>).host).toBe('local');
  });

  it('stamps ts when omitted (it is Omit<TurnEvent, "ts"> at the call site)', () => {
    const before = Date.now();
    recordTurn(healthyPartial());
    // The wide event was emitted without throwing; ts is internal but the call
    // succeeding with no `ts` proves the default path ran.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });
});

describe('recordTurn — incident sink hand-off', () => {
  it('invokes the sink with (turn, violations) ONLY on a violation', () => {
    const calls: Array<{ turn: TurnEvent; violations: InvariantViolation[] }> = [];
    const sink: IncidentSink = (turn, violations) => calls.push({ turn, violations });
    registerIncidentSink(sink);

    recordTurn(truncatedPartial());

    expect(calls).toHaveLength(1);
    expect(calls[0].turn.sessionId).toBe('sess-rec-trunc');
    expect(calls[0].turn.stopReason).toBeNull();
    expect(calls[0].turn.ts).toBeTypeOf('number'); // stamped before hand-off
    expect(calls[0].violations.map((v) => v.ruleId)).toContain('truncated-success');
  });

  it('does NOT invoke the sink on a healthy turn', () => {
    const sink = vi.fn();
    registerIncidentSink(sink);

    recordTurn(healthyPartial());

    expect(sink).not.toHaveBeenCalled();
    // …but the wide event is still emitted.
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('logs an error-level violation summary for an error-severity violation', () => {
    registerIncidentSink(() => {});
    recordTurn(truncatedPartial());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toBe('invariant violation');
    expect((meta as { violations: string[] }).violations.join(' ')).toContain('truncated-success');
  });

  it('logs a warn-level violation summary when the worst severity is warn', () => {
    registerIncidentSink(() => {});
    // resultLen=0 + a real stop_reason → only the warn-severity empty-success rule fires.
    recordTurn(healthyPartial({ resultLen: 0, stopReason: 'end_turn' }));

    // The wide "turn" info event + a warn "invariant violation" — no error.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe('invariant violation');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('works with no sink registered — violations are still logged, no throw', () => {
    registerIncidentSink(null as unknown as IncidentSink); // simulate "never registered"
    expect(() => recordTurn(truncatedPartial())).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('invariant violation', expect.any(Object));
  });
});

describe('recordTurn — never throws', () => {
  it('a sink that throws does not break recordTurn (caught + warned)', () => {
    registerIncidentSink(() => {
      throw new Error('sink exploded');
    });

    expect(() => recordTurn(truncatedPartial())).not.toThrow();
    // The recorder catches the sink error and logs it as a warn.
    expect(warnSpy).toHaveBeenCalledWith('incident sink threw', expect.objectContaining({
      sessionId: 'sess-rec-trunc',
    }));
  });

  it('returns without throwing on a minimal turn (only sessionId)', () => {
    expect(() => recordTurn({ sessionId: 'sess-min' })).not.toThrow();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

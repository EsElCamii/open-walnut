/**
 * Unit tests for the forensic-observability invariant engine.
 *
 * Each seed rule asserts what a *healthy* turn looks like; a violation is the
 * fingerprint of a "silent success" bug (truncation, empty result, slow
 * delivery). These tests pin every rule's positive AND negative cases so a
 * future edit that widens/narrows a rule fails loudly here instead of either
 * going silent (missed bug) or spamming false incidents (alert fatigue).
 *
 * Pure logic — no server, no disk. Runs in the unit tier.
 */
import { describe, it, expect } from 'vitest';
import {
  INVARIANT_RULES,
  evaluateInvariants,
} from '../../../src/core/observability/invariants.js';
import type { InvariantRule, TurnEvent } from '../../../src/core/observability/types.js';

/** Minimal healthy turn — every field that a rule could trip on is benign. */
function healthyTurn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    sessionId: 'sess-healthy',
    isError: false,
    subtype: 'success',
    stopReason: 'end_turn',
    resultLen: 42,
    deliveryMs: 150,
    deliveryPath: 'stdin',
    teamActive: false,
    ts: Date.now(),
    ...overrides,
  };
}

/** Run a single rule by id against a turn and return its reason (or null). */
function runRule(id: string, turn: TurnEvent): string | null | undefined {
  const rule = INVARIANT_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`no such rule: ${id}`);
  return rule.check(turn);
}

/** Get violations from evaluateInvariants filtered to a single rule id. */
function violationsFor(id: string, turn: TurnEvent): string[] {
  return evaluateInvariants(turn)
    .filter((v) => v.ruleId === id)
    .map((v) => v.reason);
}

describe('invariant: truncated-success', () => {
  it('flags subtype=success with stopReason=null (the 1fc886da fingerprint)', () => {
    const reason = runRule('truncated-success', healthyTurn({ stopReason: null }));
    expect(reason).toBeTruthy();
    expect(reason).toContain('truncated');
    // surfaces through the public evaluate API too
    expect(violationsFor('truncated-success', healthyTurn({ stopReason: null }))).toHaveLength(1);
  });

  it('flags subtype=success with empty-string stopReason', () => {
    expect(runRule('truncated-success', healthyTurn({ stopReason: '' }))).toBeTruthy();
  });

  it('passes a success turn with a real stopReason', () => {
    expect(runRule('truncated-success', healthyTurn({ stopReason: 'end_turn' }))).toBeFalsy();
  });

  it('does NOT flag when stopReason is undefined (we never captured it)', () => {
    // undefined = not measured; flagging here would false-alarm on every turn
    // where the CLI didn't surface a stop_reason. Only null/'' is truncation.
    expect(runRule('truncated-success', healthyTurn({ stopReason: undefined }))).toBeFalsy();
  });

  it('excludes team turns (intermediate team results legitimately lack a final stop_reason)', () => {
    expect(
      runRule('truncated-success', healthyTurn({ teamActive: true, stopReason: null })),
    ).toBeFalsy();
  });

  it('does NOT flag genuine errors (handled elsewhere)', () => {
    expect(
      runRule('truncated-success', healthyTurn({ isError: true, subtype: 'error_max_turns', stopReason: null })),
    ).toBeFalsy();
  });

  it('treats isError===false as a success even when subtype is not "success"', () => {
    // The rule's `succeeded` is (subtype==='success' || isError===false), so a
    // turn that reports isError:false must still end with a real stop_reason.
    const turn = healthyTurn({ subtype: 'other', isError: false, stopReason: null });
    expect(runRule('truncated-success', turn)).toBeTruthy();
  });

  it('is an error-severity rule', () => {
    const rule = INVARIANT_RULES.find((r) => r.id === 'truncated-success')!;
    expect(rule.severity).toBe('error');
  });
});

describe('invariant: empty-success', () => {
  it('flags a success turn with resultLen=0 (silent no-op)', () => {
    const reason = runRule('empty-success', healthyTurn({ resultLen: 0 }));
    expect(reason).toBeTruthy();
    expect(violationsFor('empty-success', healthyTurn({ resultLen: 0 }))).toHaveLength(1);
  });

  it('passes a success turn with non-empty result text', () => {
    expect(runRule('empty-success', healthyTurn({ resultLen: 50 }))).toBeFalsy();
  });

  it('does NOT flag when resultLen is undefined (not measured)', () => {
    expect(runRule('empty-success', healthyTurn({ resultLen: undefined }))).toBeFalsy();
  });

  it('excludes team turns and genuine errors', () => {
    expect(runRule('empty-success', healthyTurn({ teamActive: true, resultLen: 0 }))).toBeFalsy();
    expect(runRule('empty-success', healthyTurn({ isError: true, resultLen: 0 }))).toBeFalsy();
  });

  it('is a warn-severity rule', () => {
    const rule = INVARIANT_RULES.find((r) => r.id === 'empty-success')!;
    expect(rule.severity).toBe('warn');
  });
});

describe('invariant: slow-delivery', () => {
  it('flags a delivery that took >= 30s', () => {
    const reason = runRule('slow-delivery', healthyTurn({ deliveryMs: 45_000, deliveryPath: 'mid-turn' }));
    expect(reason).toBeTruthy();
    expect(reason).toContain('45s');
    expect(reason).toContain('mid-turn');
  });

  it('treats exactly 30s as slow (boundary is inclusive)', () => {
    expect(runRule('slow-delivery', healthyTurn({ deliveryMs: 30_000 }))).toBeTruthy();
  });

  it('passes a fast delivery (200ms)', () => {
    expect(runRule('slow-delivery', healthyTurn({ deliveryMs: 200 }))).toBeFalsy();
  });

  it('passes just under the threshold (29.9s)', () => {
    expect(runRule('slow-delivery', healthyTurn({ deliveryMs: 29_900 }))).toBeFalsy();
  });

  it('does NOT flag when deliveryMs is undefined (not measured)', () => {
    expect(runRule('slow-delivery', healthyTurn({ deliveryMs: undefined }))).toBeFalsy();
  });

  it('is a warn-severity rule', () => {
    const rule = INVARIANT_RULES.find((r) => r.id === 'slow-delivery')!;
    expect(rule.severity).toBe('warn');
  });
});

describe('evaluateInvariants', () => {
  it('returns [] for a fully healthy turn', () => {
    expect(evaluateInvariants(healthyTurn())).toEqual([]);
  });

  it('collects multiple violations from one unhealthy turn', () => {
    // truncated (stopReason=null) + empty (resultLen=0) + slow (deliveryMs=45s)
    const turn = healthyTurn({ stopReason: null, resultLen: 0, deliveryMs: 45_000 });
    const ids = evaluateInvariants(turn).map((v) => v.ruleId).sort();
    expect(ids).toEqual(['empty-success', 'slow-delivery', 'truncated-success']);
  });

  it('carries each rule\'s severity into the violation', () => {
    const v = evaluateInvariants(healthyTurn({ stopReason: null }));
    expect(v.find((x) => x.ruleId === 'truncated-success')?.severity).toBe('error');
  });

  it('swallows a rule that throws — a buggy rule must not break turn completion', () => {
    const exploding: InvariantRule = {
      id: 'boom',
      description: 'always throws',
      severity: 'error',
      check: () => {
        throw new Error('rule blew up');
      },
    };
    const healthy: InvariantRule = {
      id: 'fine',
      description: 'never fires',
      severity: 'warn',
      check: () => null,
    };
    // Must not throw, and the surviving rules still evaluate.
    expect(() => evaluateInvariants(healthyTurn(), [exploding, healthy])).not.toThrow();
    expect(evaluateInvariants(healthyTurn(), [exploding, healthy])).toEqual([]);
  });

  it('uses INVARIANT_RULES by default but accepts a custom rule set', () => {
    const onlyTruncated = INVARIANT_RULES.filter((r) => r.id === 'truncated-success');
    const turn = healthyTurn({ stopReason: null, resultLen: 0, deliveryMs: 45_000 });
    // With only the truncated rule, the empty/slow violations are not reported.
    expect(evaluateInvariants(turn, onlyTruncated).map((v) => v.ruleId)).toEqual(['truncated-success']);
  });
});

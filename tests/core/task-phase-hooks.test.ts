/**
 * Unit tests for task phase hook registry.
 *
 * B1: getHookInfoList() returns enriched fields
 * B4: getHooksForPhase() filter + sort
 */
import { describe, it, expect } from 'vitest';
import { getHookInfoList, getHooksForPhase } from '../../src/core/task-phase-hooks/index.js';

describe('getHookInfoList (B1)', () => {
  it('returns a non-empty array with the human-verified-auto-push hook', () => {
    const list = getHookInfoList();
    expect(list.length).toBeGreaterThan(0);

    const first = list[0];
    expect(first.id).toBe('human-verified-auto-push');
    expect(first.actionType).toBe('send_message');
    expect(first.triggerPhase).toBe('HUMAN_VERIFIED');
  });

  it('actionDetail starts with Send message and contains User has verified', () => {
    const list = getHookInfoList();
    const first = list[0];

    expect(first.actionDetail).toMatch(/^Send message: "/);
    expect(first.actionDetail).toContain('User has verified');
  });

  it('conditions is ["Requires active session"]', () => {
    const list = getHookInfoList();
    const first = list[0];

    expect(first.conditions).toEqual(['Requires active session']);
  });

  it('priority is 100 and fromPhases is undefined', () => {
    const list = getHookInfoList();
    const first = list[0];

    expect(first.priority).toBe(100);
    expect(first.fromPhases).toBeUndefined();
  });
});

describe('getHooksForPhase (B4)', () => {
  it('HUMAN_VERIFIED returns 1+ hooks with correct shape', () => {
    const hooks = getHooksForPhase('HUMAN_VERIFIED');
    expect(hooks.length).toBeGreaterThanOrEqual(1);

    const hook = hooks[0];
    expect(hook.id).toBe('human-verified-auto-push');
    expect(hook.triggerPhase).toBe('HUMAN_VERIFIED');
    expect(hook.action).toBeDefined();
    expect(hook.action.type).toBe('send_message');
  });

  it('TODO returns empty array (no hooks registered for TODO)', () => {
    const hooks = getHooksForPhase('TODO');
    expect(hooks).toEqual([]);
  });

  it('NONEXISTENT returns empty array', () => {
    const hooks = getHooksForPhase('NONEXISTENT');
    expect(hooks).toEqual([]);
  });
});

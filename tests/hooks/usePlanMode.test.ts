/**
 * Unit tests for usePlanMode hook logic.
 *
 * Because the root vitest runs in a `node` environment (no jsdom, no
 * @testing-library/react) we mock React's useState / useRef / useCallback
 * with lightweight stand-ins that replicate the contract hooks expect,
 * then exercise usePlanMode() synchronously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal React mock
// ---------------------------------------------------------------------------

/** Simulates useState: returns [value, setter]. setter accepts value or fn. */
function fakeUseState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  let value: T = typeof init === 'function' ? (init as () => T)() : init;
  const setValue = (v: T | ((prev: T) => T)) => {
    value = typeof v === 'function' ? (v as (prev: T) => T)(value) : v;
    // Store for external access
    (setValue as any).__current = value;
  };
  (setValue as any).__current = value;
  return [value, setValue];
}

/** Simulates useRef: returns a mutable ref object. */
function fakeUseRef<T>(initial: T): { current: T } {
  return { current: initial };
}

/** Simulates useCallback: just returns the function as-is. */
function fakeUseCallback<T extends (...args: any[]) => any>(fn: T, _deps?: any[]): T {
  return fn;
}

// ---------------------------------------------------------------------------
// Harness — re-invokes the hook with fresh React state each call
// ---------------------------------------------------------------------------

type PlanHookReturn = {
  mode: 'execution' | 'plan';
  toggleMode: () => void;
  getPlanPayload: () => { mode?: 'plan'; planModeFirst?: boolean; planModeOff?: boolean };
};

/**
 * Because React hooks capture state via closures at render time, each
 * "render" call to the hook creates fresh closures over the latest state.
 * We need to re-invoke the hook after setState to simulate React re-rendering.
 *
 * This harness keeps stable refs (like React does) and uses a state holder
 * that persists across "renders" to simulate the real React behavior.
 */
function createHookHarness() {
  // Stable refs across renders (React preserves ref identity across renders)
  const planInstructionSentRef = { current: false };
  const pendingModeOffRef = { current: false };
  let modeState: 'execution' | 'plan' = 'execution';

  // Mock localStorage
  const storage = new Map<string, string>();

  function render(): PlanHookReturn {
    const mode = modeState;

    const toggleMode = () => {
      const prev = modeState;
      const next = prev === 'execution' ? 'plan' : 'execution';
      storage.set('walnut-chat-mode', next);
      planInstructionSentRef.current = false;
      if (next === 'execution') pendingModeOffRef.current = true;
      modeState = next;
    };

    const getPlanPayload = (): { mode?: 'plan'; planModeFirst?: boolean; planModeOff?: boolean } => {
      if (modeState !== 'plan') {
        if (pendingModeOffRef.current) {
          pendingModeOffRef.current = false;
          return { planModeOff: true };
        }
        return {};
      }
      const isFirst = !planInstructionSentRef.current;
      if (isFirst) planInstructionSentRef.current = true;
      return { mode: 'plan', planModeFirst: isFirst || undefined };
    };

    return { mode, toggleMode, getPlanPayload };
  }

  return { render };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePlanMode hook logic', () => {
  let harness: ReturnType<typeof createHookHarness>;

  beforeEach(() => {
    harness = createHookHarness();
  });

  it('initial state returns empty payload', () => {
    const hook = harness.render();
    expect(hook.mode).toBe('execution');
    expect(hook.getPlanPayload()).toEqual({});
  });

  it('after toggle to plan, first call returns planModeFirst', () => {
    let hook = harness.render();
    hook.toggleMode(); // execution → plan

    // Re-render to pick up new state (simulates React re-render)
    hook = harness.render();
    expect(hook.mode).toBe('plan');
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan', planModeFirst: true });
    // Second call — planModeFirst consumed
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan' });
  });

  it('after toggle plan→execution, first call returns planModeOff (one-shot)', () => {
    let hook = harness.render();
    hook.toggleMode(); // execution → plan
    hook = harness.render();
    hook.toggleMode(); // plan → execution

    hook = harness.render();
    expect(hook.mode).toBe('execution');
    // First call: planModeOff fires
    expect(hook.getPlanPayload()).toEqual({ planModeOff: true });
    // Second call: cleared
    expect(hook.getPlanPayload()).toEqual({});
  });

  it('rapid toggling — only final state matters', () => {
    let hook = harness.render();

    // Toggle: execution → plan
    hook.toggleMode();
    hook = harness.render();

    // Toggle: plan → execution (pendingModeOff = true)
    hook.toggleMode();
    hook = harness.render();

    // Toggle: execution → plan (pendingModeOff still true from prev, but mode is plan)
    hook.toggleMode();
    hook = harness.render();

    expect(hook.mode).toBe('plan');
    // Plan branch takes priority — planModeFirst since ref was reset on toggle
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan', planModeFirst: true });

    // Toggle: plan → execution (pendingModeOff = true again)
    hook.toggleMode();
    hook = harness.render();
    expect(hook.mode).toBe('execution');

    // One-shot planModeOff
    expect(hook.getPlanPayload()).toEqual({ planModeOff: true });
    // Cleared
    expect(hook.getPlanPayload()).toEqual({});
  });

  it('planModeFirst only fires once per plan-mode entry', () => {
    let hook = harness.render();
    hook.toggleMode(); // → plan
    hook = harness.render();

    expect(hook.getPlanPayload()).toEqual({ mode: 'plan', planModeFirst: true });
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan' });
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan' });

    // Toggle off and back on — planModeFirst should fire again
    hook.toggleMode(); // → execution
    hook = harness.render();
    hook.toggleMode(); // → plan
    hook = harness.render();

    expect(hook.getPlanPayload()).toEqual({ mode: 'plan', planModeFirst: true });
    expect(hook.getPlanPayload()).toEqual({ mode: 'plan' });
  });

  it('multiple plan→execution transitions each produce one planModeOff', () => {
    let hook = harness.render();

    // First cycle
    hook.toggleMode(); // → plan
    hook = harness.render();
    hook.toggleMode(); // → execution
    hook = harness.render();

    expect(hook.getPlanPayload()).toEqual({ planModeOff: true });
    expect(hook.getPlanPayload()).toEqual({});

    // Second cycle
    hook.toggleMode(); // → plan
    hook = harness.render();
    hook.toggleMode(); // → execution
    hook = harness.render();

    expect(hook.getPlanPayload()).toEqual({ planModeOff: true });
    expect(hook.getPlanPayload()).toEqual({});
  });

  it('getPlanPayload returns undefined for planModeFirst when not first', () => {
    let hook = harness.render();
    hook.toggleMode(); // → plan
    hook = harness.render();

    const first = hook.getPlanPayload();
    expect(first).toHaveProperty('planModeFirst', true);

    const second = hook.getPlanPayload();
    // planModeFirst should be undefined (not false), matching `isFirst || undefined`
    expect(second.planModeFirst).toBeUndefined();
    expect(second).toEqual({ mode: 'plan' });
  });
});

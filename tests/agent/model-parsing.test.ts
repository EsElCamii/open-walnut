/**
 * Tests for model string parsing, sanitization, and context window detection.
 *
 * These functions sit on the critical path between Claude CLI output and
 * the UI displaying context window usage %. A bug here silently produces
 * wrong numbers (e.g. 125% instead of 25%) with no error — hence the
 * thorough coverage.
 *
 * Key invariant: the [1m] context-window marker must NEVER be stripped
 * by ANSI-cleaning code. ANSI bold is `\x1b[1m` (with ESC prefix);
 * Claude Code's context marker is a bare `[1m]` suffix (no ESC).
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeInitModel,
  stripModelSuffix,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
} from '../../src/agent/providers/defaults.js';
import { getContextWindowSize } from '../../src/agent/model.js';

// ── sanitizeInitModel ──

describe('sanitizeInitModel', () => {
  describe('clean model strings (no ANSI)', () => {
    it('preserves plain Bedrock model ID', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('preserves model with [1m] context marker', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[1m]'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });

    it('preserves short model ID', () => {
      expect(sanitizeInitModel('claude-opus-4-6'))
        .toBe('claude-opus-4-6');
    });

    it('preserves sonnet model', () => {
      expect(sanitizeInitModel('global.anthropic.claude-sonnet-4-6-v1'))
        .toBe('global.anthropic.claude-sonnet-4-6-v1');
    });

    it('preserves haiku model', () => {
      expect(sanitizeInitModel('claude-haiku-4-5-20251001'))
        .toBe('claude-haiku-4-5-20251001');
    });

    it('preserves model with [1m] and different versions', () => {
      expect(sanitizeInitModel('global.anthropic.claude-sonnet-4-6-v1[1m]'))
        .toBe('global.anthropic.claude-sonnet-4-6-v1[1m]');
    });
  });

  describe('ANSI escape stripping', () => {
    it('strips \\x1b[1m (bold) from end — THE bug that caused 125%', () => {
      // Claude CLI sometimes appends ANSI bold to the model field
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[1m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips \\x1b[0m (reset) from end', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips multiple ANSI sequences', () => {
      expect(sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips ANSI color codes', () => {
      expect(sanitizeInitModel('\x1b[32mglobal.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips ANSI but preserves [1m] context marker', () => {
      // Critical: model has BOTH real ANSI and a [1m] suffix
      expect(sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1[1m]\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });

    it('strips \\x1b[1m before [1m] suffix — ANSI bold wrapping 1M model', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[1m[1m]'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });
  });

  describe('validation — rejects malformed strings', () => {
    it('rejects orphan ] (the exact bug: second regex stripped [1m, left ])', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1]'))
        .toBeUndefined();
    });

    it('rejects unknown bracket suffix like [2m]', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[2m]'))
        .toBeUndefined();
    });

    it('rejects orphan [', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1['))
        .toBeUndefined();
    });

    it('rejects strings with spaces', () => {
      expect(sanitizeInitModel('claude opus 4-6'))
        .toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(sanitizeInitModel(''))
        .toBeUndefined();
    });
  });
});

// ── stripModelSuffix ──

describe('stripModelSuffix', () => {
  it('strips [1m] from end', () => {
    expect(stripModelSuffix('global.anthropic.claude-opus-4-6-v1[1m]'))
      .toBe('global.anthropic.claude-opus-4-6-v1');
  });

  it('leaves model without [1m] unchanged', () => {
    expect(stripModelSuffix('global.anthropic.claude-opus-4-6-v1'))
      .toBe('global.anthropic.claude-opus-4-6-v1');
  });

  it('only strips trailing [1m], not mid-string', () => {
    expect(stripModelSuffix('[1m]global.anthropic.claude-opus-4-6-v1'))
      .toBe('[1m]global.anthropic.claude-opus-4-6-v1');
  });
});

// ── getContextWindowSize ──

describe('getContextWindowSize', () => {
  it('returns 1M for model with [1m] suffix', () => {
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1[1m]'))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('returns 200K for model without [1m]', () => {
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1'))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('returns 200K for undefined', () => {
    expect(getContextWindowSize(undefined))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('returns 200K for malformed orphan-] model', () => {
    // This is what the bug produced: the ] left behind after bad stripping
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1]'))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  // ── totalInput auto-upgrade to 1M ──

  it('auto-upgrades to 1M when totalInput > 200K even without [1m] suffix', () => {
    // Claude CLI resumes sometimes drop the [1m] suffix — the 434% bug
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1', 868_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('stays 200K when totalInput is under 200K and no [1m]', () => {
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1', 150_000))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('stays 1M from [1m] even when totalInput is low', () => {
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1[1m]', 50_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('auto-upgrades when model is undefined but totalInput > 200K', () => {
    expect(getContextWindowSize(undefined, 300_000))
      .toBe(CONTEXT_WINDOW_1M);
  });
});

// ── End-to-end: sanitize → context window ──

describe('sanitizeInitModel → getContextWindowSize pipeline', () => {
  it('1M model survives sanitize and is detected as 1M', () => {
    const sanitized = sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[1m]');
    expect(sanitized).toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    expect(getContextWindowSize(sanitized)).toBe(CONTEXT_WINDOW_1M);
  });

  it('200K model survives sanitize and is detected as 200K', () => {
    const sanitized = sanitizeInitModel('global.anthropic.claude-opus-4-6-v1');
    expect(sanitized).toBe('global.anthropic.claude-opus-4-6-v1');
    expect(getContextWindowSize(sanitized)).toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('ANSI-wrapped 1M model → sanitize → still detected as 1M', () => {
    const sanitized = sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1[1m]\x1b[0m');
    expect(sanitized).toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    expect(getContextWindowSize(sanitized)).toBe(CONTEXT_WINDOW_1M);
  });

  it('ANSI bold (no [1m] suffix) → sanitize → detected as 200K', () => {
    const sanitized = sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[1m');
    expect(sanitized).toBe('global.anthropic.claude-opus-4-6-v1');
    expect(getContextWindowSize(sanitized)).toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('context % math: 249K tokens with correct 1M window = 25%, not 125%', () => {
    const sanitized = sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[1m]');
    const windowSize = getContextWindowSize(sanitized);
    const totalInput = 249_366;
    const contextPercent = Math.round(totalInput / windowSize * 100);
    expect(contextPercent).toBe(25);
    // The bug would produce: 249366/200000*100 = 125
    expect(Math.round(totalInput / CONTEXT_WINDOW_DEFAULT * 100)).toBe(125);
  });

  it('CLI resume drops [1m] but totalInput auto-corrects — 868K = 87%, not 434%', () => {
    // Simulates: session started with [1m], later resume emitted model without [1m]
    const modelAfterResume = sanitizeInitModel('global.anthropic.claude-opus-4-6-v1');
    expect(modelAfterResume).toBe('global.anthropic.claude-opus-4-6-v1');
    const totalInput = 868_000;
    const windowSize = getContextWindowSize(modelAfterResume, totalInput);
    expect(windowSize).toBe(CONTEXT_WINDOW_1M);
    expect(Math.round(totalInput / windowSize * 100)).toBe(87);
    // The old bug would produce: 868000/200000*100 = 434
    expect(Math.round(totalInput / CONTEXT_WINDOW_DEFAULT * 100)).toBe(434);
  });
});

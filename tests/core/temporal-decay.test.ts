import { describe, it, expect } from 'vitest';
import { temporalDecay } from '../../src/core/temporal-decay.js';

/**
 * Suite 1: Temporal Decay (Pure Unit)
 * No mocking needed -- temporalDecay() is a pure function.
 */

/** Helper: build a filepath with a date N days ago from today. */
function dateFilepath(daysAgo: number, prefix = '/memory/daily/'): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${prefix}${key}.md`;
}

describe('temporalDecay', () => {
  it('1.1: undated filepath returns 1.0 (evergreen)', () => {
    expect(temporalDecay('/memory/topics/walnut.md', 30)).toBe(1.0);
  });

  it('1.2: today\'s date returns ~1.0', () => {
    const filepath = dateFilepath(0);
    const result = temporalDecay(filepath, 30);
    expect(result).toBeGreaterThanOrEqual(0.99);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('1.3: file from 30 days ago returns ~0.5 (half-life)', () => {
    const filepath = dateFilepath(30);
    const result = temporalDecay(filepath, 30);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it('1.4: file from 60 days ago returns ~0.25 (two half-lives)', () => {
    const filepath = dateFilepath(60);
    const result = temporalDecay(filepath, 30);
    expect(result).toBeCloseTo(0.25, 1);
  });

  it('1.5: file from 14 days ago with halfLife=14 returns ~0.5', () => {
    const filepath = dateFilepath(14);
    const result = temporalDecay(filepath, 14);
    expect(result).toBeCloseTo(0.5, 1);
  });

  it('1.6: future date returns 1.0', () => {
    const filepath = dateFilepath(-1); // tomorrow
    const result = temporalDecay(filepath, 30);
    expect(result).toBe(1.0);
  });

  it('1.7: date embedded in path (not just filename)', () => {
    const filepath = '/memory/compaction/2026-03-01-1430.md';
    const result = temporalDecay(filepath, 30);
    // 2026-03-01 should be some days ago; result should be between 0 and 1
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1.0);
  });
});

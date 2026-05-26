import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, WORKING_MEMORY_FILE } from '../../src/constants.js';
import {
  resetUpdaterState,
  setCompacting,
  trackToolCall,
  shouldUpdateWorkingMemory,
  executeWorkingMemoryUpdate,
  buildWorkingMemoryUpdatePrompt,
} from '../../src/agent/working-memory-updater.js';

/**
 * Suite 3: Working Memory Updater (Unit)
 */

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  resetUpdaterState();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('shouldUpdateWorkingMemory', () => {
  it('3.1: returns false below initialization threshold', () => {
    for (let i = 0; i < 5; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(5000)).toBe(false);
  });

  it('3.2: returns false without enough tool calls', () => {
    trackToolCall();
    trackToolCall();
    // 2 tool calls, below threshold of 3
    expect(shouldUpdateWorkingMemory(15000)).toBe(false);
  });

  it('3.3: returns true at initialization threshold', () => {
    for (let i = 0; i < 3; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);
  });

  it('3.4: subsequent update needs 5K growth + 3 tool calls', async () => {
    // Simulate first extraction
    const mockRunForkedTurn = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 3; i++) trackToolCall();
    await executeWorkingMemoryUpdate(mockRunForkedTurn, 10000);

    // Track 3 tool calls for the next check
    for (let i = 0; i < 3; i++) trackToolCall();

    // Only 4K growth (< 5K threshold)
    expect(shouldUpdateWorkingMemory(14000)).toBe(false);

    // 5K growth + 3 tool calls
    expect(shouldUpdateWorkingMemory(15000)).toBe(true);
  });

  it('3.5: setCompacting(true) blocks updates', () => {
    for (let i = 0; i < 3; i++) trackToolCall();
    setCompacting(true);
    expect(shouldUpdateWorkingMemory(20000)).toBe(false);

    setCompacting(false);
    expect(shouldUpdateWorkingMemory(20000)).toBe(true);
  });

  it('3.6: trackToolCall() increments counter', () => {
    trackToolCall();
    trackToolCall();
    trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);
  });
});

describe('executeWorkingMemoryUpdate', () => {
  it('3.7: calls runForkedTurn and resets state', async () => {
    const mockRunForkedTurn = vi.fn().mockResolvedValue(undefined);
    await executeWorkingMemoryUpdate(mockRunForkedTurn, 15000);

    expect(mockRunForkedTurn).toHaveBeenCalledOnce();
    // The prompt should reference WORKING_MEMORY_FILE
    const prompt = mockRunForkedTurn.mock.calls[0][0] as string;
    expect(prompt).toContain(WORKING_MEMORY_FILE);

    // After execution, shouldUpdateWorkingMemory returns false (reset state)
    // Need 3 tool calls + 5K token growth from 15000
    expect(shouldUpdateWorkingMemory(15000)).toBe(false);
  });

  it('3.8: handles runForkedTurn failure gracefully', async () => {
    const mockRunForkedTurn = vi.fn().mockRejectedValue(new Error('LLM timeout'));

    // Should not throw
    await executeWorkingMemoryUpdate(mockRunForkedTurn, 15000);

    // extractionStartedAt should be reset, so a subsequent check with fresh tool calls
    // should be able to trigger again
    for (let i = 0; i < 3; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(15000)).toBe(true);
  });
});

describe('buildWorkingMemoryUpdatePrompt', () => {
  it('3.9: includes current content and size warnings', () => {
    // Write oversized content to WORKING_MEMORY_FILE
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    // Need content that exceeds MAX_SECTION_TOKENS (2000) when tokenized
    const bigContent = 'the quick brown fox jumps over the lazy dog and runs around the park. '.repeat(500);
    fs.writeFileSync(
      WORKING_MEMORY_FILE,
      `# Active Focus\n${bigContent}\n# User Requests\nSmall content\n`,
      'utf-8',
    );

    const prompt = buildWorkingMemoryUpdatePrompt();
    expect(prompt).toContain('<current_working_memory>');
    expect(prompt).toContain('WARNING:');
    expect(prompt).toContain('Active Focus');
    expect(prompt).toContain('file_edit');
  });
});

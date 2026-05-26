/**
 * Category 3: Dream Consolidation E2E
 *
 * Tests dream gating conditions, lock mechanism, state persistence,
 * prompt construction, directory initialization, and LLM integration boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedDreamState,
  seedSessionsJson,
  seedDailyLog,
  seedWorkingMemory,
  seedCompactionFile,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock agent loop and files-tools to prevent real LLM calls
vi.mock('../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async () => {}),
}));
vi.mock('../../src/agent/tools/files-tools.js', () => ({
  filesTools: [],
}));

import {
  WALNUT_HOME,
  MEMORY_DIR,
  TOPICS_DIR,
  COMPACTION_DIR,
  MEMORY_INDEX_FILE,
  SESSIONS_FILE,
  WORKING_MEMORY_FILE,
  DAILY_DIR,
} from '../../src/constants.js';
import {
  shouldDream,
  ensureDreamDirectories,
  ensureMemoryIndex,
  executeDream,
} from '../../src/core/dream.js';

let tmpDir: string;
const DREAM_STATE_FILE = path.join(MEMORY_DIR, '.dream-state.json');
const DREAM_LOCK_FILE = path.join(MEMORY_DIR, '.dream-lock');

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
  // Clean up lock files
  try { await fsp.unlink(DREAM_LOCK_FILE); } catch { /* ok */ }
});

afterEach(async () => {
  try { await fsp.unlink(DREAM_LOCK_FILE); } catch { /* ok */ }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── 3.1 Dream Gating: Not Enough Time Since Last Dream ──

describe('Dream Gating', () => {
  it('3.1: returns false when < 24h since last dream', async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    seedDreamState(WALNUT_HOME, oneHourAgo.toISOString());

    // Even with enough sessions
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 10 }, () => ({ startedAt: recentTime })),
    );

    expect(await shouldDream()).toBe(false);
  });

  // ── 3.2 Not Enough Sessions ──

  it('3.2: returns false when < 5 sessions since last dream', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    seedDreamState(WALNUT_HOME, twoDaysAgo.toISOString());

    // Only 3 sessions after dream time
    const afterDream = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(WALNUT_HOME, [
      { startedAt: afterDream },
      { startedAt: afterDream },
      { startedAt: afterDream },
    ]);

    expect(await shouldDream()).toBe(false);
  });

  // ── 3.3 Conditions Met ──

  it('3.3: returns true when both conditions met', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    seedDreamState(WALNUT_HOME, twoDaysAgo.toISOString());

    const afterDream = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 7 }, () => ({ startedAt: afterDream })),
    );

    expect(await shouldDream()).toBe(true);
  });

  // ── 3.4 No Prior Dream State ──

  it('3.4: returns true when no prior dream state', async () => {
    // No .dream-state.json file — lastDreamTime = 0
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    expect(await shouldDream()).toBe(true);
  });
});

// ── 3.5 Dream Lock Mechanism ──

describe('Dream Lock', () => {
  it('3.5: lock prevents concurrent dream execution', async () => {
    // Set up conditions for dream to run
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    // Verify dream conditions are met (no dream state + enough sessions)
    expect(await shouldDream()).toBe(true);

    // Create a lock file with current process PID (active lock)
    fs.writeFileSync(
      DREAM_LOCK_FILE,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
      { encoding: 'utf-8', flag: 'wx' },
    );

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();

    await executeDream();

    // Lock was held — runAgentLoop should NOT have been called
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  // ── 3.6 Stale Lock Detection ──

  it('3.6: stale lock is reclaimed', async () => {
    // Set up conditions for dream to run
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    // Create a stale lock: 90 minutes old with a non-existent PID
    const staleTime = new Date(Date.now() - 90 * 60 * 1000);
    fs.writeFileSync(
      DREAM_LOCK_FILE,
      JSON.stringify({
        pid: 99999999,
        startedAt: staleTime.toISOString(),
      }),
      'utf-8',
    );
    // Set mtime to 90 minutes ago
    const staleMs = staleTime.getTime();
    fs.utimesSync(DREAM_LOCK_FILE, staleMs / 1000, staleMs / 1000);

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    // Stale lock was replaced — dream should have run
    expect(mockRunAgentLoop).toHaveBeenCalled();
  });
});

// ── 3.7 Dream State Persistence ──

describe('Dream State Persistence', () => {
  it('3.7: executeDream persists state and cleans up lock', async () => {
    // No dream state → dream should run
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    // Dream state should be updated
    expect(fs.existsSync(DREAM_STATE_FILE)).toBe(true);
    const state = JSON.parse(fs.readFileSync(DREAM_STATE_FILE, 'utf-8'));
    expect(state.lastDreamAt).toBeDefined();
    // lastDreamAt should be within the last few seconds
    const dreamTime = new Date(state.lastDreamAt).getTime();
    expect(Date.now() - dreamTime).toBeLessThan(10000);

    // Lock file should be cleaned up
    expect(fs.existsSync(DREAM_LOCK_FILE)).toBe(false);
  });
});

// ── 3.8 Dream Prompt Construction ──

describe('Dream Prompt Construction', () => {
  it('3.8: prompt references correct directories and phases', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    seedDreamState(WALNUT_HOME, twoDaysAgo.toISOString());

    // Seed data for prompt context
    seedDailyLog(WALNUT_HOME, daysAgoStr(0), 'Today activity log.');
    seedWorkingMemory(WALNUT_HOME, '# Active Focus\nWorking on dreams.');
    seedCompactionFile(WALNUT_HOME, daysAgoStr(0) + '-1200', '---\nsource: compaction\n---\nCompacted content.');

    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    expect(mockRunAgentLoop).toHaveBeenCalledOnce();

    const [prompt, history, callbacks, options] = mockRunAgentLoop.mock.calls[0];

    // Prompt references correct directories
    expect(prompt).toContain(MEMORY_INDEX_FILE);
    expect(prompt).toContain(TOPICS_DIR);
    expect(prompt).toContain(DAILY_DIR);
    expect(prompt).toContain(WORKING_MEMORY_FILE);
    expect(prompt).toContain(COMPACTION_DIR);

    // All 4 phases present
    expect(prompt).toContain('## Phase 1');
    expect(prompt).toContain('## Phase 2');
    expect(prompt).toContain('## Phase 3');
    expect(prompt).toContain('## Phase 4');

    // Prompt contains the "since" date from lastDreamAt
    expect(prompt).toContain(twoDaysAgo.toISOString().slice(0, 10));

    // Prompt contains topic file format template
    expect(prompt).toContain('title: Topic Name');
  });
});

// ── 3.9 Dream Directory Initialization ──

describe('Dream Directory Initialization', () => {
  it('3.9: creates topics, compaction, and index.md', () => {
    ensureDreamDirectories();

    expect(fs.existsSync(TOPICS_DIR)).toBe(true);
    expect(fs.existsSync(COMPACTION_DIR)).toBe(true);
    expect(fs.existsSync(MEMORY_INDEX_FILE)).toBe(true);

    const indexContent = fs.readFileSync(MEMORY_INDEX_FILE, 'utf-8');
    expect(indexContent).toContain('# Memory Index');
    expect(indexContent).toContain('## Topics');
    expect(indexContent).toContain('## Active Projects');
    expect(indexContent).toContain('## Recent Daily Logs');
  });

  it('3.9b: index.md is idempotent', () => {
    const customContent = '# Memory Index\n\n## Topics\n- [Walnut](topics/walnut.md)';
    fs.mkdirSync(path.dirname(MEMORY_INDEX_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_INDEX_FILE, customContent, 'utf-8');

    ensureMemoryIndex();

    const content = fs.readFileSync(MEMORY_INDEX_FILE, 'utf-8');
    expect(content).toBe(customContent);
  });
});

// ── 3.10 Dream Execution - LLM Integration Boundary ──

describe('Dream Execution - Integration Boundary', () => {
  it('3.10: calls runAgentLoop with correct configuration', async () => {
    // No dream state → dream should run
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    seedSessionsJson(
      WALNUT_HOME,
      Array.from({ length: 6 }, () => ({ startedAt: recentTime })),
    );

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    const [prompt, history, callbacks, options] = mockRunAgentLoop.mock.calls[0];

    // Prompt contains dream structure
    expect(prompt).toContain('DREAM consolidation');

    // History should be empty
    expect(history).toEqual([]);

    // Verify configuration
    expect(options).toBeDefined();
    const opts = options as Record<string, unknown>;
    expect(opts.source).toBe('dream-consolidation');
    expect(opts.maxToolRounds).toBe(30);

    // filesTools should be passed as the tool set
    const { filesTools } = await import('../../src/agent/tools/files-tools.js');
    expect(opts.tools).toBe(filesTools);

    // Model config
    const modelConfig = opts.modelConfig as Record<string, unknown>;
    expect(modelConfig).toBeDefined();
    expect(modelConfig.maxTokens).toBe(16000);
  });
});

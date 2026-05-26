import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock the agent loop and files-tools to prevent real LLM calls
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
  WORKING_MEMORY_FILE,
  DAILY_DIR,
} from '../../src/constants.js';
import {
  shouldDream,
  ensureDreamDirectories,
  ensureMemoryIndex,
  executeDream,
} from '../../src/core/dream.js';
import {
  createSessionRecord,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb } from '../../src/core/session-db.js';

/**
 * Suite 6 (Test Plan Suite 7): Dream (Unit with Filesystem)
 */

const DREAM_STATE_FILE = path.join(MEMORY_DIR, '.dream-state.json');
const DREAM_LOCK_FILE = path.join(MEMORY_DIR, '.dream-lock');

/**
 * Seed N session rows in SQLite with a specific startedAt. Uses the
 * session-tracker public API + updateSessionRecord to override startedAt, which
 * is not an input to createSessionRecord.
 */
async function seedSessions(count: number, startedAt: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    const sid = `dream-seed-${Date.now()}-${i}`;
    await createSessionRecord(sid, `task-${i}`, 'proj');
    await updateSessionRecord(sid, { startedAt } as any);
  }
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  // Ensure MEMORY_DIR exists for dream state files
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
  // Clean up any lock files
  try { await fsp.unlink(DREAM_LOCK_FILE); } catch { /* ok */ }
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  // Clean up lock files before removing tmpDir
  try { await fsp.unlink(DREAM_LOCK_FILE); } catch { /* ok */ }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('shouldDream', () => {
  it('7.1: returns false when < 24h since last dream', async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: oneHourAgo.toISOString(),
    }), 'utf-8');

    expect(await shouldDream()).toBe(false);
  });

  it('7.2: returns false when < 5 sessions since last dream', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: twoDaysAgo.toISOString(),
    }), 'utf-8');

    // Only 3 sessions after dream time
    const afterDream = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await seedSessions(3, afterDream);

    expect(await shouldDream()).toBe(false);
  });

  it('7.3: returns true when both conditions met', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: twoDaysAgo.toISOString(),
    }), 'utf-8');

    // 6 sessions after dream time
    const afterDream = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, afterDream);

    expect(await shouldDream()).toBe(true);
  });

  it('7.4: returns true when no prior dream state', async () => {
    // No .dream-state.json file — lastDreamTime = 0
    // Write 5+ sessions
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, recentTime);

    expect(await shouldDream()).toBe(true);
  });
});

describe('acquireDreamLock (via executeDream integration)', () => {
  it('7.5: exclusive lock creation (wx flag)', async () => {
    // We test lock behavior indirectly: create a lock file manually,
    // then executeDream should skip since lock is held by a valid PID.
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: twoDaysAgo.toISOString(),
    }), 'utf-8');
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, recentTime);

    // Create a lock file with current process PID (active lock)
    fs.writeFileSync(DREAM_LOCK_FILE, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }), { encoding: 'utf-8', flag: 'wx' });

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();

    await executeDream();

    // Lock was held — runAgentLoop should NOT have been called
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it('7.6: stale lock detection (old lock with dead PID)', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: twoDaysAgo.toISOString(),
    }), 'utf-8');
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, recentTime);

    // Create a stale lock: 90 minutes old with a non-existent PID
    const staleTime = new Date(Date.now() - 90 * 60 * 1000);
    fs.writeFileSync(DREAM_LOCK_FILE, JSON.stringify({
      pid: 99999999,
      startedAt: staleTime.toISOString(),
    }), 'utf-8');
    // Set mtime to 90 min ago
    const staleMs = staleTime.getTime();
    fs.utimesSync(DREAM_LOCK_FILE, staleMs / 1000, staleMs / 1000);

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();

    await executeDream();

    // Stale lock was replaced — dream should have run
    expect(mockRunAgentLoop).toHaveBeenCalled();
  });
});

describe('ensureDreamDirectories', () => {
  it('7.7: creates topics/ + compaction/ + index.md', () => {
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
});

describe('ensureMemoryIndex', () => {
  it('7.8: is idempotent', () => {
    const customContent = '# Memory Index\n\n## Topics\n- [Walnut](topics/walnut.md)';
    fs.mkdirSync(path.dirname(MEMORY_INDEX_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_INDEX_FILE, customContent, 'utf-8');

    ensureMemoryIndex();

    const content = fs.readFileSync(MEMORY_INDEX_FILE, 'utf-8');
    expect(content).toBe(customContent);
  });
});

describe('executeDream', () => {
  it('7.9: calls runAgentLoop with correct parameters', async () => {
    // Set up conditions for dream to run
    // No dream state -> lastDreamTime = 0 -> hours since = huge
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, recentTime);

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    expect(mockRunAgentLoop).toHaveBeenCalledOnce();

    // Inspect the call arguments
    const [prompt, history, callbacks, options] = mockRunAgentLoop.mock.calls[0];
    // Prompt should contain dream phases
    expect(prompt).toContain('DREAM consolidation');
    expect(prompt).toContain('Phase 1');
    expect(prompt).toContain('Phase 2');
    expect(prompt).toContain('Phase 3');
    expect(prompt).toContain('Phase 4');
    // History should be empty array
    expect(history).toEqual([]);
    // Options should include source and maxToolRounds
    expect(options).toBeDefined();
    expect((options as Record<string, unknown>).source).toBe('dream-consolidation');
    expect((options as Record<string, unknown>).maxToolRounds).toBe(30);

    // Dream state file should be updated
    expect(fs.existsSync(DREAM_STATE_FILE)).toBe(true);
    const state = JSON.parse(fs.readFileSync(DREAM_STATE_FILE, 'utf-8'));
    expect(state.lastDreamAt).toBeDefined();

    // Lock file should be cleaned up
    expect(fs.existsSync(DREAM_LOCK_FILE)).toBe(false);
  });

  it('7.10: dream prompt references correct directories', async () => {
    // No dream state -> dream should run
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await seedSessions(6, recentTime);

    const { runAgentLoop } = await import('../../src/agent/loop.js');
    const mockRunAgentLoop = vi.mocked(runAgentLoop);
    mockRunAgentLoop.mockClear();
    mockRunAgentLoop.mockResolvedValue(undefined as never);

    await executeDream();

    const prompt = mockRunAgentLoop.mock.calls[0][0] as string;
    expect(prompt).toContain(MEMORY_INDEX_FILE);
    expect(prompt).toContain(TOPICS_DIR);
    expect(prompt).toContain(DAILY_DIR);
    expect(prompt).toContain(WORKING_MEMORY_FILE);
    expect(prompt).toContain(COMPACTION_DIR);
    // All 4 phase headers
    expect(prompt).toContain('## Phase 1');
    expect(prompt).toContain('## Phase 2');
    expect(prompt).toContain('## Phase 3');
    expect(prompt).toContain('## Phase 4');
  });
});

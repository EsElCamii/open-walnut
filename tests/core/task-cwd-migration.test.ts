/**
 * Integration test: updateTask({ cwd }) triggers JSONL migration + SessionRecord.cwd sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-cwd-migration'));

import { addTask, updateTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { canonicalJsonlPath } from '../../src/core/session-file-reader.js';
import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js';

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Helper that polls until a condition is true or a timeout fires —
// updateTask migrates in a fire-and-forget async block so we can't rely on
// the Promise from updateTask resolving after migration.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(path.join(CLAUDE_HOME, 'projects'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('updateTask cwd change', () => {
  it('migrates the session JSONL and syncs SessionRecord.cwd', async () => {
    const oldCwd = '/tmp/walnut-task-cwd/foo';
    const newCwd = '/tmp/walnut-task-cwd/bar';
    const sid = 'test-sid-11111111';

    const { task } = await addTask({ title: 'T', cwd: oldCwd });

    // Register a session record and drop a JSONL on disk under the old cwd.
    await createSessionRecord(sid, task.id, task.project ?? 'personal', oldCwd);
    const oldJsonl = canonicalJsonlPath(sid, oldCwd);
    const newJsonl = canonicalJsonlPath(sid, newCwd);
    await fsp.mkdir(path.dirname(oldJsonl), { recursive: true });
    await fsp.writeFile(oldJsonl, '{"type":"user"}\n');

    await updateTask(task.id, { cwd: newCwd });

    // Migration runs fire-and-forget after updateTask returns.
    await waitFor(async () => await exists(newJsonl));

    expect(await exists(newJsonl)).toBe(true);
    expect(await exists(oldJsonl)).toBe(false);

    // SessionRecord.cwd should eventually reflect the new path.
    await waitFor(async () => {
      const rec = await getSessionByClaudeId(sid);
      return rec?.cwd === newCwd;
    });
    const rec = await getSessionByClaudeId(sid);
    expect(rec?.cwd).toBe(newCwd);
  });

  it('clears the cwd_missing flag when cwd is updated to a new value', async () => {
    const oldCwd = '/tmp/walnut-task-cwd/src';
    const newCwd = '/tmp/walnut-task-cwd/dst';
    const { task } = await addTask({ title: 'T', cwd: oldCwd });

    await updateTask(task.id, { cwd_missing: true });
    await updateTask(task.id, { cwd: newCwd });

    // Re-read by updating with a no-op — grab latest
    const { listTasks } = await import('../../src/core/task-manager.js');
    const all = await listTasks();
    const fresh = all.find(t => t.id === task.id)!;
    expect(fresh.cwd).toBe(newCwd);
    expect(fresh.cwd_missing).toBeUndefined();
  });

  it('skips migration when SessionRecord.host is set (remote session)', async () => {
    const oldCwd = '/tmp/walnut-task-cwd/rem-old';
    const newCwd = '/tmp/walnut-task-cwd/rem-new';
    const sid = 'remote-sid-22222222';

    const { task } = await addTask({ title: 'T', cwd: oldCwd });
    await createSessionRecord(sid, task.id, task.project ?? 'personal', oldCwd, { host: 'clouddev' });

    const oldJsonl = canonicalJsonlPath(sid, oldCwd);
    await fsp.mkdir(path.dirname(oldJsonl), { recursive: true });
    await fsp.writeFile(oldJsonl, '{"type":"user"}\n');

    await updateTask(task.id, { cwd: newCwd });

    // Give fire-and-forget a chance to run (or not, in this case)
    await new Promise(r => setTimeout(r, 200));

    // For remote sessions the local JSONL (a test artifact) should NOT be moved —
    // the real one lives on the remote host and we don't touch it.
    expect(await exists(oldJsonl)).toBe(true);
  });
});

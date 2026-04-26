import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-jsonl-migration'));

import { CLAUDE_HOME } from '../../src/constants.js';
import { canonicalJsonlPath, subagentDirPath } from '../../src/core/session-file-reader.js';
import { migrateSessionJsonlForCwd } from '../../src/core/session-jsonl-migration.js';

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

beforeEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(path.join(CLAUDE_HOME, 'projects'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('migrateSessionJsonlForCwd', () => {
  const SID = 'abc123';

  it('moves a JSONL from the old cwd-encoded dir to the new one', async () => {
    const oldCwd = '/tmp/walnut-cwd-test/foo';
    const newCwd = '/tmp/walnut-cwd-test/bar';
    const oldPath = canonicalJsonlPath(SID, oldCwd);
    const newPath = canonicalJsonlPath(SID, newCwd);

    await fsp.mkdir(path.dirname(oldPath), { recursive: true });
    await fsp.writeFile(oldPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

    const result = await migrateSessionJsonlForCwd(SID, oldCwd, newCwd);

    expect(result.migrated).toBe(true);
    expect(await exists(oldPath)).toBe(false);
    expect(await exists(newPath)).toBe(true);
    const contents = await fsp.readFile(newPath, 'utf8');
    expect(contents).toContain('"role":"user"');
  });

  it('is a no-op when source JSONL is missing', async () => {
    const result = await migrateSessionJsonlForCwd(SID, '/tmp/a', '/tmp/b');
    expect(result.migrated).toBe(false);
  });

  it('is a no-op when old === new cwd', async () => {
    const result = await migrateSessionJsonlForCwd(SID, '/tmp/same', '/tmp/same');
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('unchanged');
  });

  it('skips migration when either cwd encodes to >200 chars', async () => {
    const longCwd = '/tmp/' + 'a'.repeat(220);
    const result = await migrateSessionJsonlForCwd(SID, longCwd, '/tmp/short');
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('cwd-too-long');
  });

  it('also moves the subagent directory if present', async () => {
    const oldCwd = '/tmp/walnut-cwd-test/withsubs';
    const newCwd = '/tmp/walnut-cwd-test/withsubs-renamed';
    const oldJsonl = canonicalJsonlPath(SID, oldCwd);
    const newJsonl = canonicalJsonlPath(SID, newCwd);
    const oldSubs = subagentDirPath(SID, oldCwd);
    const newSubs = subagentDirPath(SID, newCwd);

    await fsp.mkdir(path.dirname(oldJsonl), { recursive: true });
    await fsp.writeFile(oldJsonl, 'x\n');
    await fsp.mkdir(oldSubs, { recursive: true });
    await fsp.writeFile(path.join(oldSubs, 'sub1.jsonl'), 'sub\n');

    await migrateSessionJsonlForCwd(SID, oldCwd, newCwd);

    expect(await exists(newJsonl)).toBe(true);
    expect(await exists(newSubs)).toBe(true);
    expect(await exists(path.join(newSubs, 'sub1.jsonl'))).toBe(true);
    expect(await exists(oldSubs)).toBe(false);
  });

  it('does not overwrite an existing JSONL at the destination', async () => {
    const oldCwd = '/tmp/walnut-cwd-test/src';
    const newCwd = '/tmp/walnut-cwd-test/dst';
    const oldPath = canonicalJsonlPath(SID, oldCwd);
    const newPath = canonicalJsonlPath(SID, newCwd);

    await fsp.mkdir(path.dirname(oldPath), { recursive: true });
    await fsp.writeFile(oldPath, 'old\n');
    await fsp.mkdir(path.dirname(newPath), { recursive: true });
    await fsp.writeFile(newPath, 'existing\n');

    const result = await migrateSessionJsonlForCwd(SID, oldCwd, newCwd);

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('dest-exists');
    const preserved = await fsp.readFile(newPath, 'utf8');
    expect(preserved).toBe('existing\n');
    // source still present — caller can inspect/handle
    expect(await exists(oldPath)).toBe(true);
  });
});

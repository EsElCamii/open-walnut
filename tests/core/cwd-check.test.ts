import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkCwdExists } from '../../src/providers/cwd-check.js';

describe('checkCwdExists (local)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cwd-check-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns ok=true for an existing directory', async () => {
    const result = await checkCwdExists(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok=false with error for a missing directory', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = await checkCwdExists(missing);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(missing);
    expect(result.error).toMatch(/no longer exists|not set|not available/i);
  });

  it('returns ok=false when cwd is empty string', async () => {
    const result = await checkCwdExists('');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('detects a directory deleted after creation', async () => {
    const sub = path.join(tmpDir, 'will-be-deleted');
    await fsp.mkdir(sub);
    const before = await checkCwdExists(sub);
    expect(before.ok).toBe(true);

    await fsp.rm(sub, { recursive: true, force: true });

    const after = await checkCwdExists(sub);
    expect(after.ok).toBe(false);
    expect(after.error).toContain(sub);
  });
});

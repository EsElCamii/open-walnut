import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { filesRouter } from '../../../src/web/routes/files.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/files', filesRouter);
  app.use(errorHandler);
  return app;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-files-test-'));
  await fs.mkdir(path.join(tmpDir, 'src'));
  await fs.mkdir(path.join(tmpDir, 'docs'));
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Hello\n');
  await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(tmpDir, '.hidden'), 'secret\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/files/list (local)', () => {
  it('lists one level with dirs before files, alphabetically', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(tmpDir);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    // dirs first (docs, src), then files case-insensitively (index.ts before README.md);
    // .hidden excluded
    expect(names).toEqual(['docs', 'src', 'index.ts', 'README.md']);
  });

  it('tags entry types correctly and includes file sizes', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    const byName = Object.fromEntries(
      res.body.entries.map((e: { name: string; type: string; size?: number }) => [e.name, e]),
    );
    expect(byName['src'].type).toBe('dir');
    expect(byName['README.md'].type).toBe('file');
    expect(byName['README.md'].size).toBeGreaterThan(0);
  });

  it('hides dotfiles by default but reveals them with showHidden=1', async () => {
    const hidden = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    expect(hidden.body.entries.some((e: { name: string }) => e.name === '.hidden')).toBe(false);

    const shown = await request(createApp())
      .get('/api/files/list')
      .query({ path: tmpDir, showHidden: '1' });
    expect(shown.body.entries.some((e: { name: string }) => e.name === '.hidden')).toBe(true);
  });

  it('rejects directory traversal', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: `${tmpDir}/../etc` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid path');
  });

  it('rejects shell metacharacters', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: `${tmpDir};rm -rf /` });
    expect(res.status).toBe(400);
  });

  it('rejects relative (non-absolute) local paths', async () => {
    const res = await request(createApp()).get('/api/files/list').query({ path: 'relative/dir' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Path must be absolute');
  });

  it('returns 400 for a missing path parameter', async () => {
    const res = await request(createApp()).get('/api/files/list');
    expect(res.status).toBe(400);
  });

  it('returns 400 when the directory does not exist', async () => {
    const res = await request(createApp())
      .get('/api/files/list')
      .query({ path: path.join(tmpDir, 'nope') });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot list directory');
  });

  it('classifies a symlink-to-directory as a dir (follows the link)', async () => {
    // readdir withFileTypes uses lstat → a symlinked dir looks like a file unless
    // we stat() it. Verify the route resolves it to type 'dir'.
    await fs.symlink(path.join(tmpDir, 'src'), path.join(tmpDir, 'src-link'), 'dir');
    const res = await request(createApp()).get('/api/files/list').query({ path: tmpDir });
    const link = res.body.entries.find((e: { name: string }) => e.name === 'src-link');
    expect(link).toBeDefined();
    expect(link.type).toBe('dir');
  });
});

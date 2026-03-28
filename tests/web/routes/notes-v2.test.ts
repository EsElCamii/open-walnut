import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-v2-test'));

import express from 'express';
import request from 'supertest';
import { notesV2Router } from '../../../src/web/routes/notes-v2.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/notes-v2', notesV2Router);
  app.use(errorHandler);
  return app;
}

/** Helper to write a note file directly on disk */
async function writeNote(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Helper to read a note file from disk */
async function readNote(relPath: string): Promise<string> {
  return fs.readFile(path.join(NOTES_DIR, relPath), 'utf-8');
}

/** Helper to check if a file exists */
async function fileExists(relPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(NOTES_DIR, relPath));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── GET / — File Tree ────────────────────────────────────────────────

describe('GET /api/notes-v2 (tree)', () => {
  it('returns empty tree when no notes exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    expect(res.body.tree).toEqual([]);
  });

  it('returns tree with files and folders', async () => {
    await writeNote('hello.md', '# Hello');
    await writeNote('sub/nested.md', '# Nested');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    const { tree } = res.body;
    expect(tree.length).toBe(2); // folder first, then file

    // Folder comes first (sorted: folders before files)
    const folder = tree.find((n: any) => n.type === 'folder');
    expect(folder).toBeDefined();
    expect(folder.name).toBe('sub');
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0].name).toBe('nested.md');

    const file = tree.find((n: any) => n.type === 'file');
    expect(file).toBeDefined();
    expect(file.name).toBe('hello.md');
    expect(file.path).toBe('hello.md');
  });

  it('skips hidden files and non-.md files', async () => {
    await writeNote('.hidden.md', 'hidden');
    await fs.writeFile(path.join(NOTES_DIR, 'readme.txt'), 'not markdown');
    await writeNote('visible.md', '# Visible');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2');

    expect(res.status).toBe(200);
    expect(res.body.tree).toHaveLength(1);
    expect(res.body.tree[0].name).toBe('visible.md');
  });
});

// ─── GET /content/*path — Read Note ──────────────────────────────────

describe('GET /api/notes-v2/content/*path', () => {
  it('reads an existing note', async () => {
    await writeNote('test-note.md', '# Test\n\nContent here.');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/test-note.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Test\n\nContent here.');
    expect(res.body.updatedAt).toBeDefined();
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('reads note in subfolder', async () => {
    await writeNote('projects/walnut.md', '# Walnut Notes');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/projects/walnut.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Walnut Notes');
  });

  it('auto-appends .md extension', async () => {
    await writeNote('auto-ext.md', 'works without extension');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/auto-ext');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('works without extension');
  });

  it('returns 404 for non-existent note', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/content/does-not-exist.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Note not found');
  });

  it('does not serve files outside notes dir via traversal', async () => {
    const app = createApp();
    // Express normalizes ../ in URLs, so this won't reach resolveSafePath as ../
    // but will result in a 404 rather than leaking files outside NOTES_DIR
    const res = await request(app).get('/api/notes-v2/content/../../../etc/passwd');
    expect([400, 404]).toContain(res.status);
  });
});

// ─── PUT /content/*path — Create/Update Note ─────────────────────────

describe('PUT /api/notes-v2/content/*path', () => {
  it('creates a new note', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/new-note.md')
      .send({ content: '# New Note\n\nFresh content.' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updatedAt).toBeDefined();

    const onDisk = await readNote('new-note.md');
    expect(onDisk).toBe('# New Note\n\nFresh content.');
  });

  it('creates parent folders automatically', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/deep/nested/note.md')
      .send({ content: 'nested' });

    expect(res.status).toBe(200);
    expect(await fileExists('deep/nested/note.md')).toBe(true);
  });

  it('updates an existing note', async () => {
    await writeNote('existing.md', 'old content');

    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/existing.md')
      .send({ content: 'updated content' });

    expect(res.status).toBe(200);
    expect(await readNote('existing.md')).toBe('updated content');
  });

  it('rejects missing content field', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/bad.md')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content');
  });

  it('rejects content exceeding 2MB', async () => {
    const app = createApp();
    const bigContent = 'x'.repeat(2_000_001);
    const res = await request(app)
      .put('/api/notes-v2/content/big.md')
      .send({ content: bigContent });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('too large');
  });

  it('does not write files outside notes dir via traversal', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/notes-v2/content/../../etc/evil.md')
      .send({ content: 'hacked' });

    // Express normalizes ../ — result is 404 or 400, never a successful write outside NOTES_DIR
    expect([400, 404]).toContain(res.status);
  });
});

// ─── DELETE /content/*path — Delete Note ──────────────────────────────

describe('DELETE /api/notes-v2/content/*path', () => {
  it('deletes an existing note', async () => {
    await writeNote('to-delete.md', 'goodbye');

    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/to-delete.md');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fileExists('to-delete.md')).toBe(false);
  });

  it('cleans up empty parent directories', async () => {
    await writeNote('cleanup/deep/only-child.md', 'content');

    const app = createApp();
    await request(app).delete('/api/notes-v2/content/cleanup/deep/only-child.md');

    // Both empty parent dirs should be removed
    expect(await fileExists('cleanup/deep')).toBe(false);
    expect(await fileExists('cleanup')).toBe(false);
  });

  it('returns 404 for non-existent note', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/ghost.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Note not found');
  });

  it('does not delete files outside notes dir via traversal', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/notes-v2/content/../../../etc/passwd');

    expect([400, 404]).toContain(res.status);
  });
});

// ─── POST /move — Rename/Move + Wiki Link Update ─────────────────────

describe('POST /api/notes-v2/move', () => {
  it('moves/renames a note', async () => {
    await writeNote('old-name.md', '# Old Name');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'old-name.md', to: 'new-name.md' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await fileExists('old-name.md')).toBe(false);
    expect(await fileExists('new-name.md')).toBe(true);
    expect(await readNote('new-name.md')).toBe('# Old Name');
  });

  it('moves note to a different folder', async () => {
    await writeNote('root-note.md', 'content');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'root-note.md', to: 'archive/root-note.md' });

    expect(res.status).toBe(200);
    expect(await fileExists('root-note.md')).toBe(false);
    expect(await readNote('archive/root-note.md')).toBe('content');
  });

  it('updates wiki links in other notes', async () => {
    await writeNote('target.md', '# Target');
    await writeNote('linker.md', 'See [[target]] for details.');
    await writeNote('labeled-linker.md', 'See [[target|my label]] for more.');

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'target.md', to: 'renamed-target.md' });

    expect(res.status).toBe(200);
    expect(await readNote('linker.md')).toBe('See [[renamed-target]] for details.');
    expect(await readNote('labeled-linker.md')).toBe('See [[renamed-target|my label]] for more.');
  });

  it('does not update links when basename stays the same', async () => {
    await writeNote('same-name.md', '# Content');
    await writeNote('ref.md', 'Link to [[same-name]].');

    const app = createApp();
    await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'same-name.md', to: 'subfolder/same-name.md' });

    // Link text should remain unchanged since basename didn't change
    expect(await readNote('ref.md')).toBe('Link to [[same-name]].');
  });

  it('returns 404 when source does not exist', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'nonexistent.md', to: 'dest.md' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Source note not found');
  });

  it('rejects missing from/to fields', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'only-from.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from and to');
  });

  it('rejects path traversal in from/to', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: '../../etc/passwd', to: 'safe.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });
});

// ─── GET /search?q= — Full-text Search ───────────────────────────────

describe('GET /api/notes-v2/search', () => {
  it('returns empty results for empty query', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=');

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns empty results for missing query', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search');

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('finds notes containing search term', async () => {
    await writeNote('recipe.md', '# Chocolate Cake\n\nMix flour, cocoa, and sugar.');
    await writeNote('todo.md', '# Tasks\n\nBuy groceries.');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=chocolate');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].name).toBe('recipe');
    expect(res.body.results[0].path).toBe('recipe.md');
    expect(res.body.results[0].snippet).toContain('Chocolate');
  });

  it('search is case-insensitive', async () => {
    await writeNote('upper.md', 'IMPORTANT: uppercase content');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=important');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('searches in subfolders', async () => {
    await writeNote('deep/nested/note.md', 'findable content');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/search?q=findable');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].path).toBe('deep/nested/note.md');
  });
});

// ─── GET /backlinks/*path — Reverse Link Search ──────────────────────

describe('GET /api/notes-v2/backlinks/*path', () => {
  it('finds notes that link to the target', async () => {
    await writeNote('target.md', '# Target Note');
    await writeNote('linker-a.md', 'Refers to [[target]] here.');
    await writeNote('linker-b.md', 'Also links: [[target|see this]].');
    await writeNote('unrelated.md', 'No links here.');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/target.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(2);

    const paths = res.body.backlinks.map((b: any) => b.path).sort();
    expect(paths).toEqual(['linker-a.md', 'linker-b.md']);
  });

  it('does not include self in backlinks', async () => {
    await writeNote('self-ref.md', 'I link to [[self-ref]] myself.');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/self-ref.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(0);
  });

  it('returns empty backlinks when no notes link to target', async () => {
    await writeNote('lonely.md', '# Lonely Note');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/lonely.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toEqual([]);
  });

  it('includes snippet showing the link context', async () => {
    await writeNote('target.md', '# Target');
    await writeNote('source.md', 'Before context [[target]] after context');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/backlinks/target.md');

    expect(res.status).toBe(200);
    expect(res.body.backlinks).toHaveLength(1);
    expect(res.body.backlinks[0].snippet).toContain('[[target]]');
  });
});

// ─── GET /list — Flat List of All Notes ───────────────────────────────

describe('GET /api/notes-v2/list', () => {
  it('returns empty list when no notes exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('returns flat list of all notes', async () => {
    await writeNote('root.md', '# Root');
    await writeNote('sub/nested.md', '# Nested');
    await writeNote('sub/deep/leaf.md', '# Leaf');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(3);

    const paths = res.body.notes.map((n: any) => n.path).sort();
    expect(paths).toEqual(['root.md', 'sub/deep/leaf.md', 'sub/nested.md']);

    // Check name field strips .md
    const root = res.body.notes.find((n: any) => n.path === 'root.md');
    expect(root.name).toBe('root');
  });

  it('skips hidden files', async () => {
    await writeNote('.hidden.md', 'hidden');
    await writeNote('visible.md', 'visible');

    const app = createApp();
    const res = await request(app).get('/api/notes-v2/list');

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].name).toBe('visible');
  });
});

// ─── POST /folder — Create Folder ────────────────────────────────────

describe('POST /api/notes-v2/folder', () => {
  it('creates a new folder', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: 'new-folder' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const stat = await fs.stat(path.join(NOTES_DIR, 'new-folder'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates nested folders recursively', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: 'a/b/c' });

    expect(res.status).toBe(200);
    const stat = await fs.stat(path.join(NOTES_DIR, 'a/b/c'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent for existing folders', async () => {
    await fs.mkdir(path.join(NOTES_DIR, 'existing'), { recursive: true });

    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: 'existing' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects missing path field', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('path');
  });

  it('rejects path traversal', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: '../../etc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });
});

// ─── Security: Path Traversal ────────────────────────────────────────

describe('path traversal protection', () => {
  // Express normalizes ../ in URLs before the route handler sees them,
  // so most traversal paths result in 404 (not found) rather than 400 (invalid path).
  // The key security property is: no file outside NOTES_DIR is ever served or written.
  const traversalPaths = [
    '../../../etc/passwd',
    '..\\..\\..\\etc\\passwd',
    'foo/../../etc/passwd',
  ];

  for (const maliciousPath of traversalPaths) {
    it(`does not serve files outside NOTES_DIR for: ${maliciousPath}`, async () => {
      const app = createApp();
      const res = await request(app).get(`/api/notes-v2/content/${maliciousPath}`);
      // Either rejected as invalid (400) or not found after normalization (404)
      expect([400, 404]).toContain(res.status);
      // Must never return actual file content from outside notes dir
      expect(res.body.content).toBeUndefined();
    });
  }

  it('resolveSafePath rejects move with traversal from', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: '../../etc/passwd', to: 'safe.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });

  it('resolveSafePath rejects move with traversal to', async () => {
    await writeNote('source.md', 'content');
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/move')
      .send({ from: 'source.md', to: '../../etc/evil.md' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });

  it('resolveSafePath rejects folder creation with traversal', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/notes-v2/folder')
      .send({ path: '../../etc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid path');
  });
});

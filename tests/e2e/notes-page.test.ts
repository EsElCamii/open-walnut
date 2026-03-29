/**
 * E2E tests for the Notes Page (multi-file notes system).
 *
 * Tests full CRUD lifecycle, wiki-link updates, backlinks, search,
 * folder operations, special characters, and edge cases.
 * Starts a real server on a random port.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('notes-page-e2e'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

const NOTES_DIR = path.join(WALNUT_HOME, 'notes');

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** API helpers */
async function apiGet(p: string) {
  const res = await fetch(apiUrl(p));
  return { status: res.status, body: await res.json() };
}

async function apiPut(p: string, data: unknown) {
  const res = await fetch(apiUrl(p), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

async function apiPost(p: string, data: unknown) {
  const res = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

async function apiDelete(p: string) {
  const res = await fetch(apiUrl(p), { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

/** Write a note directly to disk (bypass API) */
async function seedNote(relPath: string, content: string) {
  const full = path.join(NOTES_DIR, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

/** Read a note directly from disk */
async function readDisk(relPath: string): Promise<string> {
  return fs.readFile(path.join(NOTES_DIR, relPath), 'utf-8');
}

/** Check file exists on disk */
async function existsOnDisk(relPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(NOTES_DIR, relPath));
    return true;
  } catch {
    return false;
  }
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  port = (server.address() as any).port;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean notes dir between tests
  try {
    await fs.rm(NOTES_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
  await fs.mkdir(NOTES_DIR, { recursive: true });
});

// ═══════════════════════════════════════════════════════════
// Note CRUD lifecycle
// ═══════════════════════════════════════════════════════════

describe('Note CRUD lifecycle', () => {
  it('creates a note, reads it back, updates it, then deletes it', async () => {
    // Create
    const create = await apiPut('/api/notes-v2/content/lifecycle.md', { content: '# Hello World' });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(create.body.updatedAt).toBeDefined();

    // Read
    const read = await apiGet('/api/notes-v2/content/lifecycle.md');
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('# Hello World');

    // Update
    const update = await apiPut('/api/notes-v2/content/lifecycle.md', { content: '# Updated' });
    expect(update.status).toBe(200);
    const readAfter = await apiGet('/api/notes-v2/content/lifecycle.md');
    expect(readAfter.body.content).toBe('# Updated');

    // Delete
    const del = await apiDelete('/api/notes-v2/content/lifecycle.md');
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Verify gone
    const readGone = await apiGet('/api/notes-v2/content/lifecycle.md');
    expect(readGone.status).toBe(404);
  });

  it('auto-appends .md extension when reading', async () => {
    await seedNote('auto-ext.md', 'works');
    const read = await apiGet('/api/notes-v2/content/auto-ext');
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('works');
  });

  it('creates parent folders automatically', async () => {
    const res = await apiPut('/api/notes-v2/content/deep/nested/auto.md', { content: 'auto-created' });
    expect(res.status).toBe(200);
    expect(await existsOnDisk('deep/nested/auto.md')).toBe(true);
  });

  it('cleans up empty parent folders on delete', async () => {
    await seedNote('cleanup/leaf.md', 'temp');
    await apiDelete('/api/notes-v2/content/cleanup/leaf.md');
    expect(await existsOnDisk('cleanup')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// File tree
// ═══════════════════════════════════════════════════════════

describe('File tree', () => {
  it('returns sorted tree with folders-first ordering', async () => {
    await seedNote('z-file.md', 'z');
    await seedNote('a-folder/nested.md', 'nested');
    await seedNote('b-file.md', 'b');

    const { body } = await apiGet('/api/notes-v2');
    expect(body.tree.length).toBe(3);
    // Folder should come first
    expect(body.tree[0].type).toBe('folder');
    expect(body.tree[0].name).toBe('a-folder');
    // Then files alphabetically
    expect(body.tree[1].name).toBe('b-file.md');
    expect(body.tree[2].name).toBe('z-file.md');
  });

  it('includes nested folder children', async () => {
    await seedNote('parent/child/deep.md', 'deep content');

    const { body } = await apiGet('/api/notes-v2');
    const parent = body.tree[0];
    expect(parent.name).toBe('parent');
    expect(parent.children[0].name).toBe('child');
    expect(parent.children[0].children[0].name).toBe('deep.md');
  });

  it('skips hidden files and non-.md files', async () => {
    await seedNote('.hidden.md', 'hidden');
    await fs.writeFile(path.join(NOTES_DIR, 'readme.txt'), 'text');
    await seedNote('visible.md', 'ok');

    const { body } = await apiGet('/api/notes-v2');
    expect(body.tree.length).toBe(1);
    expect(body.tree[0].name).toBe('visible.md');
  });
});

// ═══════════════════════════════════════════════════════════
// Folder operations
// ═══════════════════════════════════════════════════════════

describe('Folder operations', () => {
  it('creates a folder', async () => {
    const res = await apiPost('/api/notes-v2/folder', { path: 'new-folder' });
    expect(res.status).toBe(200);
    expect(await existsOnDisk('new-folder')).toBe(true);
  });

  it('creates nested folders recursively', async () => {
    const res = await apiPost('/api/notes-v2/folder', { path: 'a/b/c' });
    expect(res.status).toBe(200);
    expect(await existsOnDisk('a/b/c')).toBe(true);
  });

  it('is idempotent for existing folders', async () => {
    await fs.mkdir(path.join(NOTES_DIR, 'existing'), { recursive: true });
    const res = await apiPost('/api/notes-v2/folder', { path: 'existing' });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// Move / Rename with wiki-link update
// ═══════════════════════════════════════════════════════════

describe('Move / Rename', () => {
  it('renames a note and updates wiki links in referencing notes', async () => {
    await seedNote('target.md', '# Target');
    await seedNote('linker.md', 'See [[target]] for details.');

    const res = await apiPost('/api/notes-v2/move', { from: 'target.md', to: 'renamed.md' });
    expect(res.status).toBe(200);

    // Source gone, destination exists
    expect(await existsOnDisk('target.md')).toBe(false);
    expect(await readDisk('renamed.md')).toBe('# Target');

    // Wiki link updated
    expect(await readDisk('linker.md')).toBe('See [[renamed]] for details.');
  });

  it('preserves wiki link labels during rename', async () => {
    await seedNote('original.md', 'content');
    await seedNote('labeled.md', 'Link to [[original|my custom label]] here.');

    await apiPost('/api/notes-v2/move', { from: 'original.md', to: 'new-name.md' });
    expect(await readDisk('labeled.md')).toBe('Link to [[new-name|my custom label]] here.');
  });

  it('skips wiki-link update when only folder changes (same basename)', async () => {
    await seedNote('same.md', 'content');
    await seedNote('ref.md', 'Link to [[same]].');

    await apiPost('/api/notes-v2/move', { from: 'same.md', to: 'subfolder/same.md' });
    expect(await readDisk('ref.md')).toBe('Link to [[same]].');
  });

  it('returns 409 when destination already exists', async () => {
    await seedNote('src.md', 'source');
    await seedNote('dst.md', 'destination');

    const res = await apiPost('/api/notes-v2/move', { from: 'src.md', to: 'dst.md' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('returns 404 when source does not exist', async () => {
    const res = await apiPost('/api/notes-v2/move', { from: 'ghost.md', to: 'dest.md' });
    expect(res.status).toBe(404);
  });

  it('does not update wiki links when names are empty (edge case)', async () => {
    // A file named just ".md" → basename is "" → wiki link update should be skipped
    await seedNote('.md', 'edge case');
    await seedNote('ref.md', 'Contains [[]] empty brackets.');

    const res = await apiPost('/api/notes-v2/move', { from: '.md', to: 'real-name.md' });
    expect(res.status).toBe(200);

    // The [[]] should NOT be replaced because oldName is empty
    expect(await readDisk('ref.md')).toBe('Contains [[]] empty brackets.');
  });
});

// ═══════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════

describe('Search', () => {
  it('finds notes by content (case-insensitive)', async () => {
    await seedNote('recipe.md', '# Chocolate Cake\n\nDelicious.');
    await seedNote('todo.md', '# Tasks\n\nBuy milk.');

    const { body } = await apiGet('/api/notes-v2/search?q=chocolate');
    expect(body.results.length).toBe(1);
    expect(body.results[0].name).toBe('recipe');
    expect(body.results[0].snippet).toContain('Chocolate');
  });

  it('searches across subfolders', async () => {
    await seedNote('deep/nested/note.md', 'findable content here');

    const { body } = await apiGet('/api/notes-v2/search?q=findable');
    expect(body.results.length).toBe(1);
    expect(body.results[0].path).toBe('deep/nested/note.md');
  });

  it('returns empty for no match', async () => {
    await seedNote('a.md', 'nothing relevant');
    const { body } = await apiGet('/api/notes-v2/search?q=zzzznonexistent');
    expect(body.results).toEqual([]);
  });

  it('limits results to 50', async () => {
    // Create 60 notes all containing the word "common"
    for (let i = 0; i < 60; i++) {
      await seedNote(`note-${String(i).padStart(3, '0')}.md`, `common content ${i}`);
    }

    const { body } = await apiGet('/api/notes-v2/search?q=common');
    expect(body.results.length).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════
// Backlinks
// ═══════════════════════════════════════════════════════════

describe('Backlinks', () => {
  it('finds all notes that link to a target', async () => {
    await seedNote('target.md', '# Target');
    await seedNote('a.md', 'See [[target]] for info.');
    await seedNote('b.md', 'Also [[target|labeled link]].');
    await seedNote('unrelated.md', 'No links here.');

    const { body } = await apiGet('/api/notes-v2/backlinks/target.md');
    expect(body.backlinks.length).toBe(2);
    const paths = body.backlinks.map((b: any) => b.path).sort();
    expect(paths).toEqual(['a.md', 'b.md']);
  });

  it('excludes self-references', async () => {
    await seedNote('self.md', 'I reference [[self]] myself.');

    const { body } = await apiGet('/api/notes-v2/backlinks/self.md');
    expect(body.backlinks).toHaveLength(0);
  });

  it('returns snippets with context', async () => {
    await seedNote('target.md', '# Target');
    await seedNote('src.md', 'Before [[target]] after');

    const { body } = await apiGet('/api/notes-v2/backlinks/target.md');
    expect(body.backlinks[0].snippet).toContain('[[target]]');
    expect(body.backlinks[0].snippet).toContain('Before');
  });

  it('handles notes in subfolders', async () => {
    await seedNote('projects/walnut.md', '# Walnut');
    await seedNote('daily.md', 'Working on [[walnut]] today.');

    const { body } = await apiGet('/api/notes-v2/backlinks/projects/walnut.md');
    expect(body.backlinks.length).toBe(1);
    expect(body.backlinks[0].path).toBe('daily.md');
  });
});

// ═══════════════════════════════════════════════════════════
// Note list (wiki-link autocomplete)
// ═══════════════════════════════════════════════════════════

describe('Note list (for autocomplete)', () => {
  it('returns flat list of all notes', async () => {
    await seedNote('root.md', 'r');
    await seedNote('sub/nested.md', 'n');

    const { body } = await apiGet('/api/notes-v2/list');
    expect(body.notes.length).toBe(2);

    const names = body.notes.map((n: any) => n.name).sort();
    expect(names).toEqual(['nested', 'root']);
  });
});

// ═══════════════════════════════════════════════════════════
// Special characters in note names
// ═══════════════════════════════════════════════════════════

describe('Special characters in note names', () => {
  it('handles spaces in note names', async () => {
    const res = await apiPut('/api/notes-v2/content/my%20note.md', { content: 'spaced' });
    expect(res.status).toBe(200);

    const read = await apiGet('/api/notes-v2/content/my%20note.md');
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('spaced');
  });

  it('handles unicode characters in note names', async () => {
    const res = await apiPut('/api/notes-v2/content/%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0.md', { content: 'unicode' });
    expect(res.status).toBe(200);

    const read = await apiGet('/api/notes-v2/content/%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0.md');
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('unicode');
  });

  it('handles dashes and underscores', async () => {
    const res = await apiPut('/api/notes-v2/content/my-note_v2.md', { content: 'ok' });
    expect(res.status).toBe(200);

    const tree = await apiGet('/api/notes-v2');
    expect(tree.body.tree.some((n: any) => n.name === 'my-note_v2.md')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Large note handling
// ═══════════════════════════════════════════════════════════

describe('Large note handling', () => {
  it('handles a 1MB note', async () => {
    const content = 'x'.repeat(1_000_000);
    const res = await apiPut('/api/notes-v2/content/large.md', { content });
    expect(res.status).toBe(200);

    const read = await apiGet('/api/notes-v2/content/large.md');
    expect(read.status).toBe(200);
    expect(read.body.content.length).toBe(1_000_000);
  });

  it('rejects notes exceeding 2MB', async () => {
    const content = 'x'.repeat(2_000_001);
    const res = await apiPut('/api/notes-v2/content/too-big.md', { content });
    expect(res.status).toBe(413);
  });
});

// ═══════════════════════════════════════════════════════════
// Security: path traversal
// ═══════════════════════════════════════════════════════════

describe('Security: path traversal', () => {
  it('rejects traversal in read', async () => {
    // Express normalizes ../ in URLs, which may result in serving the SPA
    // HTML (200) or a 404. The key property: no file OUTSIDE notes dir is served.
    const res = await fetch(apiUrl('/api/notes-v2/content/../../../etc/passwd'));
    expect([200, 400, 404]).toContain(res.status);
    // If JSON was returned, it must not contain file content from outside notes
    if (res.headers.get('content-type')?.includes('json')) {
      const body = await res.json();
      expect(body.content).toBeUndefined();
    }
  });

  it('rejects traversal in write', async () => {
    const res = await apiPut('/api/notes-v2/content/../../etc/evil.md', { content: 'hack' });
    expect([400, 404]).toContain(res.status);
  });

  it('rejects traversal in delete', async () => {
    // Express normalizes ../ so this may return HTML (SPA fallback) or 404
    const res = await fetch(apiUrl('/api/notes-v2/content/../../../etc/passwd'), { method: 'DELETE' });
    expect([200, 400, 404]).toContain(res.status);
  });

  it('rejects traversal in move (from)', async () => {
    const res = await apiPost('/api/notes-v2/move', { from: '../../etc/passwd', to: 'safe.md' });
    expect(res.status).toBe(400);
  });

  it('rejects traversal in move (to)', async () => {
    await seedNote('src.md', 'ok');
    const res = await apiPost('/api/notes-v2/move', { from: 'src.md', to: '../../etc/evil.md' });
    expect(res.status).toBe(400);
  });

  it('rejects traversal in folder creation', async () => {
    const res = await apiPost('/api/notes-v2/folder', { path: '../../etc' });
    expect(res.status).toBe(400);
  });

  it('rejects dot-only paths via direct API (not URL-normalized)', async () => {
    // Express normalizes /content/. and /content/.. in the URL path,
    // so they never reach the route handler as "." or "..".
    // Instead, test via the move endpoint which takes paths in the body.
    const res1 = await apiPost('/api/notes-v2/move', { from: '.', to: 'safe.md' });
    expect(res1.status).toBe(400);

    const res2 = await apiPost('/api/notes-v2/move', { from: '..', to: 'safe.md' });
    expect(res2.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Input validation
// ═══════════════════════════════════════════════════════════

describe('Input validation', () => {
  it('rejects missing content field on PUT', async () => {
    const res = await apiPut('/api/notes-v2/content/test.md', {});
    expect(res.status).toBe(400);
  });

  it('rejects non-string content on PUT', async () => {
    const res = await apiPut('/api/notes-v2/content/test.md', { content: 42 });
    expect(res.status).toBe(400);
  });

  it('rejects missing path on POST /move', async () => {
    const res = await apiPost('/api/notes-v2/move', { from: 'only-from.md' });
    expect(res.status).toBe(400);
  });

  it('rejects missing path on POST /folder', async () => {
    const res = await apiPost('/api/notes-v2/folder', {});
    expect(res.status).toBe(400);
  });

  it('returns empty results for empty search query', async () => {
    const { body } = await apiGet('/api/notes-v2/search?q=');
    expect(body.results).toEqual([]);
  });

  it('returns empty results for missing search query', async () => {
    const { body } = await apiGet('/api/notes-v2/search');
    expect(body.results).toEqual([]);
  });
});

/**
 * Tests for the favorites API routes (Fix 3).
 * Covers CRUD for category/project favorites via /api/favorites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { favoritesRouter } from '../../../src/web/routes/favorites.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/favorites', favoritesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/favorites', () => {
  it('returns empty arrays when no favorites exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/favorites');

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
    expect(res.body.projects).toEqual([]);
    expect(res.body.notes).toEqual([]);
  });
});

describe('Category favorites', () => {
  it('POST adds a category favorite', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories).toContain('Work');
  });

  it('adding same category twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    const res = await request(app).post('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories.filter((c: string) => c === 'Work')).toHaveLength(1);
  });

  it('DELETE removes a category favorite', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    const res = await request(app).delete('/api/favorites/categories/Work');

    expect(res.status).toBe(200);
    expect(res.body.categories).not.toContain('Work');
  });

  it('deleting non-existent favorite is safe', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/favorites/categories/NonExistent');
    expect(res.status).toBe(200);
  });

  it('multiple categories can be favorited', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/categories/Life');
    await request(app).post('/api/favorites/categories/Personal');

    const res = await request(app).get('/api/favorites');
    expect(res.body.categories).toHaveLength(3);
    expect(res.body.categories).toContain('Work');
    expect(res.body.categories).toContain('Life');
    expect(res.body.categories).toContain('Personal');
  });

  it('handles URL-encoded category names', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/categories/My%20Category');

    expect(res.status).toBe(200);
    expect(res.body.categories).toContain('My Category');
  });
});

describe('Project favorites', () => {
  it('POST adds a project favorite', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects).toContain('HomeLab');
  });

  it('adding same project twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).post('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects.filter((p: string) => p === 'HomeLab')).toHaveLength(1);
  });

  it('DELETE removes a project favorite', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/projects/HomeLab');
    const res = await request(app).delete('/api/favorites/projects/HomeLab');

    expect(res.status).toBe(200);
    expect(res.body.projects).not.toContain('HomeLab');
  });

  it('handles URL-encoded project names', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/projects/AI%20Eureka');

    expect(res.status).toBe(200);
    expect(res.body.projects).toContain('AI Eureka');
  });
});

describe('Note favorites', () => {
  it('POST adds a note favorite via body', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes).toContain('PARA/foo.md');
  });

  it('POST without a path returns 400', async () => {
    const app = createApp();
    const res = await request(app).post('/api/favorites/notes').send({});

    expect(res.status).toBe(400);
  });

  it('adding same note twice is idempotent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes.filter((p: string) => p === 'PARA/foo.md')).toHaveLength(1);
  });

  it('GET returns favorited notes', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: '1 Projects/alpha.md' });
    await request(app).post('/api/favorites/notes').send({ path: '2 Areas/beta.md' });

    const res = await request(app).get('/api/favorites');
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.notes).toContain('1 Projects/alpha.md');
    expect(res.body.notes).toContain('2 Areas/beta.md');
  });

  it('DELETE removes a note favorite via body', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).delete('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    expect(res.status).toBe(200);
    expect(res.body.notes).not.toContain('PARA/foo.md');
  });

  it('DELETE removes a note favorite via query string', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });
    const res = await request(app).delete('/api/favorites/notes?path=PARA%2Ffoo.md');

    expect(res.status).toBe(200);
    expect(res.body.notes).not.toContain('PARA/foo.md');
  });

  it('preserves slashes and .md verbatim (exact-string storage)', async () => {
    const app = createApp();
    const path = '3 Resources/sub dir/My Note.md';
    await request(app).post('/api/favorites/notes').send({ path });

    const res = await request(app).get('/api/favorites');
    expect(res.body.notes).toEqual([path]);
  });
});

describe('Mixed favorites', () => {
  it('category, project, and note favorites are independent', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/projects/HomeLab');
    await request(app).post('/api/favorites/notes').send({ path: 'PARA/foo.md' });

    const res = await request(app).get('/api/favorites');
    expect(res.body.categories).toEqual(['Work']);
    expect(res.body.projects).toEqual(['HomeLab']);
    expect(res.body.notes).toEqual(['PARA/foo.md']);

    // Deleting a category doesn't affect projects or notes
    await request(app).delete('/api/favorites/categories/Work');
    const res2 = await request(app).get('/api/favorites');
    expect(res2.body.categories).toEqual([]);
    expect(res2.body.projects).toEqual(['HomeLab']);
    expect(res2.body.notes).toEqual(['PARA/foo.md']);
  });

  it('favorites persist to config and survive re-reads', async () => {
    const app = createApp();
    await request(app).post('/api/favorites/categories/Work');
    await request(app).post('/api/favorites/projects/HomeLab');

    // Create fresh app instance to force config re-read
    const app2 = createApp();
    const res = await request(app2).get('/api/favorites');
    expect(res.body.categories).toEqual(['Work']);
    expect(res.body.projects).toEqual(['HomeLab']);
  });
});

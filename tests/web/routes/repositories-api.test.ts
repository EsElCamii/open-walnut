/**
 * REST API tests for the repositories router.
 *
 * Tests the full CRUD lifecycle: GET list, POST create, GET single,
 * DELETE, and validation (slug format, size limit, 404 on missing).
 *
 * Uses supertest with an isolated Express app (no full server startup needed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('repos-api-test'));

import express from 'express';
import request from 'supertest';
import { repositoriesRouter } from '../../../src/web/routes/repositories.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { WALNUT_HOME, REPOSITORIES_DIR } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/repositories', repositoriesRouter);
  app.use(errorHandler);
  return app;
}

const sampleYaml = [
  'name: Test Repo',
  'description: A sample repository for testing',
  'tech_stack: [TypeScript, Vitest]',
  'hosts:',
  '  local:',
  '    path: /home/user/test-repo',
  '  cloud-desktop:',
  '    path: /workspace/test-repo',
  '    ssh_host: dev-desktop',
].join('\n');

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── GET / — List Repositories ──────────────────────────────────────

describe('GET /api/repositories', () => {
  it('returns empty list when no repos exist', async () => {
    const app = createApp();
    const res = await request(app).get('/api/repositories');

    expect(res.status).toBe(200);
    expect(res.body.repositories).toEqual([]);
  });

  it('returns repos after creation', async () => {
    const app = createApp();

    // Create two repos
    await request(app)
      .post('/api/repositories/alpha')
      .send({ content: 'name: Alpha\nhosts:\n  local:\n    path: /a\n' });
    await request(app)
      .post('/api/repositories/beta')
      .send({ content: 'name: Beta\ndescription: Second\nhosts:\n  local:\n    path: /b\n' });

    const res = await request(app).get('/api/repositories');

    expect(res.status).toBe(200);
    expect(res.body.repositories).toHaveLength(2);

    const slugs = res.body.repositories.map((r: any) => r.slug).sort();
    expect(slugs).toEqual(['alpha', 'beta']);

    // Check fields
    const beta = res.body.repositories.find((r: any) => r.slug === 'beta');
    expect(beta.name).toBe('Beta');
    expect(beta.description).toBe('Second');
    expect(beta.modified).toBeTruthy();
    expect(beta.size).toBeGreaterThan(0);
  });
});

// ─── POST /:name — Create / Update ─────────────────────────────────

describe('POST /api/repositories/:name', () => {
  it('creates a new repository', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/repositories/test-repo')
      .send({ content: sampleYaml });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('created');

    // Verify file was written
    const content = await fs.readFile(
      path.join(REPOSITORIES_DIR, 'test-repo.yaml'),
      'utf-8',
    );
    expect(content).toBe(sampleYaml);
  });

  it('updates an existing repository', async () => {
    const app = createApp();

    // Create
    await request(app)
      .post('/api/repositories/update-me')
      .send({ content: 'name: Original\nhosts:\n  local:\n    path: /orig\n' });

    // Update
    const updated = 'name: Updated\nhosts:\n  local:\n    path: /updated\n';
    const res = await request(app)
      .post('/api/repositories/update-me')
      .send({ content: updated });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('updated');

    // Verify on disk
    const content = await fs.readFile(
      path.join(REPOSITORIES_DIR, 'update-me.yaml'),
      'utf-8',
    );
    expect(content).toBe(updated);
  });

  it('rejects missing content field', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/repositories/bad')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content');
  });

  it('rejects content exceeding 100KB', async () => {
    const app = createApp();
    const bigContent = 'x'.repeat(100_001);
    const res = await request(app)
      .post('/api/repositories/too-big')
      .send({ content: bigContent });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('too large');
  });

  it('rejects invalid slug characters', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/repositories/bad name!')
      .send({ content: 'name: Bad\n' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid repository name');
  });

  it('rejects slug starting with special char', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/repositories/-bad-start')
      .send({ content: 'name: Bad\n' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid repository name');
  });

  it('accepts slug with dots and underscores', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/repositories/my_repo.v2')
      .send({ content: 'name: My Repo V2\nhosts:\n  local:\n    path: /mr\n' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── GET /:name — Read Single ───────────────────────────────────────

describe('GET /api/repositories/:name', () => {
  it('returns content and metadata for existing repo', async () => {
    const app = createApp();

    // Create first
    await request(app)
      .post('/api/repositories/readable')
      .send({ content: sampleYaml });

    const res = await request(app).get('/api/repositories/readable');

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('readable');
    expect(res.body.content).toBe(sampleYaml);
    expect(res.body.modified).toBeTruthy();
    expect(new Date(res.body.modified).getTime()).toBeGreaterThan(0);
  });

  it('returns 404 for non-existent repo', async () => {
    const app = createApp();
    const res = await request(app).get('/api/repositories/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

// ─── DELETE /:name — Remove ─────────────────────────────────────────

describe('DELETE /api/repositories/:name', () => {
  it('deletes an existing repo', async () => {
    const app = createApp();

    // Create
    await request(app)
      .post('/api/repositories/deletable')
      .send({ content: 'name: Deletable\nhosts:\n  local:\n    path: /d\n' });

    // Verify it exists
    let res = await request(app).get('/api/repositories/deletable');
    expect(res.status).toBe(200);

    // Delete
    res = await request(app).delete('/api/repositories/deletable');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it's gone
    res = await request(app).get('/api/repositories/deletable');
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting non-existent repo', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/repositories/ghost');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

// ─── Full CRUD Lifecycle ────────────────────────────────────────────

describe('Full CRUD lifecycle', () => {
  it('create → list → read → update → read → delete → 404', async () => {
    const app = createApp();

    // 1. Empty initially
    let res = await request(app).get('/api/repositories');
    expect(res.body.repositories).toEqual([]);

    // 2. Create
    res = await request(app)
      .post('/api/repositories/lifecycle')
      .send({ content: sampleYaml });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');

    // 3. List contains it
    res = await request(app).get('/api/repositories');
    expect(res.body.repositories).toHaveLength(1);
    expect(res.body.repositories[0].slug).toBe('lifecycle');
    expect(res.body.repositories[0].name).toBe('Test Repo');
    expect(res.body.repositories[0].description).toBe('A sample repository for testing');
    expect(res.body.repositories[0].tech_stack).toBe('TypeScript, Vitest');

    // 4. Read single
    res = await request(app).get('/api/repositories/lifecycle');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(sampleYaml);

    // 5. Update
    const updatedYaml = sampleYaml.replace('A sample repository for testing', 'Updated description');
    res = await request(app)
      .post('/api/repositories/lifecycle')
      .send({ content: updatedYaml });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('updated');

    // 6. Read again — verify update
    res = await request(app).get('/api/repositories/lifecycle');
    expect(res.body.content).toContain('Updated description');

    // 7. Delete
    res = await request(app).delete('/api/repositories/lifecycle');
    expect(res.status).toBe(200);

    // 8. Read after delete → 404
    res = await request(app).get('/api/repositories/lifecycle');
    expect(res.status).toBe(404);

    // 9. List is empty again
    res = await request(app).get('/api/repositories');
    expect(res.body.repositories).toEqual([]);
  });
});

// ─── YAML Parsing in List Response ──────────────────────────────────

describe('YAML header parsing in list response', () => {
  it('parses host entries from YAML', async () => {
    const app = createApp();

    await request(app)
      .post('/api/repositories/multi-host')
      .send({ content: sampleYaml });

    const res = await request(app).get('/api/repositories');
    const repo = res.body.repositories[0];

    expect(repo.hosts).toBeDefined();
    expect(repo.hosts.local).toBeDefined();
    expect(repo.hosts.local.path).toBe('/home/user/test-repo');
    expect(repo.hosts['cloud-desktop']).toBeDefined();
    expect(repo.hosts['cloud-desktop'].ssh_host).toBe('dev-desktop');
  });

  it('handles multiline description with | syntax', async () => {
    const app = createApp();

    await request(app)
      .post('/api/repositories/multiline-desc')
      .send({
        content: [
          'name: Multiline',
          'description: |',
          '  This is a multiline',
          '  description block',
          'hosts:',
          '  local:',
          '    path: /tmp/ml',
        ].join('\n'),
      });

    const res = await request(app).get('/api/repositories');
    const repo = res.body.repositories[0];

    // The lightweight parser grabs the first indented line after |
    expect(repo.description).toBe('This is a multiline');
  });

  it('handles inline tech_stack array', async () => {
    const app = createApp();

    await request(app)
      .post('/api/repositories/tech')
      .send({
        content: [
          'name: Tech',
          'tech_stack: [Python, FastAPI, PostgreSQL]',
          'hosts:',
          '  local:',
          '    path: /tmp/tech',
        ].join('\n'),
      });

    const res = await request(app).get('/api/repositories');
    const repo = res.body.repositories[0];
    expect(repo.tech_stack).toBe('Python, FastAPI, PostgreSQL');
  });
});

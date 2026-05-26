/**
 * Category B: QMD Task + Session Search E2E
 *
 * Tests that tasks and sessions are synced to QMD stores and searchable
 * via the status API, search API, and memoryNotesSearch function.
 *
 * B1: QMD status API returns 4 stores (tasks + sessions have totalIndexed > 0)
 * B2: search() with types=['session'] returns session results
 * B3: memoryNotesSearch with sources=['task'] routes to task store
 * B4: memoryNotesSearch with sources=['session'] routes to session store
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-qmd-search'));

import {
  WALNUT_HOME,
  TASKS_DIR,
  TASKS_FILE,
  SESSIONS_FILE,
  MEMORY_DIR,
  NOTES_DIR,
} from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── Seed data ──

const SEED_TASKS = [
  {
    id: 'task-alpha-001',
    title: 'Implement authentication middleware',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Backend',
    session_ids: [],
    note: 'JWT tokens with refresh rotation',
    phase: 'TODO',
    source: 'local',
    description: 'Add Express middleware for JWT auth',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-beta-002',
    title: 'Design database schema for user profiles',
    status: 'todo',
    priority: 'none',
    category: 'Work',
    project: 'Backend',
    session_ids: [],
    note: 'PostgreSQL with JSONB columns',
    phase: 'TODO',
    source: 'local',
    description: 'Schema design for user profiles table',
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-gamma-003',
    title: 'Write unit tests for payment gateway',
    status: 'todo',
    priority: 'urgent',
    category: 'Work',
    project: 'Payments',
    session_ids: [],
    note: 'Cover Stripe webhook handling',
    phase: 'TODO',
    source: 'local',
    description: 'Test coverage for payment processing module',
    created_at: '2026-04-03T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
];

const SEED_SESSIONS = [
  {
    claudeSessionId: 'sess-qmd-test-aaa111',
    taskId: 'task-alpha-001',
    project: 'Backend',
    process_status: 'stopped',
    mode: 'exec',
    startedAt: '2026-04-09T10:00:00Z',
    lastActiveAt: '2026-04-09T11:00:00Z',
    messageCount: 5,
    title: 'Authentication middleware implementation session',
    description: 'Implemented JWT auth middleware with refresh token rotation',
  },
  {
    claudeSessionId: 'sess-qmd-test-bbb222',
    taskId: 'task-gamma-003',
    project: 'Payments',
    process_status: 'stopped',
    mode: 'exec',
    startedAt: '2026-04-10T14:00:00Z',
    lastActiveAt: '2026-04-10T15:30:00Z',
    messageCount: 12,
    title: 'Payment gateway unit tests session',
    description: 'Wrote comprehensive Stripe webhook handler tests',
  },
];

// ── Setup / Teardown ──

beforeAll(async () => {
  // Clean + create directories
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });

  // Seed tasks.json
  fs.writeFileSync(
    TASKS_FILE,
    JSON.stringify({ version: 1, tasks: SEED_TASKS }),
    'utf-8',
  );

  // Seed sessions.json
  fs.writeFileSync(
    SESSIONS_FILE,
    JSON.stringify({ version: 2, sessions: SEED_SESSIONS }),
    'utf-8',
  );

  // Start server (QMD sync happens in background)
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for QMD task + session sync to complete.
  // syncAllTasks and syncAllSessions run in the background on server start.
  // FTS5 triggers fire synchronously on insert, so keyword search works immediately
  // once sync finishes. Poll until task store has indexed docs.
  const maxWaitMs = 30_000;
  const pollMs = 500;
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(apiUrl('/api/qmd/status'));
      const data = await res.json();
      const tasksReady = data.stores?.tasks?.totalIndexed >= 3;
      const sessionsReady = data.stores?.sessions?.totalIndexed >= 2;
      if (tasksReady && sessionsReady) {
        ready = true;
        break;
      }
    } catch {
      // Server or QMD not ready yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!ready) {
    // Log current state for debugging, but don't fail — tests will catch specifics
    try {
      const res = await fetch(apiUrl('/api/qmd/status'));
      const data = await res.json();
      console.warn('QMD sync did not reach expected counts within timeout:', JSON.stringify(data.stores, null, 2));
    } catch {}
  }
}, 60_000);

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}, 15_000);

// ── Tests ──

describe('Category B: QMD Task + Session Search', () => {
  // B1: QMD status API returns 4 stores with indexed data
  describe('B1: QMD status API', () => {
    it('returns stores.tasks with totalIndexed >= 3', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toBeDefined();
      expect(data.stores.tasks).toBeDefined();
      expect(data.stores.tasks.totalIndexed).toBeGreaterThanOrEqual(3);
    });

    it('returns stores.sessions with totalIndexed >= 2', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toBeDefined();
      expect(data.stores.sessions).toBeDefined();
      expect(data.stores.sessions.totalIndexed).toBeGreaterThanOrEqual(2);
    });

    it('returns all 4 store keys (memory, notes, tasks, sessions)', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toHaveProperty('memory');
      expect(data.stores).toHaveProperty('notes');
      expect(data.stores).toHaveProperty('tasks');
      expect(data.stores).toHaveProperty('sessions');
    });
  });

  // B2: search() with types=['session'] returns session results
  describe('B2: search API with types=session', () => {
    it('returns session results for a matching query', async () => {
      const res = await fetch(apiUrl('/api/search?q=authentication+middleware&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.results.length).toBeGreaterThan(0);
      const sessionResults = data.results.filter(
        (r: { type: string }) => r.type === 'session',
      );
      expect(sessionResults.length).toBeGreaterThan(0);
    });

    it('session results have sessionId field', async () => {
      const res = await fetch(apiUrl('/api/search?q=payment+gateway&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // At least one result should have sessionId
      const withSessionId = data.results.filter(
        (r: { sessionId?: string }) => r.sessionId,
      );
      expect(withSessionId.length).toBeGreaterThan(0);
    });

    it('all results are type=session when types=session filter is used', async () => {
      const res = await fetch(apiUrl('/api/search?q=Stripe+webhook&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      if (data.results.length > 0) {
        const allSession = data.results.every(
          (r: { type: string }) => r.type === 'session',
        );
        expect(allSession).toBe(true);
      }
    });
  });

  // B3: memoryNotesSearch with sources=['task'] routes to task store
  describe('B3: memoryNotesSearch with sources=[task]', () => {
    it('returns results with source=task for matching query', async () => {
      const results = await memoryNotesSearch('authentication middleware', ['task']);

      expect(results.length).toBeGreaterThan(0);
      const taskResults = results.filter((r) => r.source === 'task');
      expect(taskResults.length).toBeGreaterThan(0);
    });

    it('extracts taskId from results', async () => {
      const results = await memoryNotesSearch('payment gateway', ['task']);

      expect(results.length).toBeGreaterThan(0);
      const withTaskId = results.filter((r) => r.taskId);
      expect(withTaskId.length).toBeGreaterThan(0);

      // Verify the taskId matches one of our seeded tasks
      const seededIds = new Set(SEED_TASKS.map((t) => t.id));
      const matched = withTaskId.some((r) => seededIds.has(r.taskId!));
      expect(matched).toBe(true);
    });

    it('finds task by unique content (PostgreSQL JSONB)', async () => {
      const results = await memoryNotesSearch('PostgreSQL JSONB', ['task']);

      expect(results.length).toBeGreaterThan(0);
      // Should match task-beta-002 which mentions PostgreSQL JSONB
      const match = results.find((r) => r.taskId === 'task-beta-002');
      expect(match).toBeDefined();
    });
  });

  // B4: memoryNotesSearch with sources=['session'] routes to session store
  describe('B4: memoryNotesSearch with sources=[session]', () => {
    it('returns results with source=session for matching query', async () => {
      const results = await memoryNotesSearch('JWT auth middleware', ['session']);

      expect(results.length).toBeGreaterThan(0);
      const sessionResults = results.filter((r) => r.source === 'session');
      expect(sessionResults.length).toBeGreaterThan(0);
    });

    it('extracts sessionId from results', async () => {
      const results = await memoryNotesSearch('Stripe webhook', ['session']);

      expect(results.length).toBeGreaterThan(0);
      const withSessionId = results.filter((r) => r.sessionId);
      expect(withSessionId.length).toBeGreaterThan(0);

      // Verify the sessionId matches one of our seeded sessions
      const seededIds = new Set(SEED_SESSIONS.map((s) => s.claudeSessionId));
      const matched = withSessionId.some((r) => seededIds.has(r.sessionId!));
      expect(matched).toBe(true);
    });

    it('finds session by unique content (refresh token rotation)', async () => {
      const results = await memoryNotesSearch('refresh token rotation', ['session']);

      expect(results.length).toBeGreaterThan(0);
      // Should match sess-qmd-test-aaa111 which mentions refresh token rotation
      const match = results.find((r) => r.sessionId === 'sess-qmd-test-aaa111');
      expect(match).toBeDefined();
    });
  });
});

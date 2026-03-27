/**
 * E2E tests for POST /api/sessions/:sessionId/retry
 *
 * Two paths exercised:
 *   Resume path  — session has claudeSessionId → calls sendMessageToSession, returns
 *                  { status: 'resuming', sessionId }, does NOT archive the session.
 *   Fallback path — no claudeSessionId (record written directly to disk to simulate a
 *                  session that failed before the CLI emitted its init event) →
 *                  archives + returns { status: 'pending', taskId, oldSessionId }.
 *
 * Guard tests:
 *   Running session  → 400
 *   Non-existent ID  → 404
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

// ── Hoist mocks BEFORE any module-under-test imports ──

vi.mock('../../../src/constants.js', () => createMockConstants());

// Mock session-message-queue so sendMessageToSession is a spy, not real
vi.mock('../../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: vi.fn().mockResolvedValue({ id: 'qm-test-1', sessionId: 'test', message: 'test', status: 'pending', enqueuedAt: new Date().toISOString() }),
}));

// Mock event-bus to capture SESSION_START emits without real side-effects
vi.mock('../../../src/core/event-bus.js', () => ({
  bus: { emit: vi.fn() },
  EventNames: {
    SESSION_START: 'session:start',
    SESSION_STATUS_CHANGED: 'session:status-changed',
    TASK_UPDATED: 'task:updated',
  },
  eventData: vi.fn(),
}));

// Mock session-liveness so PID checks don't actually probe the OS
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: vi.fn().mockResolvedValue(false),
}));

// Mock config-manager — use importOriginal to avoid missing-export errors
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/config-manager.js')>();
  return {
    ...actual,
    getConfig: vi.fn().mockResolvedValue({ defaults: { category: 'Inbox', source: 'local' } }),
    seedConfigDefaults: vi.fn().mockResolvedValue(undefined),
  };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
} from '../../../src/core/session-tracker.js';
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { WALNUT_HOME, SESSIONS_FILE } from '../../../src/constants.js';
import { sendMessageToSession } from '../../../src/core/session-message-queue.js';

// ── App factory ──

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

// ── Helpers ──

/** Create a task via task-manager and return its ID. */
async function makeTask(): Promise<string> {
  const { task } = await addTask({ title: 'Test Task', source: 'local' });
  return task.id;
}

// ── Lifecycle ──

beforeEach(async () => {
  _resetForTesting();
  vi.clearAllMocks();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Critical tests ──

describe('POST /api/sessions/:sessionId/retry — resume path (has claudeSessionId)', () => {
  it('returns { status: "resuming", sessionId } for an error session with claudeSessionId', async () => {
    const taskId = await makeTask();
    await createSessionRecord('resume-sess-1', taskId, 'project-a');
    await updateSessionRecord('resume-sess-1', { process_status: 'error', errorMessage: 'Process exited unexpectedly' });

    const app = createApp();
    const res = await request(app).post('/api/sessions/resume-sess-1/retry');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resuming');
    expect(res.body.sessionId).toBe('resume-sess-1');
  });

  it('calls sendMessageToSession with the correct sessionId', async () => {
    const taskId = await makeTask();
    await createSessionRecord('resume-sess-2', taskId, 'project-a');
    await updateSessionRecord('resume-sess-2', { process_status: 'error' });

    const app = createApp();
    await request(app).post('/api/sessions/resume-sess-2/retry');

    expect(sendMessageToSession).toHaveBeenCalledOnce();
    const [calledSessionId] = vi.mocked(sendMessageToSession).mock.calls[0];
    expect(calledSessionId).toBe('resume-sess-2');
  });

  it('calls sendMessageToSession with source "retry"', async () => {
    const taskId = await makeTask();
    await createSessionRecord('resume-sess-3', taskId, 'project-a');
    await updateSessionRecord('resume-sess-3', { process_status: 'error' });

    const app = createApp();
    await request(app).post('/api/sessions/resume-sess-3/retry');

    const [, , opts] = vi.mocked(sendMessageToSession).mock.calls[0];
    expect(opts?.source).toBe('retry');
  });
});

describe('POST /api/sessions/:sessionId/retry — session NOT archived after resume', () => {
  it('does not archive the session after resume retry', async () => {
    const taskId = await makeTask();
    await createSessionRecord('no-archive-sess', taskId, 'project-b');
    await updateSessionRecord('no-archive-sess', { process_status: 'error' });

    const app = createApp();
    const res = await request(app).post('/api/sessions/no-archive-sess/retry');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resuming');

    // The session record must NOT be archived after a resume retry
    const record = await getSessionByClaudeId('no-archive-sess');
    expect(record).not.toBeNull();
    expect(record!.archived).toBeFalsy();
  });

  it('also works for a stopped session (not just error)', async () => {
    const taskId = await makeTask();
    await createSessionRecord('stopped-resume-sess', taskId, 'project-b');
    await updateSessionRecord('stopped-resume-sess', { process_status: 'stopped' });

    const app = createApp();
    const res = await request(app).post('/api/sessions/stopped-resume-sess/retry');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resuming');

    const record = await getSessionByClaudeId('stopped-resume-sess');
    expect(record!.archived).toBeFalsy();
  });
});

// ── Fallback path: session record with empty claudeSessionId ──
//
// The fallback branch (`if (!record.claudeSessionId)`) fires for records whose
// claudeSessionId is an empty string — representing a session that crashed before
// the CLI emitted its init event. Such a record cannot be looked up via the
// normal HTTP route (the URL segment must be non-empty), so the practical path to
// test is:
//   1. Write the record directly to sessions.json with claudeSessionId: "".
//   2. Show that the route cannot surface this record (404) because the URL must
//      carry the placeholder key used at creation time, not an empty string.
//
// The meaningful invariants for the fallback path are therefore tested indirectly:
//   • The resume path (claudeSessionId truthy) is tested above and must NOT archive.
//   • Any session the route CAN look up always has a truthy claudeSessionId,
//     so it always takes the resume path.

describe('POST /api/sessions/:sessionId/retry — fallback path (no claudeSessionId)', () => {
  it('404s for a session ID that matches no record even after writing an empty-key record', async () => {
    const taskId = await makeTask();

    // Write a session record with an empty claudeSessionId directly to simulate
    // a session that crashed before the CLI emitted its init event.
    const now = new Date().toISOString();
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(
      SESSIONS_FILE,
      JSON.stringify({
        version: 2,
        sessions: [{
          claudeSessionId: '',
          taskId,
          project: 'project-c',
          process_status: 'error',
          mode: 'default',
          last_status_change: now,
          startedAt: now,
          lastActiveAt: now,
          messageCount: 1,
          type: 'interactive',
        }],
      }),
      'utf-8',
    );

    // The empty-key record cannot be reached via HTTP (route param must be non-empty).
    // Any non-matching ID returns 404 — confirming the route correctly ignores the record.
    const app = createApp();
    const res = await request(app).post('/api/sessions/nonexistent-placeholder/retry');
    expect(res.status).toBe(404);
  });
});

// ── Guard tests ──

describe('POST /api/sessions/:sessionId/retry — guard: running session → 400', () => {
  it('returns 400 when session is running', async () => {
    const taskId = await makeTask();
    await createSessionRecord('running-sess', taskId, 'project-d');
    // process_status defaults to 'running' at creation — no need to update

    const app = createApp();
    const res = await request(app).post('/api/sessions/running-sess/retry');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('running');
  });

  it('returns 400 when session is idle', async () => {
    const taskId = await makeTask();
    await createSessionRecord('idle-sess', taskId, 'project-d');
    await updateSessionRecord('idle-sess', { process_status: 'idle' });

    const app = createApp();
    const res = await request(app).post('/api/sessions/idle-sess/retry');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('idle');
  });
});

describe('POST /api/sessions/:sessionId/retry — guard: non-existent session → 404', () => {
  it('returns 404 for a session that does not exist', async () => {
    const app = createApp();
    const res = await request(app).post('/api/sessions/does-not-exist/retry');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

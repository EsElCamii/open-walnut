/**
 * E2E tests for session slot management fixes:
 *   1. start_session auto-archives stopped sessions for the same task
 *   2. start_session auto-archives error sessions for the same task
 *   3. Triage sessions do NOT block start_session
 *   4. checkSessionLimit skips error and embedded/sdk sessions
 *
 * Uses a real server with mock CLI for the start_session tests (Tests 1-3),
 * and direct session-tracker calls for the checkSessionLimit test (Test 4).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { executeTool } from '../../src/agent/tools.js';
import {
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  checkSessionLimit,
} from '../../src/core/session-tracker.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function createTask(title: string, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, ...opts }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { task: Record<string, unknown> };
  return body.task;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

// ══════════════════════════════════════════════════════════════════
// Tests 1-2: Auto-archive terminal sessions (stopped / error)
// ══════════════════════════════════════════════════════════════════

describe('start_session auto-archives terminal sessions', () => {
  it('stopped session is auto-archived and new session is NOT blocked', async () => {
    // Create a task via REST API
    const task = await createTask('Stopped session auto-archive test', { category: 'Test' });
    const taskId = task.id as string;

    // Create a stopped session record for this task and link it to the task slot
    const stoppedSession = await createSessionRecord('stopped-sess-001', taskId, 'Test', '/tmp', {
      pid: 99990,
    });
    await updateSessionRecord(stoppedSession.claudeSessionId, {
      process_status: 'stopped',
    });

    // Link the session to the task slot so the task thinks it has a session
    const { linkSessionSlot } = await import('../../src/core/task-manager.js');
    await linkSessionSlot(taskId, 'stopped-sess-001', 'exec');

    // Call start_session — should auto-archive the stopped session and NOT block
    const result = await executeTool('start_session', {
      task_id: taskId,
      title: 'New session after stopped',
      prompt: 'Continue working',
    }) as string;

    // The tool should NOT return a blocked response.
    // It may fail downstream (no cwd resolved), but the archiving happens first.
    expect(result).not.toContain('"blocked"');
    expect(result).not.toContain('already has a session');

    // Verify the old session was archived with the correct reason
    const archived = await getSessionByClaudeId('stopped-sess-001');
    expect(archived).not.toBeNull();
    expect(archived!.archived).toBe(true);
    expect(archived!.archive_reason).toBe('auto_cleared_for_new_session');
  });

  it('error session is auto-archived and new session is NOT blocked', async () => {
    // Create a task via REST API
    const task = await createTask('Error session auto-archive test', { category: 'Test' });
    const taskId = task.id as string;

    // Create an error session record for this task
    const errorSession = await createSessionRecord('error-sess-001', taskId, 'Test', '/tmp', {
      pid: 99991,
    });
    await updateSessionRecord(errorSession.claudeSessionId, {
      process_status: 'error',
    });

    // Link the session to the task slot
    const { linkSessionSlot } = await import('../../src/core/task-manager.js');
    await linkSessionSlot(taskId, 'error-sess-001', 'exec');

    // Call start_session — should auto-archive the error session and NOT block
    const result = await executeTool('start_session', {
      task_id: taskId,
      title: 'New session after error',
      prompt: 'Retry the work',
    }) as string;

    // Should NOT be blocked
    expect(result).not.toContain('"blocked"');
    expect(result).not.toContain('already has a session');

    // Verify the old error session was archived
    const archived = await getSessionByClaudeId('error-sess-001');
    expect(archived).not.toBeNull();
    expect(archived!.archived).toBe(true);
    expect(archived!.archive_reason).toBe('auto_cleared_for_new_session');
  });
});

// ══════════════════════════════════════════════════════════════════
// Test 3: Triage sessions do NOT block start_session
// ══════════════════════════════════════════════════════════════════

describe('start_session skips triage sessions', () => {
  it('triage session does NOT block start_session', async () => {
    // Create a task via REST API
    const task = await createTask('Triage no-block test', { category: 'Test' });
    const taskId = task.id as string;

    // Create a triage session (embedded, type: triage, running) for this task
    await createSessionRecord('triage-sess-001', taskId, 'Test', '/tmp', {
      pid: 99992,
      provider: 'embedded',
      type: 'triage',
    });

    // Call start_session — triage session should be skipped in the per-task check
    const result = await executeTool('start_session', {
      task_id: taskId,
      title: 'New session with triage running',
      prompt: 'Start working',
    }) as string;

    // Should NOT be blocked by the triage session
    expect(result).not.toContain('"blocked"');
    expect(result).not.toContain('already has a session');

    // Verify the triage session was NOT archived (left as-is)
    const triageSession = await getSessionByClaudeId('triage-sess-001');
    expect(triageSession).not.toBeNull();
    expect(triageSession!.archived).toBeFalsy();
    expect(triageSession!.process_status).toBe('running');
  });
});

// ══════════════════════════════════════════════════════════════════
// Test 4: checkSessionLimit skips error and embedded/sdk sessions
// ══════════════════════════════════════════════════════════════════

describe('checkSessionLimit skips error and embedded/sdk sessions', () => {
  it('does not count error, embedded, or sdk sessions toward the limit', async () => {
    // Take a baseline of running sessions (prior tests may have left sessions in the store)
    const baseline = await checkSessionLimit(undefined, { local: 100 });
    const baselineRunning = baseline.running;

    // Create sessions of various types that should NOT count toward the limit:

    // 1. Error session (has PID but process_status = error)
    await createSessionRecord('limit-error-001', 'limit-task-1', 'proj', '/tmp', { pid: 88001 });
    await updateSessionRecord('limit-error-001', { process_status: 'error' });

    // 2. Embedded session (running but provider = embedded)
    await createSessionRecord('limit-embedded-001', 'limit-task-2', 'proj', '/tmp', {
      pid: 88002,
      provider: 'embedded',
      type: 'subagent',
    });

    // 3. SDK session (running but provider = sdk)
    await createSessionRecord('limit-sdk-001', 'limit-task-3', 'proj', '/tmp', {
      pid: 88003,
      provider: 'sdk',
    });

    // Check session limit — none of the 3 new sessions should count toward the limit
    const result = await checkSessionLimit(undefined, { local: 100 });

    // Running count should be unchanged from baseline (error/embedded/sdk are all skipped)
    expect(result.running).toBe(baselineRunning);
    expect(result.allowed).toBe(true);
  });
});

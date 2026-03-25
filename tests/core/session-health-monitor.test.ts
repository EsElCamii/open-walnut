/**
 * Tests for SessionHealthMonitor — specifically the process_status:'error' behavior
 * introduced by the "Migrate work_status:'error' → process_status:'error'" feature.
 *
 * Key assertions:
 *   - Health monitor sets process_status:'error' + errorMessage when process dies without result
 *   - Health monitor does NOT set work_status:'error' (old behavior, now removed)
 *   - Health monitor sets process_status:'stopped' + work_status:'agent_complete' when result found
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock isProcessAliveAsync — used as fallback when no session manager is registered
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));

// Mock daemon-connection — local sessions don't use it
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
}));

// Mock session-manager registry — returns null (no active manager registered)
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

// Mock config-manager — returns a config with no idle_timeout override
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: {} }),
}));

// Mock task-manager to avoid setting up a full task store for clearSessionSlot calls
vi.mock('../../src/core/task-manager.js', () => ({
  clearSessionSlot: async (taskId: string, sessionId: string) => ({
    task: { id: taskId, session_id: sessionId, title: 'mock task' },
  }),
}));

// Mock event bus — we don't need to verify events in these unit tests
vi.mock('../../src/core/event-bus.js', () => ({
  bus: { emit: vi.fn() },
  EventNames: {
    SESSION_STATUS_CHANGED: 'session:status-changed',
    TASK_UPDATED: 'task:updated',
  },
}));

import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js';
import { WALNUT_HOME } from '../../src/constants.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

// ── Test 3: Health monitor sets process_status:'error' when process dies without result ──

describe('SessionHealthMonitor — process_status:error behavior', () => {
  it('sets process_status:error and errorMessage when local process dies without result', async () => {
    // Create a session with process_status:'running', work_status:'in_progress', dead PID
    // No outputFile → no result event → should trigger the error path
    await createSessionRecord('dead-no-result', 'task-1', 'proj', undefined, {
      pid: 999999999,  // Dead PID — isProcessAliveAsync mocked to return false
      outputFile: '/tmp/nonexistent-output-no-result.jsonl',  // File doesn't exist → no result
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'dead-no-result');
    expect(session).toBeDefined();

    // Should set process_status:'error' (NOT 'stopped')
    expect(session!.process_status).toBe('error');

    // Should set a human-readable error message
    expect(session!.errorMessage).toBe('Process exited without result');

    // Should NOT have work_status:'error' (that's the old behavior — now removed)
    expect(session!.work_status).not.toBe('error');

    // work_status should remain 'in_progress' (unchanged from original)
    expect(session!.work_status).toBe('in_progress');
  });

  it('sets process_status:stopped and work_status:agent_complete when result found in output file', async () => {
    // Create an output file with a successful result event
    const outputFile = path.join(tmpDir, 'session-with-result.jsonl');
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All done' });
    await fsp.writeFile(outputFile, resultLine + '\n', 'utf-8');

    await createSessionRecord('dead-with-result', 'task-2', 'proj', undefined, {
      pid: 999999999,
      outputFile,
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'dead-with-result');
    expect(session).toBeDefined();

    // Result found → normal completion
    expect(session!.process_status).toBe('stopped');
    expect(session!.work_status).toBe('agent_complete');

    // Should NOT be error state
    expect(session!.process_status).not.toBe('error');
    expect(session!.errorMessage).toBeUndefined();
  });

  it('does not change terminal sessions', async () => {
    // A session already in error state should remain untouched by health check
    await createSessionRecord('already-error', 'task-3', 'proj', undefined, { pid: 999999999 });
    await updateSessionRecord('already-error', {
      process_status: 'error',
      errorMessage: 'Previous error',
      work_status: 'in_progress',
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'already-error');
    expect(session).toBeDefined();

    // Terminal session — should remain error, not double-processed
    expect(session!.process_status).toBe('error');
    expect(session!.errorMessage).toBe('Previous error');
  });

  it('does not change completed sessions', async () => {
    await createSessionRecord('already-done', 'task-4', 'proj');
    await updateSessionRecord('already-done', {
      process_status: 'stopped',
      work_status: 'completed',
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'already-done');
    expect(session!.process_status).toBe('stopped');
    expect(session!.work_status).toBe('completed');
  });
});

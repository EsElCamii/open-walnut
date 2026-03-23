/**
 * E2E tests for one-task-one-session enforcement on update_session (move).
 *
 * What's real: Express server, task-manager, session-tracker, REST API, agent tools.
 * What's mocked: constants.js (temp dir), JSONL files.
 *
 * Tests verify: update_session with task_id change rejects when target task
 * already has a non-archived session (strict 1-session-per-task rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';
import { getSessionByClaudeId } from '../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function createTask(title: string, category: string, project: string): Promise<{ id: string; title: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, project }),
  });
  const data = await res.json() as { task: { id: string; title: string } };
  return data.task;
}

const MOCK_CWD = '/home/user/my-project';

function buildMockJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'human', role: 'user', message: 'Hello', timestamp: '2026-03-01T10:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', role: 'assistant', message: 'Hi there', timestamp: '2026-03-01T10:01:00.000Z' }),
  ];
  return lines.join('\n') + '\n';
}

async function writeMockJsonl(sessionId: string, cwd: string): Promise<string> {
  const encoded = encodeProjectPath(cwd);
  const dir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, buildMockJsonl());
  return filePath;
}

async function importSession(sessionId: string, taskId: string): Promise<string> {
  const { tools } = await import('../../src/agent/tools.js');
  const importTool = tools.find(t => t.name === 'import_session')!;
  return importTool.execute({
    session_id: sessionId,
    task_id: taskId,
    working_directory: MOCK_CWD,
  }) as Promise<string>;
}

async function updateSession(sessionId: string, params: Record<string, unknown>): Promise<string> {
  const { tools } = await import('../../src/agent/tools.js');
  const updateTool = tools.find(t => t.name === 'update_session')!;
  return updateTool.execute({ session_id: sessionId, ...params }) as Promise<string>;
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer(server);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('update_session move — one-task-one-session enforcement', () => {
  it('blocks move when target task already has a non-archived session', async () => {
    // Create two tasks, each with a session
    const taskA = await createTask('Task A', 'TestCat', 'MoveTest');
    const taskB = await createTask('Task B', 'TestCat', 'MoveTest');

    const sessA = 'move-test-sess-aaaa-0000-0000-0000';
    const sessB = 'move-test-sess-bbbb-0000-0000-0000';
    await writeMockJsonl(sessA, MOCK_CWD);
    await writeMockJsonl(sessB, MOCK_CWD);

    // Import a session to each task
    const r1 = await importSession(sessA, taskA.id);
    expect(r1).toContain('Imported session');
    const r2 = await importSession(sessB, taskB.id);
    expect(r2).toContain('Imported session');

    // Try to move sessA to taskB (which already has sessB) — should be blocked
    const moveResult = await updateSession(sessA, { task_id: taskB.id });
    expect(moveResult).toContain('already has a session');
    expect(moveResult).toContain('only ONE session');

    // Verify sessA is still on taskA (not moved)
    const sessARecord = await getSessionByClaudeId(sessA);
    expect(sessARecord!.taskId).toBe(taskA.id);
  });

  it('allows move when target task has no session', async () => {
    const taskC = await createTask('Task C - has session', 'TestCat', 'MoveTest');
    const taskD = await createTask('Task D - empty', 'TestCat', 'MoveTest');

    const sessC = 'move-test-sess-cccc-0000-0000-0000';
    await writeMockJsonl(sessC, MOCK_CWD);

    const r1 = await importSession(sessC, taskC.id);
    expect(r1).toContain('Imported session');

    // Move sessC to taskD (which has no session) — should succeed
    const moveResult = await updateSession(sessC, { task_id: taskD.id });
    expect(moveResult).toContain('moved to task');

    // Verify session is now on taskD
    const sessRecord = await getSessionByClaudeId(sessC);
    expect(sessRecord!.taskId).toBe(taskD.id);
  });

  it('allows move when target task only has archived sessions', async () => {
    const taskE = await createTask('Task E - archived session', 'TestCat', 'MoveTest');
    const taskF = await createTask('Task F - has session to move', 'TestCat', 'MoveTest');

    const sessE = 'move-test-sess-eeee-0000-0000-0000';
    const sessF = 'move-test-sess-ffff-0000-0000-0000';
    await writeMockJsonl(sessE, MOCK_CWD);
    await writeMockJsonl(sessF, MOCK_CWD);

    // Import and archive session on taskE
    await importSession(sessE, taskE.id);
    await updateSession(sessE, { archived: true, archive_reason: 'test' });

    // Import session on taskF
    await importSession(sessF, taskF.id);

    // Move sessF to taskE (which only has an archived session) — should succeed
    const moveResult = await updateSession(sessF, { task_id: taskE.id });
    expect(moveResult).toContain('moved to task');

    const sessFRecord = await getSessionByClaudeId(sessF);
    expect(sessFRecord!.taskId).toBe(taskE.id);
  });
});

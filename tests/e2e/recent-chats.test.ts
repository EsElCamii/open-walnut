/**
 * E2E tests for the "Recent Chats" feature (last_session_update field).
 *
 * The feature adds a `last_session_update` ISO timestamp to tasks, set when:
 *   1. linkSession() links a session to a task
 *   2. touchLastSessionUpdate() is called on session resume (handleSend)
 *
 * The frontend uses this field to show a "Recent" section in the sidebar,
 * sorted by last_session_update desc, excluding pinned and completed tasks.
 *
 * Tests:
 *   1. linkSession() sets last_session_update on the task
 *   2. touchLastSessionUpdate() sets the field and emits task:updated via WS
 *   3. REST API GET returns last_session_update after it has been set
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-recent'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { linkSession, touchLastSessionUpdate, getTask } from '../../src/core/task-manager.js';
import { updateConfig } from '../../src/core/config-manager.js';

// ── Types ──

interface WsFrame {
  type: string;
  name?: string;
  data?: unknown;
  [key: string]: unknown;
}

// ── Server state ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── WebSocket helpers ──

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for WS event "${eventName}"`)),
      timeoutMs,
    );
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── REST helpers ──

async function createTask(title: string): Promise<{ id: string; last_session_update?: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category: 'test' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task: { id: string; last_session_update?: string } };
  return body.task;
}

async function fetchTask(id: string): Promise<{ id: string; last_session_update?: string; session_id?: string; pinned?: boolean; phase?: string }> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { id: string; last_session_update?: string; session_id?: string; pinned?: boolean; phase?: string } };
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
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('linkSession sets last_session_update', () => {
  it('new task has no last_session_update initially', async () => {
    const task = await createTask('Fresh task — no session');
    expect(task.last_session_update).toBeUndefined();
  });

  it('linkSession() sets last_session_update to a valid ISO timestamp', async () => {
    const before = new Date().toISOString();
    const task = await createTask('Link session test');

    const { task: linked } = await linkSession(task.id, 'sess-recent-001');

    expect(linked.last_session_update).toBeDefined();
    expect(typeof linked.last_session_update).toBe('string');

    // Verify it is a valid ISO date and is recent (between before and now)
    const ts = new Date(linked.last_session_update!).getTime();
    expect(ts).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);

    // Also verify session_id was linked
    expect(linked.session_id).toBe('sess-recent-001');
  });

  it('linkSession() persists last_session_update to disk', async () => {
    const task = await createTask('Persist test');
    await linkSession(task.id, 'sess-persist-001');

    // Read back via the task manager (bypasses any caching)
    const persisted = await getTask(task.id);
    expect(persisted.last_session_update).toBeDefined();
    expect(new Date(persisted.last_session_update!).getTime()).toBeGreaterThan(0);
  });
});

describe('touchLastSessionUpdate works', () => {
  it('touchLastSessionUpdate() sets the field on an existing task', async () => {
    const task = await createTask('Touch test');

    // Initially no last_session_update
    const before = await getTask(task.id);
    expect(before.last_session_update).toBeUndefined();

    const beforeTime = new Date().toISOString();
    await touchLastSessionUpdate(task.id);

    const after = await getTask(task.id);
    expect(after.last_session_update).toBeDefined();
    const ts = new Date(after.last_session_update!).getTime();
    expect(ts).toBeGreaterThanOrEqual(new Date(beforeTime).getTime());
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('touchLastSessionUpdate() emits task:updated via WebSocket', async () => {
    const task = await createTask('WS touch test');

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:updated');

      await touchLastSessionUpdate(task.id);

      const frame = await eventPromise;
      expect(frame.name).toBe('task:updated');

      const data = frame.data as { task: { id: string; last_session_update?: string } };
      expect(data.task.id).toBe(task.id);
      expect(data.task.last_session_update).toBeDefined();
    } finally {
      ws.close();
      await delay(50);
    }
  });

  it('touchLastSessionUpdate() updates an already-set timestamp', async () => {
    const task = await createTask('Double touch test');

    // First touch
    await touchLastSessionUpdate(task.id);
    const first = await getTask(task.id);
    const firstTs = first.last_session_update!;

    // Small delay to ensure timestamps differ
    await delay(50);

    // Second touch
    await touchLastSessionUpdate(task.id);
    const second = await getTask(task.id);
    const secondTs = second.last_session_update!;

    // Second timestamp should be later (or equal on fast systems)
    expect(new Date(secondTs).getTime()).toBeGreaterThanOrEqual(new Date(firstTs).getTime());
  });
});

describe('API returns last_session_update', () => {
  it('GET /api/tasks/:id includes last_session_update after linkSession', async () => {
    const task = await createTask('API return test');
    await linkSession(task.id, 'sess-api-001');

    const fetched = await fetchTask(task.id);
    expect(fetched.last_session_update).toBeDefined();
    expect(typeof fetched.last_session_update).toBe('string');
    expect(new Date(fetched.last_session_update!).getTime()).toBeGreaterThan(0);
  });

  it('GET /api/tasks/:id includes last_session_update after touchLastSessionUpdate', async () => {
    const task = await createTask('API touch return test');
    await touchLastSessionUpdate(task.id);

    const fetched = await fetchTask(task.id);
    expect(fetched.last_session_update).toBeDefined();
    expect(typeof fetched.last_session_update).toBe('string');
    expect(new Date(fetched.last_session_update!).getTime()).toBeGreaterThan(0);
  });

  it('GET /api/tasks lists tasks with last_session_update for filtering', async () => {
    // Create two tasks — only one gets a session touch
    const taskA = await createTask('List test A — touched');
    const taskB = await createTask('List test B — untouched');

    await touchLastSessionUpdate(taskA.id);

    const res = await fetch(apiUrl('/api/tasks'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; last_session_update?: string }> };

    const foundA = body.tasks.find((t) => t.id === taskA.id);
    const foundB = body.tasks.find((t) => t.id === taskB.id);

    expect(foundA).toBeDefined();
    expect(foundA!.last_session_update).toBeDefined();

    expect(foundB).toBeDefined();
    expect(foundB!.last_session_update).toBeUndefined();
  });
});

describe('touchLastSessionUpdate bumps a pinned task within its tier', () => {
  async function pinToTier(id: string, tier: string): Promise<void> {
    const pinRes = await fetch(apiUrl(`/api/focus/tasks/${id}`), { method: 'POST' });
    expect(pinRes.status).toBe(200);
    const tierRes = await fetch(apiUrl(`/api/focus/tasks/${id}/tier`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    expect(tierRes.status).toBe(200);
  }

  async function focusOrder(): Promise<string[]> {
    const res = await fetch(apiUrl('/api/focus/tasks'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { focus_tasks: string[] };
    return body.focus_tasks;
  }

  it('chatting with a task moves it to the front of its tier, preserving the rest', async () => {
    const t1 = await createTask('Bump tier — t1');
    const t2 = await createTask('Bump tier — t2');
    const t3 = await createTask('Bump tier — t3');

    await pinToTier(t1.id, 'focus');
    await pinToTier(t2.id, 'focus');
    await pinToTier(t3.id, 'focus');

    const before = (await focusOrder()).filter((id) => [t1.id, t2.id, t3.id].includes(id));
    expect(before.length).toBe(3);

    // Chat with whichever task is currently last among our three.
    const last = before[2];
    await touchLastSessionUpdate(last);

    const after = (await focusOrder()).filter((id) => [t1.id, t2.id, t3.id].includes(id));
    // Touched task jumps to the front; the other two keep their relative order.
    expect(after[0]).toBe(last);
    expect(after.slice(1)).toEqual(before.slice(0, 2));
  });

  it('only reorders within the same tier, leaving other tiers untouched', async () => {
    const f1 = await createTask('Tier isolation — focus 1');
    const f2 = await createTask('Tier isolation — focus 2');
    const n1 = await createTask('Tier isolation — next 1');
    const n2 = await createTask('Tier isolation — next 2');

    await pinToTier(f1.id, 'focus');
    await pinToTier(f2.id, 'focus');
    await pinToTier(n1.id, 'next');
    await pinToTier(n2.id, 'next');

    const focusBefore = (await focusOrder()).filter((id) => [f1.id, f2.id].includes(id));

    // Chat with the second NEXT task — it should jump to the front of NEXT only.
    await touchLastSessionUpdate(n2.id);

    const res = await fetch(apiUrl('/api/focus/tasks'));
    const body = (await res.json()) as { focus_tasks: string[]; next_tasks: string[] };

    // FOCUS tier (a different tier) must keep its relative order — bumping a NEXT
    // task must not touch FOCUS ordering.
    const focusAfter = body.focus_tasks.filter((id) => [f1.id, f2.id].includes(id));
    expect(focusAfter).toEqual(focusBefore);

    // NEXT tier: n2 bubbled to the front.
    expect(body.next_tasks[0]).toBe(n2.id);
  });

  it('does NOT bump when ui.bump_pinned_on_chat is disabled', async () => {
    const a = await createTask('No-bump — a');
    const b = await createTask('No-bump — b');
    const c = await createTask('No-bump — c');

    await pinToTier(a.id, 'wait');
    await pinToTier(b.id, 'wait');
    await pinToTier(c.id, 'wait');

    const waitOrder = async () => {
      const res = await fetch(apiUrl('/api/focus/tasks'));
      const body = (await res.json()) as { wait_tasks: string[] };
      return body.wait_tasks.filter((id) => [a.id, b.id, c.id].includes(id));
    };

    const before = await waitOrder();
    expect(before.length).toBe(3);

    try {
      await updateConfig({ ui: { bump_pinned_on_chat: false } });
      // Chat with whichever task is currently last — with bumping disabled the
      // order must NOT change.
      await touchLastSessionUpdate(before[2]);
      const after = await waitOrder();
      expect(after).toEqual(before);
      // The timestamp must still update even when bumping is off.
      const touched = await getTask(a.id);
      expect(touched.last_session_update).toBeDefined();
    } finally {
      await updateConfig({ ui: { bump_pinned_on_chat: true } });
    }
  });
});

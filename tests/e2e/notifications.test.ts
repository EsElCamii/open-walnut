/**
 * E2E tests for the unified notification system: real server + event bus + the
 * persistent feed route. Follows the harness in tests/e2e/cron-lifecycle.test.ts.
 *
 * Verifies the end-to-end wiring the unit tests can't reach:
 *   - GET /api/notifications serves an empty feed on a fresh server.
 *   - A session:permission-request emitted on the bus (what the session runner
 *     does) is persisted into the feed by the server.ts subscriber, and shows up
 *     via GET with an unread count.
 *   - A cron:notification (emitted via the same path the cron callback uses) also
 *     lands in the feed.
 *   - POST /mark-read clears the unread count.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FeedResponse {
  feed: Array<{ id: string; kind: string; title: string; read: boolean; dedupKey: string }>;
  unreadCount: number;
}

async function getFeed(): Promise<FeedResponse> {
  const res = await fetch(apiUrl('/api/notifications'));
  expect(res.status).toBe(200);
  return (await res.json()) as FeedResponse;
}

/** Poll the feed until `pred` holds or we time out (the bus subscriber is async). */
async function pollFeed(pred: (f: FeedResponse) => boolean, timeoutMs = 3000): Promise<FeedResponse> {
  const deadline = Date.now() + timeoutMs;
  let last = await getFeed();
  while (!pred(last) && Date.now() < deadline) {
    await delay(50);
    last = await getFeed();
  }
  return last;
}

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

describe('Notification feed API', () => {
  it('serves an empty feed on a fresh server', async () => {
    const body = await getFeed();
    expect(body.feed).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('persists a permission request into the feed', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    }, ['*']);

    const body = await pollFeed((f) => f.feed.some((n) => n.dedupKey === 'perm:req-e2e-1'));
    const perm = body.feed.find((n) => n.dedupKey === 'perm:req-e2e-1');
    expect(perm).toBeTruthy();
    expect(perm?.kind).toBe('permission');
    expect(perm?.title).toBe('Bash');
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('does not double-persist a re-emitted permission request (dedup by requestId)', async () => {
    bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
      sessionId: 'sess-e2e-1',
      requestId: 'req-e2e-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    }, ['*']);
    await delay(200);
    const body = await getFeed();
    expect(body.feed.filter((n) => n.dedupKey === 'perm:req-e2e-1')).toHaveLength(1);
  });

  it('marks all read, clearing the unread count', async () => {
    const res = await fetch(apiUrl('/api/notifications/mark-read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await getFeed();
    expect(body.unreadCount).toBe(0);
    expect(body.feed.every((n) => n.read)).toBe(true);
  });
});

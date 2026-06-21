/**
 * E2E (headline): a truncated-success turn auto-opens a forensic incident.
 *
 * This is the proof that the 2026-06-04 session 1fc886da bug would now be caught
 * AUTOMATICALLY. That bug: the CLI emitted result subtype=success while the last
 * assistant message_delta carried stop_reason=null — the stream cut off mid-turn
 * yet reported a clean success, so nothing errored and it was only found hours
 * later by hand.
 *
 * What's real: Express server, WebSocket, event bus, the session runner +
 * RemoteSessionManager, the turn recorder + invariant engine, and the incident
 * store (incidents.json under the temp WALNUT_HOME). What's mocked: constants.js
 * (temp dir) + the Claude CLI (mock-claude.mjs, spawned by a MockDaemon and
 * driven by the "truncated-success" message trigger).
 *
 * The session is routed through a MockDaemon via setTestDaemonUrl — the same
 * injection the daemon e2e tests use — because all local sessions now go through
 * a daemon (a bare setCliCommand no longer reaches the spawn).
 *
 * Flow exercised:
 *   WS session:start "truncated-success" → MockDaemon spawns mock CLI →
 *     stream_event(message_delta stop_reason:null) + result(success) →
 *     claude-code-session captures _lastStopReason=null → recordTurn →
 *     truncated-success invariant fires → incident sink opens an Incident →
 *   GET /api/incidents returns it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, LOG_DIR, LOG_PREFIX } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { flushLogBuffer } from '../../src/logging/logger.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs');

// ── Types ──
interface WsEvent {
  type: string;
  name?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
interface Incident {
  id: string;
  sessionId: string;
  trigger: string;
  label: string;
  severity: string;
  status: string;
  turn?: { stopReason?: string | null };
  violations?: Array<{ ruleId: string }>;
}

// ── Harness ──
let server: HttpServer;
let port: number;
let daemon: MockDaemon;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}
function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000);
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent;
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** Poll a check fn until it returns a truthy value, or throw after timeoutMs. */
async function pollFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('pollFor timed out');
    await delay(intervalMs);
  }
}
/** Read every `obs` "turn" wide event from the flushed log file. */
async function readObsTurnEvents(): Promise<Array<Record<string, unknown>>> {
  await flushLogBuffer();
  let files: string[] = [];
  try {
    files = await fs.readdir(LOG_DIR);
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    if (!f.startsWith(LOG_PREFIX) || !f.endsWith('.log')) continue;
    const content = await fs.readFile(path.join(LOG_DIR, f), 'utf-8');
    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.subsystem === 'obs' && e.message === 'turn') out.push(e);
      } catch { /* skip */ }
    }
  }
  return out;
}

// ── Setup / Teardown ──
beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Route the server's local sessions through a MockDaemon that spawns the mock
  // CLI (all local sessions go through a daemon; a bare setCliCommand can't reach
  // the spawn). This is the same wiring as session-manager-e2e.test.ts.
  daemon = await createMockDaemon();
  sessionRunner.setCliCommand(MOCK_CLI);
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Let the server finish wiring (event bus, incident sink, health monitor).
  await delay(2000);
}, 30000);

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined);
  await stopServer();
  await daemon.stop();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

// ── Test ──
describe('Forensic observability E2E — truncated success auto-opens an incident', () => {
  it('drives a truncated-success turn and auto-creates a truncated-success incident', async () => {
    const ws = await connectWs();

    // Sanity: no incidents before the run.
    const before = await fetch(apiUrl('/api/incidents'));
    expect(before.status).toBe(200);
    expect(((await before.json()) as { incidents: Incident[] }).incidents).toHaveLength(0);

    // Drive the bug: the mock CLI emits message_delta(stop_reason:null) + result(success).
    // We do NOT wait on a session:result WS frame — the headline assertion is "an
    // incident got auto-created", so we poll the incident API directly. (Coupling the
    // proof to a WS frame shape would be both fragile and beside the point.)
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      message: 'truncated-success',
    });
    expect((rpcRes as Record<string, unknown>).ok).toBe(true);

    // 1) HEADLINE: an incident was auto-created. Fresh WALNUT_HOME → the only
    //    truncated-success incident is the one this turn produced. The sessionId
    //    comes from the incident itself, decoupled from any WS event.
    const incident = await pollFor(async () => {
      const res = await fetch(apiUrl('/api/incidents'));
      if (res.status !== 200) return undefined;
      const { incidents } = (await res.json()) as { incidents: Incident[] };
      return incidents.find((i) => i.label === 'truncated-success');
    });

    expect(incident.trigger).toBe('invariant');
    expect(incident.label).toBe('truncated-success');
    expect(incident.severity).toBe('error');
    expect(incident.status).toBe('open');
    expect(incident.turn?.stopReason).toBeNull();
    expect(incident.violations?.map((v) => v.ruleId)).toContain('truncated-success');
    const sessionId = incident.sessionId;
    expect(sessionId).toBeTruthy();

    // 2) The wide `obs` "turn" event was logged for this session — the metric/trace
    //    source. It records subtype=success WITH stopReason=null, which is exactly the
    //    silent-success fingerprint (a clean success that was actually truncated).
    const turnEvents = await pollFor(async () => {
      const events = await readObsTurnEvents();
      const mine = events.filter((e) => e.sessionId === sessionId);
      return mine.length > 0 ? mine : undefined;
    });
    expect(turnEvents[0].subtype).toBe('success');
    expect(turnEvents[0].isError).toBe(false);
    expect(turnEvents[0].stopReason).toBeNull();

    // Single-incident fetch by id works too.
    const single = await fetch(apiUrl(`/api/incidents/${incident.id}`));
    expect(single.status).toBe(200);
    expect(((await single.json()) as { incident: Incident }).incident.id).toBe(incident.id);

    ws.close();
    await delay(50);
  }, 40000);

  it('does NOT open an incident for a healthy (non-truncated) turn', async () => {
    const ws = await connectWs();

    // Snapshot what already exists (the truncated test above left one incident +
    // one session). We identify the healthy turn by the session id that is NEW
    // relative to this snapshot — unambiguous even with a prior session present.
    const existingIncidentIds = new Set(
      ((await (await fetch(apiUrl('/api/incidents'))).json()) as { incidents: Incident[] }).incidents.map((i) => i.id),
    );
    const existingSessionIds = new Set(
      ((await (await fetch(apiUrl('/api/sessions'))).json()) as { sessions: Array<{ claudeSessionId: string }> }).sessions.map(
        (s) => s.claudeSessionId,
      ),
    );

    const rpcRes = await sendWsRpc(ws, 'session:start', { message: 'a perfectly normal request' });
    expect((rpcRes as Record<string, unknown>).ok).toBe(true);

    // Identify this turn's session via the persisted record (no WS frame dependency):
    // poll until a session id that wasn't in the pre-start snapshot appears.
    const sessionId = await pollFor(async () => {
      const res = await fetch(apiUrl('/api/sessions'));
      if (res.status !== 200) return undefined;
      const { sessions } = (await res.json()) as { sessions: Array<{ claudeSessionId: string }> };
      return sessions.map((s) => s.claudeSessionId).find((sid) => sid && !existingSessionIds.has(sid));
    });

    // Give the async sink a chance, then confirm NO new incident was opened — neither
    // for this session specifically, nor any incident beyond the pre-existing set.
    await delay(800);
    const { incidents } = (await (await fetch(apiUrl('/api/incidents'))).json()) as { incidents: Incident[] };
    expect(incidents.find((i) => i.sessionId === sessionId)).toBeUndefined();
    expect(incidents.filter((i) => !existingIncidentIds.has(i.id))).toHaveLength(0);

    ws.close();
    await delay(50);
  }, 40000);
});

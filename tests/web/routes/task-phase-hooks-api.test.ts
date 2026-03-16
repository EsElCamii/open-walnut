/**
 * E2E test for GET /api/task-phase-hooks endpoint.
 *
 * B2: Returns complete hook info via HTTP with enriched fields.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { startServer, stopServer } from '../../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
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

interface HookInfo {
  id: string;
  name: string;
  description: string;
  triggerPhase: string;
  fromPhases?: string[];
  actionType: string;
  actionDetail: string;
  conditions: string[];
  priority: number;
}

describe('GET /api/task-phase-hooks (B2)', () => {
  it('returns 200 with a JSON array of hook info objects', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    expect(res.status).toBe(200);

    const body = await res.json() as HookInfo[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('each hook has actionDetail and conditions fields', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    const body = await res.json() as HookInfo[];

    for (const hook of body) {
      expect(hook.actionDetail).toBeDefined();
      expect(typeof hook.actionDetail).toBe('string');
      expect(hook.conditions).toBeDefined();
      expect(Array.isArray(hook.conditions)).toBe(true);
    }
  });

  it('includes the human-verified-auto-push hook with expected shape', async () => {
    const res = await fetch(apiUrl('/api/task-phase-hooks'));
    const body = await res.json() as HookInfo[];

    const hook = body.find(h => h.id === 'human-verified-auto-push');
    expect(hook).toBeDefined();
    expect(hook!.actionType).toBe('send_message');
    expect(hook!.triggerPhase).toBe('HUMAN_VERIFIED');
    expect(hook!.actionDetail).toMatch(/^Send message:/);
    expect(hook!.conditions).toEqual(['Requires active session']);
    expect(hook!.priority).toBe(100);
  });
});

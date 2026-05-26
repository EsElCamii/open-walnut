/**
 * Category 7: Integration Tests (Cross-Subsystem)
 *
 * Tests full end-to-end flows across QMD search, memory tools, working memory,
 * and the HTTP API layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedDailyLog,
  seedTopicFile,
  seedProjectMemory,
  seedGlobalMemory,
  seedWorkingMemory,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';
import { waitForSearchResults } from '../helpers/qmd-wait.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';
import { memoryNotesSearchTool } from '../../src/agent/tools/memory-notes-search-tool.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Seed diverse files for integration tests
  seedTopicFile(
    WALNUT_HOME,
    'kubernetes',
    '---\ntitle: Kubernetes\nupdated: 2026-04-10\ntags: [k8s, infra]\n---\n\n## Overview\n\nKubernetes pod autoscaling with HPA and VPA.\n\n## Key Facts\n- HPA scales based on CPU/memory metrics\n- VPA adjusts resource requests\n- Pod Disruption Budgets protect availability\n',
  );
  seedDailyLog(
    WALNUT_HOME,
    daysAgoStr(0),
    'Worked on Kubernetes cluster scaling and memory v2 integration tests.',
  );
  seedGlobalMemory(
    WALNUT_HOME,
    'Global memory unique marker xylophone_quantum_entanglement_test_marker for integration tests.',
  );
  seedWorkingMemory(
    WALNUT_HOME,
    '# Active Focus\nRunning memory v2 integration tests with unique_wm_marker_12345.\n# User Requests\n_empty_\n# Decisions & Rationale\n_empty_\n# Struggles & Breakthroughs\n_empty_\n# Session Status\n_empty_\n# Open Threads\n_empty_\n# Learnings\n_empty_',
  );

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for QMD indexing
  await waitForSearchResults(
    () => memoryNotesSearch('Kubernetes pod autoscaling'),
    { maxWaitMs: 60000, pollIntervalMs: 2000 },
  );
}, 120000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
}, 30000);

describe('Category 7: Integration Tests', () => {
  // ── 7.1 QMD Search Through HTTP API ──

  it('7.1: QMD search works through HTTP API', async () => {
    const res = await fetch(apiUrl('/api/search?q=Kubernetes&types=memory'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);

    // Data was seeded and indexed — results must exist
    expect(data.results.length).toBeGreaterThan(0);

    const memoryResults = data.results.filter(
      (r: { type: string }) => r.type === 'memory',
    );
    expect(memoryResults.length).toBeGreaterThan(0);
  });

  // ── 7.2 End-to-End: Seed -> Index -> Search -> Get ──

  it('7.2: full pipeline from seed to search to get', async () => {
    // Step 1: Search for the kubernetes topic
    const searchResults = await memoryNotesSearch('pod autoscaling');
    expect(searchResults.length).toBeGreaterThan(0);

    // Step 2: Verify the search result contains the kubernetes topic
    const topResult = searchResults.find((r) =>
      r.filepath.includes('kubernetes') || r.snippet.includes('Kubernetes'),
    );
    expect(topResult).toBeDefined();

    // Step 3: Verify the snippet contains relevant seeded content
    expect(topResult!.snippet).toMatch(/Kubernetes|pod|autoscaling|HPA|VPA/i);
  });

  // ── 7.3 Working Memory NOT Visible in QMD Search ──

  it('7.3: working memory is NOT indexed by QMD search', async () => {
    // Search for the unique marker in working memory
    const results = await memoryNotesSearch('unique_wm_marker_12345');

    // Working memory file lives at memory/working-memory.md which is NOT
    // under any QMD collection path (daily/, topics/, etc.)
    // Check that no result snippet contains the unique marker (filepath may be a qmd:// URI)
    const wmResult = results.find((r) =>
      r.snippet.includes('unique_wm_marker_12345'),
    );
    expect(wmResult).toBeUndefined();
  });

  // ── 7.4 Global MEMORY.md in QMD Search ──

  it('7.4: global MEMORY.md appears in QMD search as source=global', async () => {
    // Search for the unique marker in global memory
    const results = await memoryNotesSearch(
      'xylophone_quantum_entanglement_test_marker',
      ['memory_global'],
    );

    expect(results.length).toBeGreaterThan(0);

    const globalResult = results.find((r) => r.source === 'memory_global');
    expect(globalResult).toBeDefined();
    // QMD uses qmd:// URI format — verify it's from the global collection
    expect(globalResult!.collection).toBe('global');
    // The snippet should contain our unique marker
    expect(globalResult!.snippet).toContain('xylophone_quantum_entanglement_test_marker');
  });
});

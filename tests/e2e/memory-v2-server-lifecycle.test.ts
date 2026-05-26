/**
 * Category 6: Server Lifecycle E2E
 *
 * Tests QMD store initialization, file watcher indexing, server shutdown,
 * working memory ensured on startup, dream directories, and updater reset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedDailyLog,
  seedTopicFile,
  seedGlobalMemory,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';
import { waitForQmdMemoryIndex, waitForSearchResults } from '../helpers/qmd-wait.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  WALNUT_HOME,
  MEMORY_DIR,
  TOPICS_DIR,
  COMPACTION_DIR,
  MEMORY_INDEX_FILE,
  WORKING_MEMORY_FILE,
} from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';

let server: HttpServer;
let port: number;

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });

  // Seed some initial memory files
  seedDailyLog(WALNUT_HOME, daysAgoStr(0), 'Server lifecycle test daily log entry.');
  seedTopicFile(WALNUT_HOME, 'lifecycle-test', 'Server lifecycle topic for testing QMD initialization.');
  seedGlobalMemory(WALNUT_HOME, 'Global memory for lifecycle tests.');

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for initial QMD indexing
  await waitForSearchResults(
    () => memoryNotesSearch('lifecycle test'),
    { maxWaitMs: 60000, pollIntervalMs: 2000 },
  );
}, 120000);

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}, 30000);

describe('Category 6: Server Lifecycle', () => {
  // ── 6.1 QMD Stores Initialize on Server Start ──

  it('6.1: QMD SQLite databases exist after server start', () => {
    const memoryDb = path.join(WALNUT_HOME, 'memory-search.sqlite');
    const notesDb = path.join(WALNUT_HOME, 'notes-search.sqlite');

    expect(fs.existsSync(memoryDb)).toBe(true);
    expect(fs.existsSync(notesDb)).toBe(true);
  });

  it('6.1b: QMD memory store has indexed content', async () => {
    // If QMD is working, searching for seeded content should return results
    const results = await memoryNotesSearch('lifecycle test');
    expect(results.length).toBeGreaterThan(0);
  });

  // ── 6.2 QMD Watcher Detects New Files ──

  it('6.2: watcher detects new files after server start', async () => {
    // Write a new topic file after server is already running
    const newTopicPath = path.join(TOPICS_DIR, 'new-watcher-test.md');
    fs.mkdirSync(path.dirname(newTopicPath), { recursive: true });
    fs.writeFileSync(
      newTopicPath,
      'Brand new topic about testing the QMD file watcher functionality.',
      'utf-8',
    );

    // Wait for watcher debounce (2s) + update + embed
    const found = await waitForSearchResults(
      () => memoryNotesSearch('QMD file watcher functionality', ['memory_topic']),
      { maxWaitMs: 30000, pollIntervalMs: 2000 },
    );

    expect(found).toBe(true);
  }, 45000);

  // ── 6.3 QMD Watcher Ignores Non-Markdown Files ──

  it('6.3: watcher ignores non-markdown files', async () => {
    // Write a binary file
    const pngPath = path.join(TOPICS_DIR, 'image.png');
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Wait a bit for the watcher to potentially process
    await waitForQmdMemoryIndex(4000);

    // Search for the filename content — should not find the binary file
    const results = await memoryNotesSearch('image.png');
    const hasImage = results.some((r) => r.filepath.includes('image.png'));
    expect(hasImage).toBe(false);
  }, 15000);

  // ── 6.5 Working Memory Ensured on Startup ──

  it('6.5: working-memory.md exists after server start', () => {
    expect(fs.existsSync(WORKING_MEMORY_FILE)).toBe(true);

    const content = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
    // Should contain the template headers
    expect(content).toContain('# Active Focus');
    expect(content).toContain('# User Requests');
    expect(content).toContain('# Learnings');
  });

  // ── 6.6 Dream Directories Ensured on Startup ──

  it('6.6: dream directories exist after server start', () => {
    expect(fs.existsSync(TOPICS_DIR)).toBe(true);
    expect(fs.existsSync(COMPACTION_DIR)).toBe(true);
    expect(fs.existsSync(MEMORY_INDEX_FILE)).toBe(true);

    const indexContent = fs.readFileSync(MEMORY_INDEX_FILE, 'utf-8');
    expect(indexContent).toContain('# Memory Index');
  });

  // ── 6.8 Working Memory Updater Reset on Startup ──

  it('6.8: updater state is fresh after server start', async () => {
    // Import the updater and check that shouldUpdateWorkingMemory
    // behaves as if freshly reset
    const {
      shouldUpdateWorkingMemory,
      trackToolCall,
      resetUpdaterState,
    } = await import('../../src/agent/working-memory-updater.js');

    // With fresh state, 5000 tokens is below initialization threshold
    expect(shouldUpdateWorkingMemory(5000)).toBe(false);

    // After 3 tool calls + 10K tokens, should trigger
    trackToolCall();
    trackToolCall();
    trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);

    // Clean up mutated module state so it doesn't leak to other tests
    resetUpdaterState();
  });
});


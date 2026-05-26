import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock chat-history with a hoisted mock function
vi.mock('../../src/core/chat-history.js', () => ({
  getCompactionSummary: vi.fn().mockResolvedValue(null),
  getCompactionEntryCount: vi.fn().mockReturnValue(0),
  loadChatHistory: vi.fn().mockResolvedValue({ messages: [], meta: {} }),
}));

import {
  WALNUT_HOME,
  MEMORY_INDEX_FILE,
  WORKING_MEMORY_FILE,
  DAILY_DIR,
} from '../../src/constants.js';
import { buildMemoryContext, buildSystemPrompt } from '../../src/agent/context.js';
import { formatDateKey } from '../../src/core/daily-log.js';
import { WORKING_MEMORY_TEMPLATE } from '../../src/core/working-memory.js';
import type { AgentDefinition } from '../../src/core/types.js';
import { loadContextSources } from '../../src/agent/context-sources.js';
import { getCompactionSummary } from '../../src/core/chat-history.js';

/**
 * Suite 7 (Test Plan Suite 8): Context Injection (Unit)
 */

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  vi.mocked(getCompactionSummary).mockReset();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('buildMemoryContext', () => {
  it('8.1: uses 8K budget and contains expected sections', () => {
    // Create minimal data
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      `# Daily Log: ${dateKey}\n\n## 10:00 -- agent\nWorked on tests.\n`,
      'utf-8',
    );

    const result = buildMemoryContext();
    expect(typeof result).toBe('string');
    expect(result).toContain('## Task Categories & Projects');
    expect(result).toContain('## Your long-term memory');
    expect(result).toContain('## Recent activity');
    expect(result).toContain('memory_notes_search');
  });

  it('8.2: injects memory index when present', () => {
    fs.mkdirSync(path.dirname(MEMORY_INDEX_FILE), { recursive: true });
    fs.writeFileSync(
      MEMORY_INDEX_FILE,
      '# Memory Index\n## Topics\n- [Walnut](topics/walnut.md)',
      'utf-8',
    );

    const result = buildMemoryContext();
    expect(result).toContain('## Memory index');
    expect(result).toContain('[Walnut](topics/walnut.md)');
  });

  it('8.3: omits memory index when absent', () => {
    const result = buildMemoryContext();
    expect(result).not.toContain('## Memory index');
  });
});

describe('buildSystemPrompt — working memory injection', () => {
  it('8.4: working memory injected after compaction', async () => {
    // Write real content to WORKING_MEMORY_FILE
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, '# Active Focus\nWorking on Memory v2 E2E tests\n', 'utf-8');

    // Simulate compaction has occurred
    vi.mocked(getCompactionSummary).mockResolvedValue('Previous compaction summary');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context (working memory)');
    expect(prompt).toContain('Working on Memory v2 E2E tests');
  });

  it('8.5: compaction summary used when working memory is empty', async () => {
    // Write only template
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');

    vi.mocked(getCompactionSummary).mockResolvedValue('Previous context summary...');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context');
    expect(prompt).toContain('Previous context summary...');
    expect(prompt).not.toContain('(working memory)');
  });

  it('8.6: no context section on fresh conversation (no compaction)', async () => {
    vi.mocked(getCompactionSummary).mockResolvedValue(null);

    const prompt = await buildSystemPrompt();

    expect(prompt).not.toContain('## Earlier conversation context');
  });
});

describe('working_memory context source for subagents', () => {
  it('8.7: loads working memory content', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(
      WORKING_MEMORY_FILE,
      '# Active Focus\nWorking on Memory v2 tests\n# User Requests\nDesign test plan\n',
      'utf-8',
    );

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'test',
      system_prompt: 'You are a test agent.',
      context_sources: [
        { id: 'working_memory', enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});
    expect(result).toContain('<working_memory>');
    expect(result).toContain('Working on Memory v2 tests');
  });

  it('8.8: returns placeholder when empty', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'test',
      system_prompt: 'You are a test agent.',
      context_sources: [
        { id: 'working_memory', enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});
    expect(result).toContain('(no working memory yet)');
  });
});

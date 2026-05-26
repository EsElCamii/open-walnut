/**
 * Category 4: Memory Context Injection E2E
 *
 * Tests system prompt memory index injection, memory context building,
 * compaction working memory integration, and context source loading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedMemoryIndex,
  seedGlobalMemory,
  seedDailyLog,
  seedProjectMemory,
  seedWorkingMemory,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  WALNUT_HOME,
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  WORKING_MEMORY_FILE,
  CHAT_HISTORY_FILE,
} from '../../src/constants.js';
import { buildMemoryContext, buildSystemPrompt } from '../../src/agent/context.js';
import { WORKING_MEMORY_TEMPLATE } from '../../src/core/working-memory.js';
import { loadContextSources } from '../../src/agent/context-sources.js';
import type { AgentDefinition, ContextSourceId } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── 4.1 System Prompt Includes Memory Index ──

describe('System Prompt Memory Index', () => {
  it('4.1: buildMemoryContext includes memory index content', () => {
    const indexContent = `# Memory Index

## Topics
- [Database Architecture](topics/database-architecture.md) -- PostgreSQL + pgBouncer setup
- [API Design](topics/api-design.md) -- REST conventions and versioning

## Active Projects
- work/walnut -- Personal AI butler
`;
    seedMemoryIndex(WALNUT_HOME, indexContent);

    const context = buildMemoryContext(8000);

    expect(context).toContain('## Memory index');
    expect(context).toContain('Database Architecture');
    expect(context).toContain('API Design');
  });

  it('4.1b: memory index is truncated to 4000 chars', () => {
    // Create a large index > 4000 chars
    const lines = Array.from(
      { length: 200 },
      (_, i) => `- [Topic ${i}](topics/topic-${i}.md) -- Description of topic ${i} that adds some extra length`,
    );
    const bigIndex = `# Memory Index\n\n## Topics\n${lines.join('\n')}`;
    seedMemoryIndex(WALNUT_HOME, bigIndex);

    const context = buildMemoryContext(8000);

    // The index section in context should have the truncation marker
    const indexStart = context.indexOf('## Memory index');
    if (indexStart >= 0) {
      const indexSection = context.slice(indexStart);
      // Either truncated with "..." or full — actual limit is 4000 chars, allow small buffer for overhead
      expect(indexSection.length).toBeLessThan(4200);
    }
  });
});

// ── 4.2 System Prompt Includes Memory Context ──

describe('Memory Context', () => {
  it('4.2: buildMemoryContext includes global memory and projects', () => {
    seedGlobalMemory(WALNUT_HOME, 'Global preference: dark mode, concise responses.');
    seedDailyLog(WALNUT_HOME, daysAgoStr(0), 'Today I worked on memory v2 context injection tests.');
    seedProjectMemory(WALNUT_HOME, 'work', 'walnut', 'Walnut is a personal AI butler project.');

    const context = buildMemoryContext(8000);

    expect(context).toContain('## Your long-term memory');
    expect(context).toContain('dark mode, concise responses');
    expect(context).toContain('## Your projects');
    expect(context).toContain('walnut');
    expect(context).toContain('## Recent activity');
    expect(context).toContain('memory v2 context injection tests');

    // Tool mention at the end
    expect(context).toContain('memory_notes_search');
    expect(context).toContain('file_read');
  });
});

// ── 4.5 Post-Compaction System Prompt Includes Working Memory ──

describe('Post-Compaction System Prompt', () => {
  it('4.5: system prompt with compaction summary uses working memory when available', async () => {
    // Seed non-empty working memory
    const wmContent = '# Active Focus\nBuilding memory v2 E2E tests.\n# User Requests\nUser asked for test coverage.\n# Decisions & Rationale\n_empty_\n# Struggles & Breakthroughs\n_empty_\n# Session Status\n_empty_\n# Open Threads\n_empty_\n# Learnings\n_empty_';
    seedWorkingMemory(WALNUT_HOME, wmContent);

    // Seed chat history with a compaction summary to simulate prior compaction
    const chatHistoryStore = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      compactionCount: 1,
      compactionSummary: 'This is a previous compaction summary from LLM.',
      entries: [],
    };
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistoryStore), 'utf-8');

    // Seed minimal config
    const configContent = `user:\n  name: TestUser\n`;
    fs.writeFileSync(WALNUT_HOME + '/config.yaml', configContent, 'utf-8');

    const prompt = await buildSystemPrompt();

    // Should prefer working memory over compaction summary
    expect(prompt).toContain('## Earlier conversation context (working memory)');
    expect(prompt).toContain('Building memory v2 E2E tests');
  });

  it('4.5b: system prompt uses compaction summary when working memory is empty', async () => {
    // Seed empty working memory (template only)
    seedWorkingMemory(WALNUT_HOME, WORKING_MEMORY_TEMPLATE);

    // Seed chat history with a compaction summary
    const chatHistoryStore = {
      version: 2,
      lastUpdated: new Date().toISOString(),
      compactionCount: 1,
      compactionSummary: 'This is the LLM compaction summary.',
      entries: [],
    };
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistoryStore), 'utf-8');

    // Seed minimal config
    const configContent = `user:\n  name: TestUser\n`;
    fs.writeFileSync(WALNUT_HOME + '/config.yaml', configContent, 'utf-8');

    const prompt = await buildSystemPrompt();

    // Should fall back to compaction summary
    expect(prompt).toContain('## Earlier conversation context');
    expect(prompt).toContain('LLM compaction summary');
    // Should NOT show working memory heading
    expect(prompt).not.toContain('## Earlier conversation context (working memory)');
  });
});

// ── 4.6 Context Source: working_memory in Subagent ──

describe('Context Sources', () => {
  it('4.6: working_memory context source loads correctly', async () => {
    const wmContent = '# Active Focus\nTesting context sources for subagents.\n# User Requests\nRun memory E2E tests.\n# Decisions & Rationale\n_empty_\n# Struggles & Breakthroughs\n_empty_\n# Session Status\n_empty_\n# Open Threads\n_empty_\n# Learnings\n_empty_';
    seedWorkingMemory(WALNUT_HOME, wmContent);

    // Create a mock agent definition with working_memory context source
    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      system_prompt: 'You are a test agent.',
      model: 'test',
      context_sources: [
        { id: 'working_memory' as ContextSourceId, enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});

    expect(result).toContain('<working_memory>');
    expect(result).toContain('</working_memory>');
    expect(result).toContain('Testing context sources for subagents');
  });

  it('4.6b: empty working memory returns placeholder text', async () => {
    seedWorkingMemory(WALNUT_HOME, WORKING_MEMORY_TEMPLATE);

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      system_prompt: 'You are a test agent.',
      model: 'test',
      context_sources: [
        { id: 'working_memory' as ContextSourceId, enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});

    expect(result).toContain('<working_memory>');
    expect(result).toContain('(no working memory yet)');
  });
});

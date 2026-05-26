import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

/**
 * Suite 4: Memory Search Core (Unit)
 *
 * QMD models (~2GB) may not be available. We mock the QMD store layer
 * and test the pure search logic: SOURCE_CONFIG weights, guaranteed slots,
 * temporal decay integration, and the 60/40 memory/notes split.
 */

// Mock the qmd-store module to avoid real QMD initialization
vi.mock('../../src/core/qmd-store.js', () => {
  // Configurable mock results per collection
  let mockMemoryResults: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>> = {};
  let mockNotesResults: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>> = {};

  const mockStore = {
    search: vi.fn(async ({ collection, limit }: { query: string; collection: string; limit: number }) => {
      const results = mockMemoryResults[collection] ?? [];
      return results.slice(0, limit);
    }),
  };

  const mockNotesStore = {
    search: vi.fn(async ({ collection, limit }: { query: string; collection: string; limit: number }) => {
      const results = mockNotesResults[collection] ?? [];
      return results.slice(0, limit);
    }),
  };

  return {
    getMemoryStore: vi.fn(async () => mockStore),
    getNotesStore: vi.fn(async () => mockNotesStore),
    closeQmdStores: vi.fn(),
    // Test helpers to configure mock results
    __setMockMemoryResults: (results: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>>) => {
      mockMemoryResults = results;
    },
    __setMockNotesResults: (results: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>>) => {
      mockNotesResults = results;
    },
    __getMockStore: () => mockStore,
    __getMockNotesStore: () => mockNotesStore,
  };
});

import { memoryNotesSearch, type MemorySearchResult } from '../../src/core/memory-search.js';

// Access mock helpers
const qmdStore = await import('../../src/core/qmd-store.js') as unknown as {
  __setMockMemoryResults: (r: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>>) => void;
  __setMockNotesResults: (r: Record<string, Array<{ file: string; title: string; bestChunk: string; score: number }>>) => void;
  __getMockStore: () => { search: ReturnType<typeof vi.fn> };
  __getMockNotesStore: () => { search: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  qmdStore.__setMockMemoryResults({});
  qmdStore.__setMockNotesResults({});
  qmdStore.__getMockStore().search.mockClear();
  qmdStore.__getMockNotesStore().search.mockClear();
});

/** Helper: build a filepath with a date N days ago from today. */
function dateFilepath(daysAgo: number, prefix = '/memory/daily/'): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const key = d.toISOString().slice(0, 10);
  return `${prefix}${key}.md`;
}

describe('memoryNotesSearch', () => {
  it('4.2: default search returns only memory sources (no notes)', async () => {
    qmdStore.__setMockMemoryResults({
      daily: [{ file: dateFilepath(0), title: 'Today', bestChunk: 'Memory v2 search', score: 0.8 }],
    });
    qmdStore.__setMockNotesResults({
      areas: [{ file: '/notes/Areas/Finance/tax.md', title: 'Tax', bestChunk: 'Tax filing 2025', score: 0.9 }],
    });

    const results = await memoryNotesSearch('tax');
    // Should NOT contain any note_ sources (default = memory only)
    for (const r of results) {
      expect(r.source).not.toMatch(/^note_/);
    }
  });

  it('4.3: explicit notes search works', async () => {
    qmdStore.__setMockNotesResults({
      areas: [{ file: '/notes/Areas/Finance/tax.md', title: 'Tax', bestChunk: 'Tax filing 2025', score: 0.9 }],
    });

    const results = await memoryNotesSearch('tax', ['note_areas']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.source === 'note_areas')).toBe(true);
    expect(results.some(r => r.filepath.includes('tax.md'))).toBe(true);
  });

  it('4.4: mixed memory+notes search uses 60/40 split', async () => {
    // Create 10 daily results and 10 notes results
    const dailyResults = Array.from({ length: 10 }, (_, i) => ({
      file: dateFilepath(i),
      title: `Daily ${i}`,
      bestChunk: 'infrastructure setup',
      score: 0.8 - i * 0.01,
    }));
    const notesResults = Array.from({ length: 10 }, (_, i) => ({
      file: `/notes/Areas/notes-${i}.md`,
      title: `Note ${i}`,
      bestChunk: 'infrastructure design',
      score: 0.8 - i * 0.01,
    }));

    qmdStore.__setMockMemoryResults({ daily: dailyResults });
    qmdStore.__setMockNotesResults({ areas: notesResults });

    const results = await memoryNotesSearch('infrastructure', ['daily', 'note_areas'], 10);
    const memCount = results.filter(r => !r.source.startsWith('note_')).length;
    const noteCount = results.filter(r => r.source.startsWith('note_')).length;

    expect(memCount).toBeLessThanOrEqual(Math.ceil(10 * 0.6)); // <= 6
    expect(noteCount).toBeLessThanOrEqual(Math.max(1, 10 - Math.ceil(10 * 0.6))); // <= 4
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('4.5: per-source weights affect ranking (topic > daily)', async () => {
    const todayPath = dateFilepath(0);
    qmdStore.__setMockMemoryResults({
      topic: [{ file: '/memory/topics/devops.md', title: 'DevOps', bestChunk: 'Kubernetes deployment pipeline', score: 0.8 }],
      daily: [{ file: todayPath, title: 'Today', bestChunk: 'Kubernetes deployment pipeline', score: 0.8 }],
    });

    const results = await memoryNotesSearch('Kubernetes deployment pipeline', ['topic', 'daily']);
    const topicResult = results.find(r => r.source === 'topic');
    const dailyResult = results.find(r => r.source === 'daily');

    expect(topicResult).toBeDefined();
    expect(dailyResult).toBeDefined();
    // topic weight 1.5 vs daily weight 1.0 — topic should score higher
    expect(topicResult!.finalScore).toBeGreaterThan(dailyResult!.finalScore);
  });

  it('4.6: temporal decay: recent daily log scores higher than old one', async () => {
    const recentPath = dateFilepath(0);
    const oldPath = dateFilepath(60);
    qmdStore.__setMockMemoryResults({
      daily: [
        { file: recentPath, title: 'Recent', bestChunk: 'Refactored search module', score: 0.8 },
        { file: oldPath, title: 'Old', bestChunk: 'Refactored search module', score: 0.8 },
      ],
    });

    const results = await memoryNotesSearch('Refactored search module', ['daily']);
    const recent = results.find(r => r.filepath === recentPath);
    const old = results.find(r => r.filepath === oldPath);

    expect(recent).toBeDefined();
    expect(old).toBeDefined();
    expect(recent!.finalScore).toBeGreaterThan(old!.finalScore);
  });

  it('4.7: guaranteed minimum slots (topic always gets 2)', async () => {
    // 20 daily results with high scores
    const dailyResults = Array.from({ length: 20 }, (_, i) => ({
      file: dateFilepath(i),
      title: `Daily ${i}`,
      bestChunk: 'deployment',
      score: 0.9 - i * 0.005,
    }));
    // 2 topic results with very low scores
    const topicResults = [
      { file: '/memory/topics/deploy-1.md', title: 'Deploy 1', bestChunk: 'deployment', score: 0.1 },
      { file: '/memory/topics/deploy-2.md', title: 'Deploy 2', bestChunk: 'deployment', score: 0.1 },
    ];

    qmdStore.__setMockMemoryResults({ daily: dailyResults, topic: topicResults });

    const results = await memoryNotesSearch('deployment', ['topic', 'daily'], 8);
    const topicCount = results.filter(r => r.source === 'topic').length;
    // topic minSlots=2, so at least 2 topic results should be guaranteed
    expect(topicCount).toBeGreaterThanOrEqual(2);
  });

  it('4.8: search with no results returns empty array', async () => {
    // All stores return empty
    qmdStore.__setMockMemoryResults({});
    const results = await memoryNotesSearch('xyznonexistenttermzzz');
    expect(results).toEqual([]);
  });

  it('4.11: result shape has all expected fields', async () => {
    qmdStore.__setMockMemoryResults({
      daily: [{ file: dateFilepath(0), title: 'Today', bestChunk: 'some content', score: 0.8 }],
    });

    const results = await memoryNotesSearch('some query', ['daily']);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.filepath).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.snippet).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(typeof r.finalScore).toBe('number');
      expect(typeof r.source).toBe('string');
      expect(typeof r.collection).toBe('string');
    }
  });
});

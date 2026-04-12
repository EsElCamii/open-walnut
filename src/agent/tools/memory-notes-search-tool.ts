/**
 * Agent tool: memory_notes_search
 * Hybrid search across memory and notes via QMD.
 */
import type { ToolDefinition } from '../tools.js';
import { memoryNotesSearch } from '../../core/memory-search.js';

export const memoryNotesSearchTool: ToolDefinition = {
  name: 'memory_notes_search',
  description: 'Search across memory and notes using hybrid search (BM25 + vector + re-ranking). Default: searches memory only. Pass sources to include notes or filter to specific memory types.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Max results to return. Default: 8' },
      sources: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'daily', 'topic', 'project', 'repo', 'compaction', 'global', 'session',
            'note_areas', 'note_projects', 'note_resources', 'note_archive',
          ],
        },
        description: 'Which sources to search. Default: all memory sources (no notes). Add note_* to include notes.',
      },
    },
    required: ['query'],
  },
  async execute(params) {
    const query = params.query as string;
    const limit = (params.limit as number) ?? 8;
    const sources = params.sources as string[] | undefined;
    const results = await memoryNotesSearch(query, sources, limit);
    if (results.length === 0) return 'No results found.';
    return JSON.stringify(results.map(r => ({
      source: r.source,
      title: r.title,
      snippet: r.snippet,
      filepath: r.filepath,
      score: Math.round(r.finalScore * 1000) / 1000,
    })), null, 2);
  },
};

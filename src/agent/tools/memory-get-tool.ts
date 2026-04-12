/**
 * Agent tool: memory_get
 * Read the full content of a memory or notes file by path.
 */
import type { ToolDefinition } from '../tools.js';
import { getMemoryStore, getNotesStore } from '../../core/qmd-store.js';

export const memoryGetTool: ToolDefinition = {
  name: 'memory_get',
  description: 'Read the full content of a memory or notes file by path. Use after memory_notes_search to read complete documents.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path from search results (e.g. "daily/2026-04-12.md")' },
      source_type: { type: 'string', enum: ['memory', 'notes'], description: 'Which store to read from. Default: memory.' },
    },
    required: ['path'],
  },
  async execute(params) {
    const filePath = params.path as string;
    const sourceType = (params.source_type as string) ?? 'memory';
    try {
      const store = sourceType === 'notes' ? await getNotesStore() : await getMemoryStore();
      const doc = await store.get(filePath, { includeBody: true });
      if (!doc || 'error' in doc) return `File not found: ${filePath}`;
      const body = doc.body ?? (await store.getDocumentBody(filePath));
      return body ?? `File found but no content: ${filePath}`;
    } catch (err) {
      return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

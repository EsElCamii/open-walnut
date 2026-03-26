/**
 * Source URI resolver — routes source strings to the correct handler.
 *
 * Routing rules:
 *   /absolute/path   → FileHandler
 *   memory/*         → MemoryHandler
 *   notes/*          → NotesHandler
 */
import path from 'node:path';
import {
  MEMORY_FILE,
  PROJECTS_MEMORY_DIR,
  DAILY_DIR,
  GLOBAL_NOTES_FILE,
  WALNUT_HOME,
} from '../../../constants.js';
import { formatDateKey } from '../../../core/daily-log.js';
import type { ResolvedSource } from './types.js';

/**
 * Resolve a source URI to an absolute file path + handler type.
 * Throws on invalid source patterns.
 */
export function resolveSource(source: string): ResolvedSource {
  // ── Absolute path → FileHandler ──
  if (source.startsWith('/')) {
    return { type: 'file', filePath: source, source };
  }

  // ── memory/* → MemoryHandler ──
  if (source === 'memory/global') {
    return {
      type: 'memory',
      filePath: MEMORY_FILE,
      source,
      variant: 'global',
    };
  }

  if (source.startsWith('memory/project/')) {
    const projectPath = source.slice('memory/project/'.length);
    if (!projectPath) {
      throw new Error('Invalid source: memory/project/ requires a project path (e.g. memory/project/work/api).');
    }
    if (projectPath.includes('..') || projectPath.startsWith('/')) {
      throw new Error(`Invalid project path in source "${source}": path traversal not allowed.`);
    }
    return {
      type: 'memory',
      filePath: path.join(PROJECTS_MEMORY_DIR, projectPath, 'MEMORY.md'),
      source,
      variant: 'project',
      meta: { projectPath },
    };
  }

  if (source === 'memory/project') {
    // List mode — resolved to directory
    return {
      type: 'memory',
      filePath: PROJECTS_MEMORY_DIR,
      source,
      variant: 'project-list',
    };
  }

  if (source === 'memory/daily') {
    // Default to today
    const dateKey = formatDateKey();
    return {
      type: 'memory',
      filePath: path.join(DAILY_DIR, `${dateKey}.md`),
      source,
      variant: 'daily',
      meta: { date: dateKey },
    };
  }

  if (source.startsWith('memory/daily/')) {
    const date = source.slice('memory/daily/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format in source "${source}". Expected YYYY-MM-DD.`);
    }
    const parsed = new Date(date + 'T00:00:00Z');
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid date in source "${source}": "${date}" is not a valid date.`);
    }
    return {
      type: 'memory',
      filePath: path.join(DAILY_DIR, `${date}.md`),
      source,
      variant: 'daily',
      meta: { date },
    };
  }

  // ── notes/* → NotesHandler ──
  if (source === 'notes/global') {
    return {
      type: 'notes',
      filePath: GLOBAL_NOTES_FILE,
      source,
      variant: 'global',
    };
  }

  if (source === 'notes') {
    // List mode
    return {
      type: 'notes',
      filePath: path.join(WALNUT_HOME, 'notes'),
      source,
      variant: 'notes-list',
    };
  }

  if (source.startsWith('notes/')) {
    const name = source.slice('notes/'.length);
    if (!name || name.includes('..')) {
      throw new Error(`Invalid note name in source "${source}".`);
    }
    return {
      type: 'notes',
      filePath: path.join(WALNUT_HOME, 'notes', `${name}.md`),
      source,
      variant: 'named',
      meta: { name },
    };
  }

  throw new Error(
    `Invalid source "${source}". Expected: /absolute/path, memory/global, memory/project/{path}, memory/daily[/YYYY-MM-DD], notes/global, or notes/{name}.`,
  );
}

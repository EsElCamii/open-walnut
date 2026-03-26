/**
 * MemoryHandler — handles memory/global, memory/project/*, memory/daily/* sources.
 * Reuses existing core modules: memory-file, project-memory, daily-log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DAILY_DIR } from '../../../constants.js';
import { readFileWithMeta, writeFileChecked, editFileContent } from '../../../utils/file-ops.js';
import { appendProjectMemory, ensureProjectDir, getAllProjectSummaries } from '../../../core/project-memory.js';
import { appendDailyLog, formatDateKey } from '../../../core/daily-log.js';
import { ensureMemoryFile } from '../../../core/memory-file.js';
import type { FileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

export const memoryHandler: FileHandler = {
  async read(resolved, opts) {
    // Ensure file exists for global memory
    if (resolved.variant === 'global') {
      ensureMemoryFile();
    }

    const meta = await readFileWithMeta(resolved.filePath, opts);
    return {
      content: meta.content,
      content_hash: meta.contentHash,
      total_lines: meta.totalLines,
      showing: meta.showing,
    };
  },

  async write(resolved, content, opts) {
    const mode = opts?.mode ?? 'overwrite';

    if (mode === 'append') {
      return handleMemoryAppend(resolved, content);
    }

    // Overwrite — require hash for memory sources
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for overwrite on memory sources. Read first with files_read.');
    }

    // Ensure directories exist
    if (resolved.variant === 'project' && resolved.meta?.projectPath) {
      ensureProjectDir(resolved.meta.projectPath);
    }
    if (resolved.variant === 'global') {
      ensureMemoryFile();
    }

    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts.contentHash,
    });
    return { status: 'updated', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for editing memory sources. Read first with files_read.');
    }
    if (!oldContent) {
      throw new Error('old_content cannot be empty.');
    }

    const result = await editFileContent(resolved.filePath, oldContent, newContent, {
      expectedHash: opts.contentHash,
      replaceAll: opts?.replaceAll,
    });
    return {
      status: newContent ? 'updated' : 'deleted',
      replacements: result.replacements,
      content_hash: result.contentHash,
    };
  },

  async list(resolved) {
    // memory/project → list all project summaries
    if (resolved.variant === 'project-list') {
      const summaries = getAllProjectSummaries();
      return summaries.map((s) => ({
        source: `memory/project/${s.path}`,
        name: s.name,
        description: s.description,
      }));
    }

    // memory/daily (used from files_list prefix="memory/daily")
    // List all daily log files, most recent first
    const items: FilesListItem[] = [];
    try {
      const files = fs.readdirSync(DAILY_DIR)
        .filter((f) => f.endsWith('.md') && !f.endsWith('.bak.md'))
        .sort()
        .reverse();
      for (const f of files) {
        const date = f.replace('.md', '');
        const stat = fs.statSync(path.join(DAILY_DIR, f));
        items.push({
          source: `memory/daily/${date}`,
          name: date,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    } catch {
      // DAILY_DIR doesn't exist yet
    }
    return items;
  },
};

function handleMemoryAppend(resolved: ResolvedSource, content: string): FilesWriteResult {
  if (resolved.variant === 'global') {
    throw new Error('Global memory does not support append. Use overwrite mode.');
  }

  const writtenTo: string[] = [];

  if (resolved.variant === 'daily') {
    const projectPath = resolved.meta?.projectPath;
    appendDailyLog(content, 'agent', projectPath);
    writtenTo.push('daily');

    if (projectPath) {
      const result = appendProjectMemory(projectPath, content, 'agent');
      writtenTo.push('project');
      return {
        status: 'saved',
        content_hash: '',
        written_to: writtenTo,
        summary: result.summary,
      };
    }
    return { status: 'saved', content_hash: '', written_to: writtenTo };
  }

  if (resolved.variant === 'project') {
    const projectPath = resolved.meta?.projectPath;
    if (!projectPath) {
      throw new Error('project_path is required for project memory append.');
    }

    // Write to both project memory and daily log
    appendDailyLog(content, 'agent', projectPath);
    writtenTo.push('daily');

    const result = appendProjectMemory(projectPath, content, 'agent');
    writtenTo.push('project');

    return {
      status: 'saved',
      content_hash: '',
      written_to: writtenTo,
      summary: result.summary,
    };
  }

  throw new Error(`Append not supported for memory variant "${resolved.variant}".`);
}

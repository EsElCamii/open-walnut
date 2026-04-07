/**
 * NotesHandler — handles notes/global and notes/{name} sources.
 *
 * notes/global → GLOBAL_NOTES_FILE (~/.open-walnut/notes/global-notes.md)
 * notes/{name} → ~/.open-walnut/notes/{name}.md
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GLOBAL_NOTES_FILE, NOTES_DIR } from '../../../constants.js';
import {
  readFileWithMeta,
  writeFileChecked,
  editFileContent,
  computeContentHash,
} from '../../../utils/file-ops.js';
import type { FileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

export const notesHandler: FileHandler = {
  async read(resolved, opts) {
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
      // Append to notes: just add content at the end
      await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
      await fsp.appendFile(resolved.filePath, content, 'utf-8');
      const updated = await fsp.readFile(resolved.filePath, 'utf-8');
      return {
        status: 'appended',
        content_hash: computeContentHash(updated),
      };
    }

    // Notes allow first-write without hash (simpler UX for new notes).
    // Memory sources always require hash (shared state, stale-write prevention).
    if (!opts?.contentHash) {
      // Allow overwrite without hash only if file doesn't exist (new note)
      try {
        await fsp.access(resolved.filePath);
        throw new Error('content_hash is required for overwrite on existing notes. Read first with files_read.');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // File doesn't exist — allow creation without hash
      }
    }

    await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts?.contentHash,
    });
    return { status: opts?.contentHash ? 'updated' : 'created', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for editing notes. Read first with files_read.');
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
    const items: FilesListItem[] = [];

    // Always include global notes if it exists
    try {
      const stat = fs.statSync(GLOBAL_NOTES_FILE);
      items.push({
        source: 'notes/global',
        name: 'Global Notes',
        description: 'Personal scratchpad on the home page',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // global-notes.md doesn't exist yet
    }

    // List named notes from NOTES_DIR
    try {
      // Exclude global-notes.md — it's listed as the synthetic "notes/global" entry above
      const globalBase = path.basename(GLOBAL_NOTES_FILE);
      const files = fs.readdirSync(NOTES_DIR)
        .filter((f) => f.endsWith('.md') && f !== globalBase)
        .sort();
      for (const f of files) {
        const name = f.replace('.md', '');
        const stat = fs.statSync(path.join(NOTES_DIR, f));
        items.push({
          source: `notes/${name}`,
          name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    } catch {
      // notes/ directory doesn't exist yet
    }

    return items;
  },
};

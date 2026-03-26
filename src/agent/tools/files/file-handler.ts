/**
 * FileHandler — handles /absolute/path sources.
 * Reuses file-ops for read/write/edit, read-tool image handling for images.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  readFileWithMeta,
  writeFileChecked,
  editFileContent,
  computeContentHash,
} from '../../../utils/file-ops.js';
import { compressForApi, MAX_BASE64_BYTES } from '../../../utils/image-compress.js';
import { log } from '../../../logging/index.js';
import type { ToolResultContent } from '../../tools.js';
import type { FileHandler as IFileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE_SIZE = 20 * 1024 * 1024;

export const fileHandler: IFileHandler = {
  async read(resolved, opts): Promise<FilesReadResult | ToolResultContent> {
    const filePath = resolved.filePath;
    const stat = await fsp.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Image files: return inline base64
    if (IMAGE_EXTENSIONS.has(ext)) {
      const mime = MIME_MAP[ext] ?? 'application/octet-stream';

      if (!VISION_MIME_TYPES.has(mime)) {
        return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — not a vision-supported format`;
      }
      if (stat.size > MAX_INLINE_IMAGE_SIZE) {
        return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — too large for inline vision`;
      }

      const rawBuffer = await fsp.readFile(filePath);
      const { buffer, mimeType } = await compressForApi(rawBuffer, mime);
      const base64 = buffer.toString('base64');

      if (base64.length > MAX_BASE64_BYTES) {
        log.agent.warn('image too large after compression', { filePath, sizeMB: (buffer.length / 1_048_576).toFixed(1) });
        return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — too large for inline vision even after compression`;
      }

      const sizeNote = buffer.length !== rawBuffer.length
        ? ` (compressed from ${(rawBuffer.length / 1_048_576).toFixed(1)} MB to ${(buffer.length / 1_048_576).toFixed(1)} MB)`
        : '';

      return [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `[Read image: ${filePath}] (${stat.size} bytes, ${mime})${sizeNote}` },
      ];
    }

    // Text files
    const meta = await readFileWithMeta(filePath, opts);
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
      await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
      await fsp.appendFile(resolved.filePath, content, 'utf-8');
      const updated = await fsp.readFile(resolved.filePath, 'utf-8');
      return {
        status: 'appended',
        content_hash: computeContentHash(updated),
      };
    }

    // Overwrite — hash is optional for file sources
    await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts?.contentHash,
    });
    return { status: 'updated', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    if (!oldContent) {
      throw new Error('old_content cannot be empty.');
    }

    const result = await editFileContent(resolved.filePath, oldContent, newContent, {
      expectedHash: opts?.contentHash,
      replaceAll: opts?.replaceAll,
    });
    return {
      status: newContent ? 'updated' : 'deleted',
      replacements: result.replacements,
      content_hash: result.contentHash,
    };
  },

  async list(resolved) {
    const dirPath = resolved.filePath;
    const items: FilesListItem[] = [];

    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const stat = await fsp.stat(fullPath);
      items.push({
        source: fullPath,
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    return items;
  },
};

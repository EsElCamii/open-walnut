/**
 * FileHandler — handles /absolute/path sources.
 *
 * Full read pipeline:
 *   isBlockedDevicePath → stat (ENOENT → findSimilarFile) → isDirectory →
 *   isBinaryByExtension → IMAGE → PDF → isBinaryFile(content) → readText
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  readFileWithMeta,
  writeFileChecked,
  editFileContent,
  computeContentHash,
  FileTooLargeError,
} from '../../../utils/file-ops.js';
import { compressForApi, MAX_BASE64_BYTES } from '../../../utils/image-compress.js';
import { isBinaryByExtension, isBinaryFile } from '../../../utils/binary-detect.js';
import { findSimilarFile } from '../../../utils/file-utils.js';
import { readPDF, extractPDFPages, parsePDFPageRange } from '../../../utils/pdf.js';
import {
  IMAGE_EXTENSIONS,
  MIME_MAP,
  VISION_MIME_TYPES,
  MAX_INLINE_IMAGE_SIZE,
  isPDFExtension,
  isBlockedDevicePath,
  PDF_MAX_PAGES_PER_READ,
} from '../../../constants/files.js';
import { log } from '../../../logging/index.js';
import type { ToolResultContent } from '../../tools.js';
import type {
  FileHandler as IFileHandler,
  ResolvedSource,
  FilesReadResult,
  FilesWriteResult,
  FilesEditResult,
  FilesListItem,
} from './types.js';

export const fileHandler: IFileHandler = {
  async read(resolved, opts): Promise<FilesReadResult | ToolResultContent> {
    const filePath = resolved.filePath;

    // ── Blocked device paths ──
    if (isBlockedDevicePath(filePath)) {
      return `Error: "${filePath}" is a blocked device path and cannot be read.`;
    }

    // ── Stat (ENOENT → findSimilarFile suggestion) ──
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const similar = findSimilarFile(filePath);
        const suggestion = similar ? ` Did you mean "${similar}"?` : '';
        return `Error: File not found: "${filePath}".${suggestion}`;
      }
      throw err;
    }

    // ── Directory check ──
    if (stat.isDirectory()) {
      return `Error: "${filePath}" is a directory, not a file. Use files_list to list directory contents.`;
    }

    const ext = path.extname(filePath).toLowerCase();

    // ── Binary by extension (excludes image/PDF which have their own handlers) ──
    if (isBinaryByExtension(filePath)) {
      return `Error: "${filePath}" is a binary file (${ext}) and cannot be read as text.`;
    }

    // ── Image files → inline base64 ──
    if (IMAGE_EXTENSIONS.has(ext)) {
      return readImage(filePath, ext, stat.size);
    }

    // ── PDF files ──
    if (isPDFExtension(ext)) {
      return readPDFFile(filePath, opts?.pages);
    }

    // ── Binary content check (first 8 KB) ──
    if (stat.size > 0) {
      try {
        if (await isBinaryFile(filePath)) {
          return `Error: "${filePath}" appears to be a binary file and cannot be read as text.`;
        }
      } catch {
        // If binary check fails, try reading as text anyway
      }
    }

    // ── Text files ──
    try {
      const meta = await readFileWithMeta(filePath, opts);
      return {
        content: meta.content,
        content_hash: meta.contentHash,
        total_lines: meta.totalLines,
        showing: meta.showing,
        _mtimeMs: meta.mtimeMs,
        _isPartialView: meta.isPartialView,
      };
    } catch (err: unknown) {
      if (err instanceof FileTooLargeError) {
        return `Error: ${err.message}`;
      }
      throw err;
    }
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

// ── Image reading ──

async function readImage(filePath: string, ext: string, size: number): Promise<ToolResultContent> {
  const mime = MIME_MAP[ext] ?? 'application/octet-stream';

  if (!VISION_MIME_TYPES.has(mime)) {
    return `[Image file: ${filePath}] (${size} bytes, ${mime}) — not a vision-supported format`;
  }
  if (size > MAX_INLINE_IMAGE_SIZE) {
    return `[Image file: ${filePath}] (${size} bytes, ${mime}) — too large for inline vision`;
  }

  const rawBuffer = await fsp.readFile(filePath);
  const { buffer, mimeType } = await compressForApi(rawBuffer, mime);
  const base64 = buffer.toString('base64');

  if (base64.length > MAX_BASE64_BYTES) {
    log.agent.warn('image too large after compression', { filePath, sizeMB: (buffer.length / 1_048_576).toFixed(1) });
    return `[Image file: ${filePath}] (${size} bytes, ${mime}) — too large for inline vision even after compression`;
  }

  const sizeNote = buffer.length !== rawBuffer.length
    ? ` (compressed from ${(rawBuffer.length / 1_048_576).toFixed(1)} MB to ${(buffer.length / 1_048_576).toFixed(1)} MB)`
    : '';

  return [
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
    { type: 'text', text: `[Read image: ${filePath}] (${size} bytes, ${mime})${sizeNote}` },
  ];
}

// ── PDF reading ──

async function readPDFFile(filePath: string, pages?: string): Promise<ToolResultContent> {
  // If pages param specified → extract as images
  if (pages) {
    const range = parsePDFPageRange(pages);
    if (!range) {
      return `Error: Invalid page range "${pages}". Use formats like "5", "1-10", or "3-".`;
    }

    const pageCount = range.lastPage === Infinity
      ? Infinity
      : range.lastPage - range.firstPage + 1;
    if (pageCount > PDF_MAX_PAGES_PER_READ) {
      return `Error: Requested ${pageCount} pages exceeds maximum of ${PDF_MAX_PAGES_PER_READ} per read.`;
    }

    const result = await extractPDFPages(filePath, range);
    if (!result.success) {
      return `Error reading PDF: ${result.error.message}`;
    }

    const blocks: unknown[] = [];
    const entries = (await fsp.readdir(result.data.outputDir)).filter(f => f.endsWith('.jpg')).sort();
    for (const entry of entries) {
      const imgPath = path.join(result.data.outputDir, entry);
      const imgBuf = await fsp.readFile(imgPath);
      const base64 = imgBuf.toString('base64');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
    }
    blocks.push({ type: 'text', text: `[PDF: ${filePath}] ${result.data.count} pages extracted (${(result.data.originalSize / 1024).toFixed(0)} KB)` });
    return blocks as ToolResultContent;
  }

  // No pages → read entire PDF as base64 document block
  const result = await readPDF(filePath);
  if (!result.success) {
    return `Error reading PDF: ${result.error.message}`;
  }

  return [
    { type: 'document' as 'text', source: { type: 'base64', media_type: 'application/pdf', data: result.data.base64 } } as unknown as { type: 'text'; text: string },
    { type: 'text', text: `[PDF: ${filePath}] (${(result.data.originalSize / 1024).toFixed(0)} KB)` },
  ];
}

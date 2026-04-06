/**
 * Binary file detection utilities.
 *
 * Two detection methods:
 *   1. isBinaryByExtension — fast extension-based check (excludes images and PDFs
 *      which have their own handlers).
 *   2. isBinaryFile — reads first 8 KB of file content for null-byte / non-printable check.
 */
import fsp from 'node:fs/promises';
import {
  hasBinaryExtension,
  isBinaryContent,
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
} from '../constants/files.js';

/**
 * Check if a file is binary by extension, excluding image and PDF extensions
 * (those have dedicated read handlers).
 */
export function isBinaryByExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext)) return false;
  return hasBinaryExtension(filePath);
}

/**
 * Read the first 8 KB of a file and check if content is binary.
 * Returns false for empty files.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    if (bytesRead === 0) return false;
    return isBinaryContent(buf.subarray(0, bytesRead));
  } finally {
    await fd.close();
  }
}

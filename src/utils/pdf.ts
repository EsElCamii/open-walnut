/**
 * PDF reading utilities — page count, page extraction, base64 reading.
 *
 * Ported from Claude Code's src/utils/pdf.ts and src/utils/pdfUtils.ts.
 * Uses pdfinfo/pdftoppm (poppler-utils) for page extraction.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  PDF_TARGET_RAW_SIZE,
  PDF_MAX_EXTRACT_SIZE,
  PDF_MAX_PAGES_PER_READ,
} from '../constants/files.js';

const execFileAsync = promisify(execFile);

// ── Page range parsing ──

/**
 * Parse a page range string into firstPage/lastPage numbers.
 * "5" → { firstPage: 5, lastPage: 5 }
 * "1-10" → { firstPage: 1, lastPage: 10 }
 * "3-" → { firstPage: 3, lastPage: Infinity }
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10);
    if (isNaN(first) || first < 1) return null;
    return { firstPage: first, lastPage: Infinity };
  }

  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) {
    const page = parseInt(trimmed, 10);
    if (isNaN(page) || page < 1) return null;
    return { firstPage: page, lastPage: page };
  }

  const first = parseInt(trimmed.slice(0, dashIndex), 10);
  const last = parseInt(trimmed.slice(dashIndex + 1), 10);
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null;
  }
  return { firstPage: first, lastPage: last };
}

// ── pdftoppm availability ──

let _pdftoppmAvailable: boolean | undefined;

export async function isPdftoppmAvailable(): Promise<boolean> {
  if (_pdftoppmAvailable !== undefined) return _pdftoppmAvailable;
  try {
    await execFileAsync('pdftoppm', ['-v'], { timeout: 5000 });
    _pdftoppmAvailable = true;
  } catch (err: unknown) {
    // pdftoppm prints version to stderr and may exit non-zero on some versions
    const stderr = (err as { stderr?: string }).stderr ?? '';
    _pdftoppmAvailable = stderr.length > 0;
  }
  return _pdftoppmAvailable;
}

// ── Page count ──

export async function getPDFPageCount(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [filePath], { timeout: 10_000 });
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) return null;
    const count = parseInt(match[1]!, 10);
    return isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

// ── PDF types ──

export type PDFError = {
  reason: 'empty' | 'too_large' | 'password_protected' | 'corrupted' | 'unknown' | 'unavailable';
  message: string;
};

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError };

// ── Read PDF as base64 ──

export async function readPDF(filePath: string): Promise<
  PDFResult<{ base64: string; originalSize: number }>
> {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size === 0) {
      return { success: false, error: { reason: 'empty', message: `PDF file is empty: ${filePath}` } };
    }
    if (stat.size > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file (${(stat.size / 1_048_576).toFixed(1)} MB) exceeds maximum allowed size of ${(PDF_TARGET_RAW_SIZE / 1_048_576).toFixed(0)} MB.`,
        },
      };
    }

    const buf = await fsp.readFile(filePath);
    const header = buf.subarray(0, 5).toString('ascii');
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: { reason: 'corrupted', message: `File is not a valid PDF (missing %PDF- header): ${filePath}` },
      };
    }

    return {
      success: true,
      data: { base64: buf.toString('base64'), originalSize: stat.size },
    };
  } catch (e: unknown) {
    return {
      success: false,
      error: { reason: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

// ── Extract PDF pages as JPEG images ──

export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<{ outputDir: string; count: number; originalSize: number }>> {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size === 0) {
      return { success: false, error: { reason: 'empty', message: `PDF file is empty: ${filePath}` } };
    }
    if (stat.size > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for extraction (${(PDF_MAX_EXTRACT_SIZE / 1_048_576).toFixed(0)} MB).`,
        },
      };
    }

    const available = await isPdftoppmAvailable();
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: 'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler`) to enable PDF page rendering.',
        },
      };
    }

    const outputDir = path.join(os.tmpdir(), `walnut-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(outputDir, { recursive: true });

    const prefix = path.join(outputDir, 'page');
    const args = ['-jpeg', '-r', '100'];
    if (options?.firstPage) args.push('-f', String(options.firstPage));
    if (options?.lastPage && options.lastPage !== Infinity) args.push('-l', String(options.lastPage));
    args.push(filePath, prefix);

    try {
      await execFileAsync('pdftoppm', args, { timeout: 120_000 });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (/password/i.test(stderr)) {
        return { success: false, error: { reason: 'password_protected', message: 'PDF is password-protected.' } };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return { success: false, error: { reason: 'corrupted', message: 'PDF file is corrupted or invalid.' } };
      }
      return { success: false, error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` } };
    }

    const entries = await fsp.readdir(outputDir);
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort();
    if (imageFiles.length === 0) {
      return { success: false, error: { reason: 'corrupted', message: 'pdftoppm produced no output pages.' } };
    }

    return {
      success: true,
      data: { outputDir, count: imageFiles.length, originalSize: stat.size },
    };
  } catch (e: unknown) {
    return {
      success: false,
      error: { reason: 'unknown', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * files_glob and files_grep — file search tools.
 *
 * files_glob: Find files by glob pattern (wraps Node's fs.globSync).
 * files_grep: Search file contents by regex with optional context lines.
 */
import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ── Shared constants ──

const MAX_GLOB_RESULTS = 1000; // ~1000 paths fits within typical LLM context limits
const MAX_GREP_RESULTS_DEFAULT = 50; // grep returns full line content per match, so lower limit than glob
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
const BINARY_CHECK_BYTES = 8192; // matches the heuristic used by the `file` command

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  '.next',
  '.cache',
]);

// ── Helpers ──

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some((p) => SKIP_DIRS.has(p));
}

// ── files_glob ──

export interface GlobResult {
  matches: string[];
  count: number;
  truncated: boolean;
}

export function filesGlob(pattern: string, basePath?: string): GlobResult {
  const cwd = basePath || process.cwd();

  const rawMatches = globSync(pattern, { cwd });

  // Resolve to absolute paths, filter SKIP_DIRS, cache mtime for sort
  const absolutePaths: { abs: string; mtimeMs: number }[] = [];
  for (const rel of rawMatches) {
    if (shouldSkipPath(rel)) continue;
    const abs = path.resolve(cwd, rel);
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        absolutePaths.push({ abs, mtimeMs: st.mtimeMs });
      }
    } catch {
      // stat failed (broken symlink etc.) — skip
    }
  }

  // Sort by mtime descending (most recently modified first) using cached mtimeMs
  absolutePaths.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const truncated = absolutePaths.length > MAX_GLOB_RESULTS;
  const entries = truncated ? absolutePaths.slice(0, MAX_GLOB_RESULTS) : absolutePaths;
  const matches = entries.map((e) => e.abs);

  return { matches, count: matches.length, truncated };
}

// ── files_grep ──

export interface GrepMatchContent {
  file: string;
  line: number;
  text: string;
  context_before?: string[];
  context_after?: string[];
}

export interface GrepResultContent {
  matches: GrepMatchContent[];
  total_matches: number;
  files_searched: number;
  truncated: boolean;
}

export interface GrepResultFiles {
  files: string[];
  count: number;
  truncated: boolean;
}

export interface GrepResultCount {
  counts: { file: string; count: number }[];
  total: number;
  truncated: boolean;
}

export type GrepResult = GrepResultContent | GrepResultFiles | GrepResultCount;

export interface GrepOptions {
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files' | 'count';
  context?: number;
  case_insensitive?: boolean;
  max_results?: number;
}

export function filesGrep(pattern: string, opts: GrepOptions = {}): GrepResult {
  const outputMode = opts.output_mode ?? 'files';
  const contextLines = opts.context ?? 0;
  const maxResults = opts.max_results ?? MAX_GREP_RESULTS_DEFAULT;
  const basePath = opts.path || process.cwd();

  // Build regex
  const flags = opts.case_insensitive ? 'i' : '';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
  }

  // Determine files to search
  const filesToSearch = collectFiles(basePath, opts.glob);

  // Search
  const contentMatches: GrepMatchContent[] = [];
  const fileMatches = new Set<string>();
  const countMap = outputMode === 'count' ? new Map<string, number>() : null;
  let totalMatches = 0;
  let truncated = false;
  let filesSearched = 0;

  for (const filePath of filesToSearch) {
    if (truncated) break;

    // Skip large files
    try {
      const st = statSync(filePath);
      if (st.size > MAX_FILE_SIZE) continue;
    } catch {
      continue;
    }

    // Read and check binary
    let buf: Buffer;
    try {
      buf = readFileSync(filePath);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) continue;

    filesSearched++;

    const content = buf.toString('utf-8');
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    let fileMatchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        fileMatchCount++;
        totalMatches++;

        if (outputMode === 'content' && !truncated) {
          const before = contextLines > 0
            ? lines.slice(Math.max(0, i - contextLines), i)
            : undefined;
          const after = contextLines > 0
            ? lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines))
            : undefined;

          contentMatches.push({
            file: filePath,
            line: i + 1,
            text: lines[i],
            ...(before && before.length > 0 ? { context_before: before } : {}),
            ...(after && after.length > 0 ? { context_after: after } : {}),
          });

          if (contentMatches.length >= maxResults) {
            truncated = true;
            break;
          }
        }

        if (outputMode === 'files') {
          fileMatches.add(filePath);
          if (fileMatches.size >= maxResults) {
            truncated = true;
          }
          break; // one match per file is enough for files mode
        }
      }
    }

    // Bookkeeping: skip files mode (already added+broke inside inner loop)
    if (fileMatchCount > 0 && outputMode !== 'files') {
      fileMatches.add(filePath);
      if (countMap) {
        countMap.set(filePath, fileMatchCount);
      }
    }

    // Truncation for count mode: cap on number of files reported
    if (outputMode === 'count' && countMap && countMap.size >= maxResults) {
      truncated = true;
    }
  }

  switch (outputMode) {
    case 'content':
      return {
        matches: contentMatches,
        total_matches: totalMatches,
        files_searched: filesSearched,
        truncated,
      };
    case 'files':
      return {
        files: [...fileMatches],
        count: fileMatches.size,
        truncated,
      };
    case 'count':
      return {
        counts: [...(countMap ?? new Map()).entries()].map(([file, count]) => ({ file, count })),
        total: totalMatches,
        truncated,
      };
    default:
      return { files: [...fileMatches], count: fileMatches.size, truncated };
  }
}

/** Collect files to search based on basePath and optional glob filter. */
function collectFiles(basePath: string, globPattern?: string): string[] {
  // If basePath is a file, just search that one file
  try {
    const st = statSync(basePath);
    if (st.isFile()) return [basePath];
  } catch {
    return [];
  }

  // It's a directory — use glob to find files
  let searchGlob = '**/*';
  if (globPattern) {
    // Smart wrapping: if glob doesn't contain path separators or **, prepend **/
    if (!globPattern.includes('/') && !globPattern.includes('**')) {
      searchGlob = `**/${globPattern}`;
    } else {
      searchGlob = globPattern;
    }
  }

  const rawMatches = globSync(searchGlob, { cwd: basePath });
  const files: string[] = [];

  for (const rel of rawMatches) {
    if (shouldSkipPath(rel)) continue;
    const abs = path.resolve(basePath, rel);
    try {
      const st = statSync(abs);
      if (st.isFile()) files.push(abs);
    } catch {
      // skip
    }
  }

  return files;
}

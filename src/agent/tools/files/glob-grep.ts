/**
 * files_glob and files_grep — file search tools.
 *
 * files_glob: Find files by glob pattern (wraps Node's fs.globSync).
 * files_grep: Search file contents by regex with optional context lines.
 */
import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isBinaryContent, SKIP_DIRS, MAX_GREP_FILE_SIZE } from '../../../constants/files.js';

// ── Shared constants ──

const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_RESULTS_DEFAULT = 50;

/** Common file-type → glob mappings (aligned with ripgrep --type). */
const TYPE_GLOBS: Record<string, string> = {
  js: '*.{js,jsx,mjs,cjs}',
  ts: '*.{ts,tsx,mts,cts}',
  py: '*.{py,pyi}',
  rust: '*.rs',
  go: '*.go',
  java: '*.java',
  c: '*.{c,h}',
  cpp: '*.{cpp,cxx,cc,hpp,hxx,hh}',
  css: '*.{css,scss,less}',
  html: '*.{htm,html}',
  json: '*.{json,jsonl}',
  yaml: '*.{yaml,yml}',
  md: '*.{md,markdown}',
  sh: '*.{sh,bash,zsh}',
  ruby: '*.rb',
  php: '*.php',
  swift: '*.swift',
  kotlin: '*.{kt,kts}',
};

// ── Helpers ──

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
  /** File type filter (e.g. "js", "ts", "py"). Maps to common extensions. Mutually exclusive with glob. */
  type?: string;
  output_mode?: 'content' | 'files' | 'count';
  /** Symmetric context lines before AND after each match. */
  context?: number;
  /** Lines before each match (-B). Overrides context for before direction. */
  context_before?: number;
  /** Lines after each match (-A). Overrides context for after direction. */
  context_after?: number;
  case_insensitive?: boolean;
  max_results?: number;
  /** Skip first N entries before collecting results. */
  offset?: number;
  /** Enable multiline: . matches newlines, patterns can span lines. */
  multiline?: boolean;
}

export function filesGrep(pattern: string, opts: GrepOptions = {}): GrepResult {
  const outputMode = opts.output_mode ?? 'files';
  const ctxBefore = opts.context_before ?? opts.context ?? 0;
  const ctxAfter = opts.context_after ?? opts.context ?? 0;
  const maxResults = opts.max_results ?? MAX_GREP_RESULTS_DEFAULT;
  const offset = opts.offset ?? 0;
  const basePath = opts.path || process.cwd();

  // Resolve type → glob (mutually exclusive)
  if (opts.type && opts.glob) {
    throw new Error('Cannot specify both "type" and "glob". Use one or the other.');
  }
  const effectiveGlob = opts.type
    ? (TYPE_GLOBS[opts.type] ?? `*.${opts.type}`)
    : opts.glob;

  // Build regex — multiline adds g (exec loop), m (^ $ match line boundaries), s (. matches \n)
  let flags = opts.case_insensitive ? 'i' : '';
  if (opts.multiline) flags += 'gms';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
  }

  // Collect up to effectiveLimit entries, then slice by offset at the end
  const effectiveLimit = maxResults + offset;

  // Determine files to search
  const filesToSearch = collectFiles(basePath, effectiveGlob);

  // Search state
  const contentMatches: GrepMatchContent[] = [];
  const fileMatchesArr: string[] = []; // ordered list for offset slicing
  const fileMatchesSet = new Set<string>();
  const countMap = outputMode === 'count' ? new Map<string, number>() : null;
  let totalMatches = 0;
  let truncated = false;
  let filesSearched = 0;

  for (const filePath of filesToSearch) {
    if (truncated) break;

    // Skip large files
    try {
      const st = statSync(filePath);
      if (st.size > MAX_GREP_FILE_SIZE) continue;
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
    if (isBinaryContent(buf)) continue;

    filesSearched++;

    const content = buf.toString('utf-8');
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop(); // trailing empty line from split
    }

    let fileMatchCount = 0;

    if (opts.multiline) {
      // ── Multiline mode: match against full content ──
      regex.lastIndex = 0;
      let execResult: RegExpExecArray | null;

      while ((execResult = regex.exec(content)) !== null) {
        fileMatchCount++;
        totalMatches++;

        if (outputMode === 'content' && !truncated) {
          const matchStart = execResult.index;
          const matchEnd = matchStart + execResult[0].length;
          // Line numbers (1-indexed) from character offset
          const lineNum = content.slice(0, matchStart).split('\n').length;
          const endLineNum = content.slice(0, matchEnd).split('\n').length;

          const before = ctxBefore > 0
            ? lines.slice(Math.max(0, lineNum - 1 - ctxBefore), lineNum - 1)
            : undefined;
          const after = ctxAfter > 0
            ? lines.slice(endLineNum, Math.min(lines.length, endLineNum + ctxAfter))
            : undefined;

          contentMatches.push({
            file: filePath,
            line: lineNum,
            text: execResult[0],
            ...(before && before.length > 0 ? { context_before: before } : {}),
            ...(after && after.length > 0 ? { context_after: after } : {}),
          });

          if (contentMatches.length >= effectiveLimit) {
            truncated = true;
            break;
          }
        }

        if (outputMode === 'files') {
          if (!fileMatchesSet.has(filePath)) {
            fileMatchesSet.add(filePath);
            fileMatchesArr.push(filePath);
            if (fileMatchesArr.length >= effectiveLimit) {
              truncated = true;
            }
          }
          break; // one match per file is enough for files mode
        }

        // Prevent infinite loop on zero-length matches
        if (execResult[0].length === 0) {
          regex.lastIndex++;
        }
      }
    } else {
      // ── Single-line mode: match per line ──
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          fileMatchCount++;
          totalMatches++;

          if (outputMode === 'content' && !truncated) {
            const before = ctxBefore > 0
              ? lines.slice(Math.max(0, i - ctxBefore), i)
              : undefined;
            const after = ctxAfter > 0
              ? lines.slice(i + 1, Math.min(lines.length, i + 1 + ctxAfter))
              : undefined;

            contentMatches.push({
              file: filePath,
              line: i + 1,
              text: lines[i],
              ...(before && before.length > 0 ? { context_before: before } : {}),
              ...(after && after.length > 0 ? { context_after: after } : {}),
            });

            if (contentMatches.length >= effectiveLimit) {
              truncated = true;
              break;
            }
          }

          if (outputMode === 'files') {
            if (!fileMatchesSet.has(filePath)) {
              fileMatchesSet.add(filePath);
              fileMatchesArr.push(filePath);
              if (fileMatchesArr.length >= effectiveLimit) {
                truncated = true;
              }
            }
            break; // one match per file is enough
          }
        }
      }
    }

    // Bookkeeping for non-files modes (files mode already added inside inner loop)
    if (fileMatchCount > 0 && outputMode !== 'files') {
      if (!fileMatchesSet.has(filePath)) {
        fileMatchesSet.add(filePath);
        fileMatchesArr.push(filePath);
      }
      if (countMap) {
        countMap.set(filePath, fileMatchCount);
      }
    }

    // Truncation for count mode: cap on number of files reported
    if (outputMode === 'count' && countMap && countMap.size >= effectiveLimit) {
      truncated = true;
    }
  }

  // Apply offset and build result
  switch (outputMode) {
    case 'content': {
      const sliced = contentMatches.slice(offset);
      return {
        matches: sliced,
        total_matches: totalMatches,
        files_searched: filesSearched,
        truncated,
      };
    }
    case 'files': {
      const sliced = fileMatchesArr.slice(offset);
      return {
        files: sliced,
        count: sliced.length,
        truncated,
      };
    }
    case 'count': {
      const entries = [...(countMap ?? new Map()).entries()].map(([file, count]) => ({ file, count }));
      const sliced = entries.slice(offset);
      return {
        counts: sliced,
        total: totalMatches,
        truncated,
      };
    }
    default:
      return { files: fileMatchesArr.slice(offset), count: Math.max(0, fileMatchesArr.length - offset), truncated };
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { executeTool } from '../../../src/agent/tools.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: create a directory tree for testing ──

async function createTree(base: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(base, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }
}

// ── files_glob ──

describe('files_glob', () => {
  it('finds files by extension pattern', async () => {
    const dir = path.join(tmpDir, 'project');
    await createTree(dir, {
      'src/a.ts': 'const a = 1;',
      'src/b.ts': 'const b = 2;',
      'src/c.js': 'const c = 3;',
      'README.md': '# Readme',
    });

    const result = await executeTool('files_glob', { pattern: '**/*.ts', path: dir });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.matches.every((m: string) => m.endsWith('.ts'))).toBe(true);
  });

  it('uses cwd when path not specified', async () => {
    // cwd is the project root which always contains package.json
    const result = await executeTool('files_glob', { pattern: 'package.json' });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.matches.some((m: string) => m.includes('package.json'))).toBe(true);
    expect(parsed.truncated).toBe(false);
  });

  it('returns empty for no matches', async () => {
    const dir = path.join(tmpDir, 'empty');
    await fs.mkdir(dir, { recursive: true });

    const result = await executeTool('files_glob', { pattern: '**/*.xyz', path: dir });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(0);
    expect(parsed.matches).toEqual([]);
  });

  it('skips node_modules and .git', async () => {
    const dir = path.join(tmpDir, 'skiptest');
    await createTree(dir, {
      'src/a.ts': 'const a = 1;',
      'node_modules/pkg/index.ts': 'module',
      '.git/hooks/pre-commit.ts': 'exit 0', // .ts file inside .git/ to verify SKIP_DIRS
    });

    const result = await executeTool('files_glob', { pattern: '**/*.ts', path: dir });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0]).toContain('src/a.ts');
  });

  it('returns absolute paths', async () => {
    const dir = path.join(tmpDir, 'abspath');
    await createTree(dir, { 'file.txt': 'hello' });

    const result = await executeTool('files_glob', { pattern: '**/*', path: dir });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches[0]).toMatch(/^\//);
  });

  it('returns error for missing pattern', async () => {
    const result = await executeTool('files_glob', { pattern: '' });
    expect(result).toContain('Error');
  });
});

// ── files_grep ──

describe('files_grep', () => {
  let searchDir: string;

  beforeEach(async () => {
    searchDir = path.join(tmpDir, 'search');
    await createTree(searchDir, {
      'src/main.ts': 'function hello() {\n  console.log("Hello World");\n  return true;\n}\n',
      'src/utils.ts': 'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
      'src/index.js': 'const x = require("./main");\nhello();\n',
      'docs/readme.md': '# Hello Project\nThis is a hello world project.\n',
    });
  });

  it('finds files matching pattern (files mode)', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'hello',
      path: searchDir,
      case_insensitive: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.files.length).toBeGreaterThanOrEqual(2);
    expect(parsed.count).toBeGreaterThanOrEqual(2);
  });

  it('returns content with line numbers', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      output_mode: 'content',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0].file).toBeTruthy();
    expect(parsed.matches[0].line).toBeGreaterThan(0);
    expect(parsed.matches[0].text).toContain('Hello');
    expect(parsed.files_searched).toBeGreaterThan(0);
  });

  it('returns content with context lines', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'console\\.log',
      path: searchDir,
      output_mode: 'content',
      context: 1,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    const match = parsed.matches[0];
    expect(match.context_before).toBeDefined();
    expect(match.context_before.length).toBeGreaterThan(0);
    expect(match.context_after).toBeDefined();
    expect(match.context_after.length).toBeGreaterThan(0);
  });

  it('returns per-file counts (count mode)', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      output_mode: 'count',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.counts.length).toBeGreaterThan(0);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.counts[0].file).toBeTruthy();
    expect(parsed.counts[0].count).toBeGreaterThan(0);
  });

  it('filters by glob pattern', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      glob: '*.ts',
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    // Only .ts files should match
    expect(parsed.files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  it('supports case insensitive search', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'HELLO',
      path: searchDir,
      case_insensitive: true,
      output_mode: 'count',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('case sensitive by default', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'HELLO',
      path: searchDir,
      output_mode: 'count',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.total).toBe(0);
  });

  it('searches a single file', async () => {
    const filePath = path.join(searchDir, 'src/main.ts');
    const result = await executeTool('files_grep', {
      pattern: 'function',
      path: filePath,
      output_mode: 'content',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    expect(parsed.matches[0].file).toBe(filePath);
  });

  it('respects max_results', async () => {
    // Create a file with many matches
    const manyDir = path.join(tmpDir, 'many');
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`);
    await createTree(manyDir, { 'big.txt': lines.join('\n') });

    const result = await executeTool('files_grep', {
      pattern: 'match',
      path: manyDir,
      output_mode: 'content',
      max_results: 5,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(5);
    expect(parsed.truncated).toBe(true);
  });

  it('returns error for invalid regex', async () => {
    const result = await executeTool('files_grep', {
      pattern: '[invalid',
      path: searchDir,
    });
    expect(result).toContain('Error');
    expect(result).toContain('Invalid regex');
  });

  it('returns empty for no matches', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'zzznonexistent',
      path: searchDir,
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  it('skips binary files', async () => {
    const binDir = path.join(tmpDir, 'bintest');
    await fs.mkdir(binDir, { recursive: true });
    // Create a "binary" file with NUL bytes
    const binContent = Buffer.from('hello\x00world');
    await fs.writeFile(path.join(binDir, 'binary.dat'), binContent);
    // Create a text file
    await fs.writeFile(path.join(binDir, 'text.txt'), 'hello world', 'utf-8');

    const result = await executeTool('files_grep', {
      pattern: 'hello',
      path: binDir,
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(1);
    expect(parsed.files[0]).toContain('text.txt');
  });

  // ── type parameter ──

  it('filters by type parameter', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      type: 'ts',
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  it('type falls back to *.{type} for unknown types', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'hello',
      path: searchDir,
      type: 'md',
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.files.every((f: string) => /\.(md|markdown)$/.test(f))).toBe(true);
  });

  it('errors when both type and glob specified', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      type: 'ts',
      glob: '*.ts',
    });
    expect(result).toContain('Error');
    expect(result).toContain('Cannot specify both');
  });

  // ── context_before / context_after (-B / -A) ──

  it('supports asymmetric context (context_before only)', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'console\\.log',
      path: searchDir,
      output_mode: 'content',
      context_before: 1,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    const match = parsed.matches[0];
    expect(match.context_before).toBeDefined();
    expect(match.context_before.length).toBeGreaterThan(0);
    expect(match.context_after).toBeUndefined();
  });

  it('supports asymmetric context (context_after only)', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'console\\.log',
      path: searchDir,
      output_mode: 'content',
      context_after: 1,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    const match = parsed.matches[0];
    expect(match.context_before).toBeUndefined();
    expect(match.context_after).toBeDefined();
    expect(match.context_after.length).toBeGreaterThan(0);
  });

  it('context_before/after override symmetric context', async () => {
    const result = await executeTool('files_grep', {
      pattern: 'console\\.log',
      path: searchDir,
      output_mode: 'content',
      context: 2,
      context_before: 1,
      context_after: 0,
    });
    const parsed = JSON.parse(result as string);
    const match = parsed.matches[0];
    // context_before=1 overrides context=2 for before
    expect(match.context_before).toBeDefined();
    expect(match.context_before.length).toBe(1);
    // context_after=0 overrides context=2 for after
    expect(match.context_after).toBeUndefined();
  });

  // ── offset ──

  it('offset skips first N entries in content mode', async () => {
    const manyDir = path.join(tmpDir, 'offset');
    const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`);
    await createTree(manyDir, { 'data.txt': lines.join('\n') });

    // Without offset: first match is line 1
    const resultNoOffset = await executeTool('files_grep', {
      pattern: 'match',
      path: manyDir,
      output_mode: 'content',
      max_results: 3,
    });
    const parsedNo = JSON.parse(resultNoOffset as string);
    expect(parsedNo.matches[0].line).toBe(1);

    // With offset=5: first returned match is line 6
    const resultOffset = await executeTool('files_grep', {
      pattern: 'match',
      path: manyDir,
      output_mode: 'content',
      max_results: 3,
      offset: 5,
    });
    const parsedOff = JSON.parse(resultOffset as string);
    expect(parsedOff.matches[0].line).toBe(6);
    expect(parsedOff.matches.length).toBe(3);
  });

  it('offset skips first N files in files mode', async () => {
    const multiDir = path.join(tmpDir, 'offset-files');
    await createTree(multiDir, {
      'a.txt': 'match here',
      'b.txt': 'match here',
      'c.txt': 'match here',
      'd.txt': 'match here',
    });

    const resultAll = await executeTool('files_grep', {
      pattern: 'match',
      path: multiDir,
      output_mode: 'files',
    });
    const parsedAll = JSON.parse(resultAll as string);
    expect(parsedAll.count).toBe(4);

    const resultOffset = await executeTool('files_grep', {
      pattern: 'match',
      path: multiDir,
      output_mode: 'files',
      offset: 2,
    });
    const parsedOff = JSON.parse(resultOffset as string);
    expect(parsedOff.count).toBe(2);
  });

  // ── multiline ──

  it('matches patterns spanning multiple lines with multiline mode', async () => {
    const mlDir = path.join(tmpDir, 'multiline');
    await createTree(mlDir, {
      'code.ts': 'function foo() {\n  return 42;\n}\n',
    });

    const result = await executeTool('files_grep', {
      pattern: 'function.*\\{\\n.*return',
      path: mlDir,
      output_mode: 'content',
      multiline: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    expect(parsed.matches[0].text).toContain('function');
    expect(parsed.matches[0].text).toContain('return');
    expect(parsed.matches[0].line).toBe(1);
  });

  it('multiline mode with context', async () => {
    const mlDir = path.join(tmpDir, 'multiline-ctx');
    await createTree(mlDir, {
      'code.ts': 'const a = 1;\nfunction foo() {\n  return 42;\n}\nconst b = 2;\n',
    });

    const result = await executeTool('files_grep', {
      pattern: 'function.*\\{\\n.*return',
      path: mlDir,
      output_mode: 'content',
      multiline: true,
      context_after: 1,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    // Match starts at line 2 ("function foo()"), spans to line 3 ("  return 42;")
    // context_after=1 should give line after the match end (line 4: "}")
    expect(parsed.matches[0].context_after).toBeDefined();
    expect(parsed.matches[0].context_after.length).toBeGreaterThan(0);
  });

  // ── CRLF handling ──

  it('handles CRLF line endings', async () => {
    const crlfDir = path.join(tmpDir, 'crlf');
    await createTree(crlfDir, {
      'windows.txt': 'line one\r\nline two\r\nline three\r\n',
    });

    const result = await executeTool('files_grep', {
      pattern: 'line two',
      path: crlfDir,
      output_mode: 'content',
      context: 1,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matches.length).toBe(1);
    expect(parsed.matches[0].line).toBe(2);
    expect(parsed.matches[0].text).toBe('line two');
    expect(parsed.matches[0].context_before).toEqual(['line one']);
    expect(parsed.matches[0].context_after).toEqual(['line three']);
  });

  // ── smart glob wrapping ──

  it('smart-wraps glob without path separator into **/', async () => {
    // When glob="*.ts" (no / or **), it should be auto-wrapped to "**/*.ts"
    // This means it should find .ts files in subdirectories too
    const result = await executeTool('files_grep', {
      pattern: 'Hello',
      path: searchDir,
      glob: '*.ts',
      output_mode: 'files',
    });
    const parsed = JSON.parse(result as string);
    // Files are in src/ subdirectory — smart wrapping should find them
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files.every((f: string) => f.endsWith('.ts'))).toBe(true);
  });

  // ── truncation in files/count modes ──

  it('truncates files mode at max_results', async () => {
    const manyFilesDir = path.join(tmpDir, 'many-files');
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.txt`] = 'findme here';
    }
    await createTree(manyFilesDir, files);

    const result = await executeTool('files_grep', {
      pattern: 'findme',
      path: manyFilesDir,
      output_mode: 'files',
      max_results: 3,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(3);
    expect(parsed.truncated).toBe(true);
  });

  it('truncates count mode at max_results files', async () => {
    const manyFilesDir = path.join(tmpDir, 'many-count');
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.txt`] = 'findme here\nfindme again';
    }
    await createTree(manyFilesDir, files);

    const result = await executeTool('files_grep', {
      pattern: 'findme',
      path: manyFilesDir,
      output_mode: 'count',
      max_results: 3,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.counts.length).toBe(3);
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.every((c: { count: number }) => c.count === 2)).toBe(true);
  });
});

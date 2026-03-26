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
});

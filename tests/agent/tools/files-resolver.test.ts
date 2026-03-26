import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import {
  MEMORY_FILE,
  PROJECTS_MEMORY_DIR,
  GLOBAL_NOTES_FILE,
} from '../../../src/constants.js';
import { resolveSource } from '../../../src/agent/tools/files/resolver.js';

describe('resolveSource', () => {
  it('resolves absolute paths to file type', () => {
    const r = resolveSource('/tmp/test.txt');
    expect(r.type).toBe('file');
    expect(r.filePath).toBe('/tmp/test.txt');
  });

  it('resolves memory/global', () => {
    const r = resolveSource('memory/global');
    expect(r.type).toBe('memory');
    expect(r.variant).toBe('global');
    expect(r.filePath).toBe(MEMORY_FILE);
  });

  it('resolves memory/project/{path}', () => {
    const r = resolveSource('memory/project/work/api');
    expect(r.type).toBe('memory');
    expect(r.variant).toBe('project');
    expect(r.meta?.projectPath).toBe('work/api');
    expect(r.filePath).toBe(path.join(PROJECTS_MEMORY_DIR, 'work/api', 'MEMORY.md'));
  });

  it('resolves memory/project (list mode)', () => {
    const r = resolveSource('memory/project');
    expect(r.type).toBe('memory');
    expect(r.variant).toBe('project-list');
  });

  it('resolves memory/daily (today)', () => {
    const r = resolveSource('memory/daily');
    expect(r.type).toBe('memory');
    expect(r.variant).toBe('daily');
    expect(r.meta?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('resolves memory/daily/2026-03-25', () => {
    const r = resolveSource('memory/daily/2026-03-25');
    expect(r.type).toBe('memory');
    expect(r.variant).toBe('daily');
    expect(r.meta?.date).toBe('2026-03-25');
    expect(r.filePath).toContain('2026-03-25.md');
  });

  it('rejects invalid daily date format', () => {
    expect(() => resolveSource('memory/daily/not-a-date')).toThrow('Invalid date format');
  });

  it('resolves notes/global', () => {
    const r = resolveSource('notes/global');
    expect(r.type).toBe('notes');
    expect(r.variant).toBe('global');
    expect(r.filePath).toBe(GLOBAL_NOTES_FILE);
  });

  it('resolves notes/{name}', () => {
    const r = resolveSource('notes/recipes');
    expect(r.type).toBe('notes');
    expect(r.variant).toBe('named');
    expect(r.meta?.name).toBe('recipes');
    expect(r.filePath).toContain('recipes.md');
  });

  it('resolves notes (list mode)', () => {
    const r = resolveSource('notes');
    expect(r.type).toBe('notes');
    expect(r.variant).toBe('notes-list');
  });

  it('rejects notes with path traversal', () => {
    expect(() => resolveSource('notes/../etc/passwd')).toThrow('Invalid note name');
  });

  it('rejects empty memory/project/ path', () => {
    expect(() => resolveSource('memory/project/')).toThrow('requires a project path');
  });

  it('rejects memory/project with path traversal', () => {
    expect(() => resolveSource('memory/project/../../etc/passwd')).toThrow('path traversal');
  });

  it('rejects invalid date values', () => {
    expect(() => resolveSource('memory/daily/2026-99-99')).toThrow('not a valid date');
  });

  it('rejects unknown source patterns', () => {
    expect(() => resolveSource('unknown/source')).toThrow('Invalid source');
  });
});

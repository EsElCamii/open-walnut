/**
 * Tests for notes/instructions URI in the files_* tool group.
 *
 * Covers:
 * - resolveSource('notes/instructions') routes correctly (type=notes, variant=instructions)
 * - notesHandler.write creates both AGENTS.md and CLAUDE.md (mirror)
 * - notesHandler.edit mirrors edits to CLAUDE.md
 * - notesHandler.edit self-heals diverged CLAUDE.md
 * - notesHandler.list includes notes/instructions, excludes AGENTS.md/CLAUDE.md from named notes
 * - Append mode mirrors to CLAUDE.md
 *
 * Every test fails if the notes/instructions feature code is reverted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('notes-instructions-test'));

import {
  WALNUT_HOME,
  NOTES_DIR,
  NOTES_AGENTS_FILE,
  NOTES_CLAUDE_FILE,
} from '../../../src/constants.js';
import { resolveSource } from '../../../src/agent/tools/files/resolver.js';
import { notesHandler } from '../../../src/agent/tools/files/notes-handler.js';
import { computeContentHash } from '../../../src/utils/file-ops.js';

// ── Setup / Teardown ──

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(NOTES_DIR, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ─── Test 1: Resolver ────────────────────────────────────────────────

describe('resolveSource — notes/instructions routing', () => {
  it('routes notes/instructions to type=notes, variant=instructions', () => {
    const r = resolveSource('notes/instructions');
    expect(r.type).toBe('notes');
    expect(r.variant).toBe('instructions');
    expect(r.filePath).toBe(NOTES_AGENTS_FILE);
    expect(r.filePath).toMatch(/AGENTS\.md$/);
  });

  it('does NOT route notes/instructions to the named variant', () => {
    const r = resolveSource('notes/instructions');
    // If the special route were missing, it would fall through to the catch-all
    // notes/{name} route and get variant='named'
    expect(r.variant).not.toBe('named');
    // Should not have meta.name (that's for named notes)
    expect(r.meta).toBeUndefined();
  });

  it('still routes notes/other to named variant', () => {
    const r = resolveSource('notes/other');
    expect(r.type).toBe('notes');
    expect(r.variant).toBe('named');
    expect(r.meta?.name).toBe('other');
  });
});

// ─── Test 2: Write creates both AGENTS.md and CLAUDE.md ─────────────

describe('notesHandler.write — instructions dual-write', () => {
  it('creates both AGENTS.md and CLAUDE.md on new write', async () => {
    const resolved = resolveSource('notes/instructions');
    const content = '# Agent Instructions\n\nDo helpful things.\n';

    const result = await notesHandler.write(resolved, content, {});
    expect(result.status).toBe('created');
    expect(result.content_hash).toBeTruthy();

    // Verify AGENTS.md
    const agentsContent = await fs.readFile(NOTES_AGENTS_FILE, 'utf-8');
    expect(agentsContent).toBe(content);

    // Verify CLAUDE.md mirror
    const claudeContent = await fs.readFile(NOTES_CLAUDE_FILE, 'utf-8');
    expect(claudeContent).toBe(content);
  });

  it('overwrite with hash updates both files', async () => {
    const resolved = resolveSource('notes/instructions');
    const initial = '# Initial\n';

    // Create
    const createResult = await notesHandler.write(resolved, initial, {});

    // Update with hash
    const updated = '# Updated Instructions\n\nNew content.\n';
    const updateResult = await notesHandler.write(resolved, updated, {
      contentHash: createResult.content_hash,
    });
    expect(updateResult.status).toBe('updated');

    // Both files should have updated content
    const agentsContent = await fs.readFile(NOTES_AGENTS_FILE, 'utf-8');
    expect(agentsContent).toBe(updated);

    const claudeContent = await fs.readFile(NOTES_CLAUDE_FILE, 'utf-8');
    expect(claudeContent).toBe(updated);
  });

  it('does NOT mirror for non-instructions variant', async () => {
    const resolved = resolveSource('notes/my-note');
    const content = '# My Note\n\nPersonal stuff.\n';

    await notesHandler.write(resolved, content, {});

    // CLAUDE.md should not exist (no mirror for named notes)
    await expect(fs.access(NOTES_CLAUDE_FILE)).rejects.toThrow();
  });
});

// ─── Test 3: Edit mirrors to CLAUDE.md ──────────────────────────────

describe('notesHandler.edit — instructions mirror', () => {
  it('mirrors edit to CLAUDE.md when old_content matches', async () => {
    const resolved = resolveSource('notes/instructions');
    const initial = '# Instructions\n\nBe helpful.\nBe concise.\n';

    // Write initial content
    const writeResult = await notesHandler.write(resolved, initial, {});

    // Edit: replace "Be helpful." with "Be extremely helpful."
    const editResult = await notesHandler.edit(
      resolved,
      'Be helpful.',
      'Be extremely helpful.',
      { contentHash: writeResult.content_hash },
    );
    expect(editResult.status).toBe('updated');
    expect(editResult.replacements).toBe(1);

    // Verify AGENTS.md has the edit
    const agentsContent = await fs.readFile(NOTES_AGENTS_FILE, 'utf-8');
    expect(agentsContent).toContain('Be extremely helpful.');
    expect(agentsContent).not.toContain('\nBe helpful.\n');

    // Verify CLAUDE.md also has the edit
    const claudeContent = await fs.readFile(NOTES_CLAUDE_FILE, 'utf-8');
    expect(claudeContent).toContain('Be extremely helpful.');
    expect(claudeContent).not.toContain('\nBe helpful.\n');
  });
});

// ─── Test 4: Edit self-heals diverged CLAUDE.md ─────────────────────

describe('notesHandler.edit — diverged CLAUDE.md self-heal', () => {
  it('re-syncs CLAUDE.md from AGENTS.md when old_content not found in CLAUDE.md', async () => {
    const resolved = resolveSource('notes/instructions');
    const initial = '# Instructions\n\nLine A.\nLine B.\n';

    // Write initial content (both files identical)
    const writeResult = await notesHandler.write(resolved, initial, {});

    // Manually diverge CLAUDE.md (simulate external edit)
    await fs.writeFile(NOTES_CLAUDE_FILE, '# Diverged\n\nCompletely different content.\n', 'utf-8');

    // Now edit AGENTS.md via the handler — old_content "Line A." won't be found in CLAUDE.md
    const editResult = await notesHandler.edit(
      resolved,
      'Line A.',
      'Line Alpha.',
      { contentHash: writeResult.content_hash },
    );
    expect(editResult.status).toBe('updated');

    // AGENTS.md should have the edited content
    const agentsContent = await fs.readFile(NOTES_AGENTS_FILE, 'utf-8');
    expect(agentsContent).toContain('Line Alpha.');
    expect(agentsContent).not.toContain('Line A.');

    // CLAUDE.md should be re-synced from AGENTS.md (self-healed)
    const claudeContent = await fs.readFile(NOTES_CLAUDE_FILE, 'utf-8');
    expect(claudeContent).toBe(agentsContent);
    // The diverged content should be gone
    expect(claudeContent).not.toContain('Diverged');
    expect(claudeContent).not.toContain('Completely different');
  });
});

// ─── Test 5: List includes instructions, excludes AGENTS.md/CLAUDE.md ─

describe('notesHandler.list — instructions entry and exclusion', () => {
  it('includes notes/instructions when AGENTS.md exists', async () => {
    // Create AGENTS.md
    await fs.writeFile(NOTES_AGENTS_FILE, '# Instructions\n', 'utf-8');
    // Create CLAUDE.md
    await fs.writeFile(NOTES_CLAUDE_FILE, '# Instructions\n', 'utf-8');
    // Create a normal named note
    await fs.writeFile(path.join(NOTES_DIR, 'test-note.md'), '# Test Note\n', 'utf-8');

    const resolved = resolveSource('notes');
    const items = await notesHandler.list(resolved);

    // Should have notes/instructions entry
    const instructionsEntry = items.find((i) => i.source === 'notes/instructions');
    expect(instructionsEntry).toBeDefined();
    expect(instructionsEntry!.name).toBe('Instructions');
    expect(instructionsEntry!.description).toContain('AGENTS.md');

    // Should have notes/test-note entry
    const testNoteEntry = items.find((i) => i.source === 'notes/test-note');
    expect(testNoteEntry).toBeDefined();

    // Should NOT have notes/AGENTS or notes/CLAUDE as named notes
    const agentsEntry = items.find((i) => i.source === 'notes/AGENTS');
    expect(agentsEntry).toBeUndefined();
    const claudeEntry = items.find((i) => i.source === 'notes/CLAUDE');
    expect(claudeEntry).toBeUndefined();
  });

  it('does not include notes/instructions when AGENTS.md does not exist', async () => {
    // Only create a normal note, no AGENTS.md
    await fs.writeFile(path.join(NOTES_DIR, 'solo-note.md'), '# Solo\n', 'utf-8');

    const resolved = resolveSource('notes');
    const items = await notesHandler.list(resolved);

    const instructionsEntry = items.find((i) => i.source === 'notes/instructions');
    expect(instructionsEntry).toBeUndefined();

    const soloEntry = items.find((i) => i.source === 'notes/solo-note');
    expect(soloEntry).toBeDefined();
  });
});

// ─── Test 6: Append mode mirrors to CLAUDE.md ──────────────────────

describe('notesHandler.write — append mode with instructions', () => {
  it('append mirrors to CLAUDE.md', async () => {
    const resolved = resolveSource('notes/instructions');
    const initial = '# Instructions\n\nBase content.\n';

    // Create initial content
    await notesHandler.write(resolved, initial, {});

    // Append
    const appendContent = '\n## New Section\n\nAppended stuff.\n';
    const appendResult = await notesHandler.write(resolved, appendContent, {
      mode: 'append',
    });
    expect(appendResult.status).toBe('appended');

    // AGENTS.md should have initial + appended
    const agentsContent = await fs.readFile(NOTES_AGENTS_FILE, 'utf-8');
    expect(agentsContent).toContain('Base content.');
    expect(agentsContent).toContain('Appended stuff.');

    // CLAUDE.md should also have initial + appended (mirror receives the full file)
    const claudeContent = await fs.readFile(NOTES_CLAUDE_FILE, 'utf-8');
    expect(claudeContent).toContain('Base content.');
    expect(claudeContent).toContain('Appended stuff.');

    // Both files should be identical
    expect(claudeContent).toBe(agentsContent);
  });

  it('append does NOT mirror for non-instructions variant', async () => {
    const resolved = resolveSource('notes/my-note');
    const initial = '# Note\n\nFirst.\n';
    await notesHandler.write(resolved, initial, {});

    await notesHandler.write(resolved, '\nMore stuff.\n', { mode: 'append' });

    // CLAUDE.md should not exist
    await expect(fs.access(NOTES_CLAUDE_FILE)).rejects.toThrow();
  });
});

/**
 * Unit tests for the session self-report parsing in session-hooks/builtins.ts.
 *
 * These cover the pure helpers that turn a side_question self-report into a
 * Tier-1 task.summary: extractField (label extraction, tolerant of bold markers
 * and missing fields) and summaryFromSelfReport (field selection + formatting).
 */
import { describe, it, expect } from 'vitest';
import { extractField, summaryFromSelfReport } from '../../src/core/session-hooks/builtins.js';

const SAMPLE = `WHAT_I_DID: Added READ_ONLY_TOOL_NAMES allowlist in tools.ts and wired triage to use it.
STATUS: succeeded — build passes, triage can no longer create tasks.
CHANGES_TRIED: First tried a denylist, abandoned it because new tools would default to writable.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run /verify on an ephemeral server to confirm no write tools leak.
BLOCKERS: none
USER_INTENT: workflow-command — user said "proceed".
VERIFIED: assumed — have not run the e2e test yet.
ARTIFACTS: src/agent/tools.ts, src/web/server.ts`;

describe('extractField', () => {
  it('extracts a single-line field', () => {
    expect(extractField(SAMPLE, 'PHASE_SIGNAL')).toBe('implement-done');
  });

  it('extracts a field that contains an em-dash and punctuation', () => {
    expect(extractField(SAMPLE, 'STATUS')).toBe('succeeded — build passes, triage can no longer create tasks.');
  });

  it('returns empty string for an absent field', () => {
    expect(extractField(SAMPLE, 'NONEXISTENT')).toBe('');
  });

  it('tolerates **bold** label markers', () => {
    const bolded = `**WHAT_I_DID**: Fixed the parser.\n**STATUS**: succeeded — ok.`;
    expect(extractField(bolded, 'WHAT_I_DID')).toBe('Fixed the parser.');
    expect(extractField(bolded, 'STATUS')).toBe('succeeded — ok.');
  });

  it('stops at the next ALL-CAPS label (does not bleed into following field)', () => {
    expect(extractField(SAMPLE, 'BLOCKERS')).toBe('none');
  });

  it('captures a multi-line field up to the next label', () => {
    const multi = `WHAT_I_DID: line one\nline two continues here.\nSTATUS: succeeded — done.`;
    expect(extractField(multi, 'WHAT_I_DID')).toBe('line one\nline two continues here.');
  });

  it('does NOT truncate at an unrelated ALL-CAPS WORD: line (only known labels terminate)', () => {
    // "API:" / "TODO:" are not self-report labels — a wrapped field must keep them.
    const wrapped = `NEXT_STEPS: Update the sender.\nAPI: must bump the version too.\nTODO: write docs.\nBLOCKERS: none`;
    expect(extractField(wrapped, 'NEXT_STEPS')).toBe(
      'Update the sender.\nAPI: must bump the version too.\nTODO: write docs.',
    );
    // The real next label still terminates correctly.
    expect(extractField(wrapped, 'BLOCKERS')).toBe('none');
  });
});

describe('summaryFromSelfReport', () => {
  it('builds a 3-field Tier-1 summary (Session Summary + Status + Next Steps)', () => {
    const out = summaryFromSelfReport(SAMPLE);
    expect(out).toContain('**Session Summary**:');
    expect(out).toContain('**Current Agent Status**:');
    expect(out).toContain('**Next Steps**:');
    // Session Summary merges WHAT_I_DID + CHANGES_TRIED.
    expect(out).toContain('READ_ONLY_TOOL_NAMES allowlist');
    expect(out).toContain('First tried a denylist');
  });

  it('omits fields that are absent rather than emitting empty labels', () => {
    const partial = `STATUS: blocked — port conflict.\nPHASE_SIGNAL: verify-fail`;
    const out = summaryFromSelfReport(partial);
    expect(out).toBe('**Current Agent Status**: blocked — port conflict.');
    expect(out).not.toContain('Session Summary');
    expect(out).not.toContain('Next Steps');
  });

  it('returns empty string when the report has no usable fields', () => {
    expect(summaryFromSelfReport('garbage with no labels')).toBe('');
  });
});

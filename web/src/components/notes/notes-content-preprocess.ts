/**
 * Notes editor content normalization for two real-vault markdown shapes that
 * markdown-it (the tiptap-markdown parser) mishandles. Both transforms are
 * SYMMETRIC: `normalizeForEditor` is applied to the markdown BEFORE it reaches
 * the editor, and the editor's serializers (table-kit padding + the
 * EmptyAwareTaskItem below) emit the original byte shape on save — so a note the
 * user never edited round-trips byte-clean.
 *
 * 1. ORPHAN CHECKBOX — a bare `- [ ]` / `- [x]` line with NO text after the
 *    bracket. `markdown-it-task-lists` only recognizes a task item when the
 *    content starts with `"[ ] "` (bracket + space + MORE); a bare `- [ ]`
 *    renders as a literal "[ ]" bullet. We append a zero-width space (U+200B)
 *    so the parser sees `[ ] ​` and emits a real (empty) checkbox. The ZWSP is
 *    stripped again on serialize by EmptyAwareTaskItem.
 */

/** Zero-width space — invisible filler that makes an empty task item parse. */
export const ZWSP = '​';

/** A line that is exactly an (indented) `- [ ]` / `* [x]` checkbox with no text. */
const ORPHAN_CHECKBOX_RE = /^(\s*[-*+] \[[ xX]\])\s*$/;

/**
 * Make markdown safe for the editor's parser. Currently: append a ZWSP to
 * orphan checkbox lines so they parse as empty task items instead of literal
 * "[ ]" bullets. Idempotent and reversible (serialize strips the ZWSP).
 */
export function normalizeForEditor(md: string): string {
  if (!md) return md;
  // Fast path: nothing to do if there's no checkbox-looking line at all.
  if (!md.includes('[ ]') && !md.includes('[x]') && !md.includes('[X]')) return md;
  return md
    .split('\n')
    .map((line) => (ORPHAN_CHECKBOX_RE.test(line) ? line + ' ' + ZWSP : line))
    .join('\n');
}

/** Strip any stray ZWSP we (or a paste) introduced — used as a save-side guard. */
export function stripZwsp(md: string): string {
  return md.includes(ZWSP) ? md.replace(new RegExp(ZWSP, 'g'), '') : md;
}

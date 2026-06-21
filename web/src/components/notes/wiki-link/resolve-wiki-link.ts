/**
 * Client-side wiki-link target resolution (§2.2 Obsidian-native, FROZEN).
 *
 * Mirrors the backend resolution order so a click lands on the same note the
 * index would key the edge on. The id is display-only here — navigation is by
 * `path`; the id never appears in link text.
 *
 *   1. Path form `[[folder/Title]]` (target contains `/`) → match by exact path
 *      (case-insensitive, `.md` optional), collision-free.
 *   2. Name form `[[Title]]` → match by `title` or basename:
 *        - exactly one  → resolved
 *        - multiple     → ambiguous (caller shows a disambiguation picker)
 *        - none         → unresolved (caller may create / navigate-by-name)
 */

import type { NoteListItem } from '@/api/notes-v2';

export type WikiLinkResolution =
  | { kind: 'resolved'; note: NoteListItem }
  | { kind: 'ambiguous'; candidates: NoteListItem[] }
  | { kind: 'unresolved' };

/** Strip a trailing `.md` and lowercase for tolerant comparison. */
function norm(s: string): string {
  return s.replace(/\.md$/i, '').toLowerCase();
}

export function resolveWikiLinkTarget(target: string, notes: NoteListItem[]): WikiLinkResolution {
  const t = target.trim();
  if (!t) return { kind: 'unresolved' };

  // 1. Path form — exact path match (collision-free).
  if (t.includes('/')) {
    const want = norm(t);
    const byPath = notes.filter((n) => norm(n.path) === want);
    if (byPath.length === 1) return { kind: 'resolved', note: byPath[0] };
    if (byPath.length > 1) return { kind: 'ambiguous', candidates: byPath };
    return { kind: 'unresolved' };
  }

  // 2. Name form — match title or basename.
  const want = norm(t);
  const matches = notes.filter((n) => norm(n.title || n.name) === want || norm(n.name) === want);
  if (matches.length === 1) return { kind: 'resolved', note: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'unresolved' };
}

/**
 * Frontmatter split/join for the notes editor (FE side).
 *
 * The notes-v2 backend stamps a stable `id:` (and may carry other YAML keys —
 * tags, created, etc.) in a leading `---\n…\n---` frontmatter block. That block
 * is METADATA, not prose: it must never reach the TipTap surface, or it renders
 * as a stray `---` divider + an `id:` heading and — worse — gets re-serialized
 * into the BODY on the next autosave, after which the server stamps a *fresh* id
 * on top (doubled fence + leaked id + a changed identity that breaks backlinks).
 *
 * So the editor edits the BODY only. We keep the original frontmatter block
 * verbatim and re-prepend it byte-for-byte on save, so:
 *   - the user never sees/edits the metadata,
 *   - the saved bytes are `frontmatter + editedBody` (round-trip byte-clean),
 *   - the server sees the existing `id:` and leaves it untouched (no re-stamp).
 *
 * The regex mirrors the backend `parseFrontmatter` (parse-frontmatter.ts) exactly
 * so the FE/BE split is identical and `contentHash` stays in agreement.
 */

// Leading `---\n … \n---` block (with the optional trailing newline). Identical
// to the backend FRONTMATTER_RE; `frontmatter` keeps the fences + trailing EOL,
// `body` is everything after — so `frontmatter + body === original` verbatim.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SplitNote {
  /** Verbatim leading frontmatter block incl. fences + trailing EOL, or '' if none. */
  frontmatter: string;
  /** Markdown body WITHOUT the frontmatter block (what the editor edits). */
  body: string;
}

/**
 * Split raw note bytes into `{ frontmatter, body }`. When there is no leading
 * frontmatter block, `frontmatter` is '' and `body` is the whole input. Never
 * throws; concatenating the two halves always reproduces the input byte-for-byte.
 */
export function splitFrontmatter(raw: string): SplitNote {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: '', body: raw };
  const frontmatter = match[0];
  return { frontmatter, body: raw.slice(frontmatter.length) };
}

/**
 * Re-attach a preserved frontmatter block to an edited body. Inverse of
 * `splitFrontmatter`. If `frontmatter` is empty, the body is returned unchanged
 * (the backend will stamp a fresh id on first save, as designed).
 */
export function joinFrontmatter(frontmatter: string, body: string): string {
  return frontmatter ? frontmatter + body : body;
}

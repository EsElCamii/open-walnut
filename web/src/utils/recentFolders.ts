/**
 * Recently-opened folder history for the "@" file-mention picker.
 *
 * Backed by the SERVER-persisted frequent-directories store (the same one the
 * /session path picker uses), so recents are shared across browsers/devices and
 * survive restarts — not console-local. Folders the user browses in the "@" picker
 * are POSTed to /api/files/record-dir, feeding that shared store.
 */
import { fetchWorkingDirs, invalidateWorkingDirsCache, type WorkingDirEntry } from '@/api/sessions';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';

export interface RecentFolder {
  path: string;
  host?: string;
}

/**
 * Record a folder visit into the shared server store (fire-and-forget).
 * Root ("/") is never recorded — it's noise every host trivially has, so the
 * `|| '/'` below is just defensive normalization that can't actually fire here.
 * Note: invalidating the cache busts the shared session-picker prefetch too, so
 * "@?" recents may lag one navigation behind until the next fetch lands.
 */
export function recordRecentFolder(path: string, host?: string): void {
  if (!path || path === '/') return;
  const norm = path.replace(/\/+$/, '') || '/';
  apiPost('/api/files/record-dir', { path: norm, host })
    .then(() => invalidateWorkingDirsCache()) // so the next "@?" sees this visit
    .catch((err) => log.error('recent-folders', 'record failed', { path: norm, error: String(err) }));
}

/**
 * ALL recent folders across every host, most-relevant first (server already scores
 * by recency+frequency). "@?" is a GLOBAL search — it returns folders on every host,
 * not just the current one; the current-path/same-host boost is applied at ranking
 * time (see fuzzyMatchRecents) so those still float to the top.
 */
export async function getRecentFolders(): Promise<RecentFolder[]> {
  let dirs: WorkingDirEntry[];
  try {
    dirs = await fetchWorkingDirs();
  } catch {
    return [];
  }
  return dirs.map((d) => ({ path: d.cwd, host: d.host ?? undefined }));
}

/** Split a string into lowercase alphanumeric tokens (path separators and any
 *  punctuation count as boundaries). "MyLongPackageName" stays one token;
 *  "a/b-c_d" → ["a","b","c","d"]. (No /i flag needed — input is lowercased first.) */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Contiguous-subsequence test: does `q` appear in order within `p`? (cheap) */
function isSubsequence(q: string, p: string): boolean {
  let qi = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) if (p[i] === q[qi]) qi++;
  return qi === q.length;
}

/**
 * Token-aware relevance score (0 = no signal, higher = better). Unlike a strict
 * subsequence match, this never hard-excludes a path — so pasting one long path
 * surfaces its SIBLINGS (shared tokens) ranked by how much they overlap.
 *
 * Signals are CUMULATIVE (summed, not exclusive bands) — a path can earn several
 * at once, which is intentional: "matches as a substring AND in the folder name"
 * should outrank "matches as a substring only". Weights, strongest first:
 *   +10  whole query is a substring of the full path        (exact-ish)
 *   +6   whole query is a substring of the last segment     (folder-name hit)
 *   +4   per query token that exactly equals a path token   (segment hit)
 *   +2   per query token that is a substring of some token  (partial)
 *   +2   per query token that hits the last segment         (folder-name bonus)
 *   +1   whole query is a subsequence of the path           (loose fuzzy fallback)
 * These weights are calibrated as ONE scale with the cwd/host boosts below
 * (UNDER_CWD_BOOST ≈ a substring hit; SAME_HOST_BOOST ≈ one token hit) — change
 * them together, and note the boosts only re-rank, they never resurrect a 0-score.
 */
export function fuzzyScore(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = path.toLowerCase();
  const lastSeg = p.slice(p.lastIndexOf('/') + 1);

  let score = 0;
  if (p.includes(q)) score += 10;
  if (lastSeg.includes(q)) score += 6;

  const qTokens = tokenize(query);
  const pTokens = new Set(tokenize(path));
  const lastTokens = new Set(tokenize(lastSeg));
  for (const qt of qTokens) {
    if (pTokens.has(qt)) score += 4;            // exact segment/token hit
    else if ([...pTokens].some((pt) => pt.includes(qt))) score += 2; // partial token
    if (lastTokens.has(qt)) score += 2;         // bonus: in the folder name
  }

  if (score === 0 && isSubsequence(q, p)) score += 1; // loose fuzzy fallback
  return score;
}

/** Context for ranking — folders under the current path / on the current host
 *  get a relevance boost, but everything is still searched (global). */
export interface RecentContext {
  cwd?: string;
  host?: string;
}

const SAME_HOST_BOOST = 4;
const UNDER_CWD_BOOST = 8;

/**
 * Fuzzy-match recents against a query, best score first (ties keep input order).
 * GLOBAL: matches across all hosts. The `ctx` boost ranks folders on the current
 * host — and especially those under the current cwd — higher, without excluding
 * the rest. An empty query returns everything, re-sorted by the boost + recency.
 */
export function fuzzyMatchRecents(
  query: string,
  recents: RecentFolder[],
  ctx: RecentContext = {},
): RecentFolder[] {
  const q = query.trim();
  const cwd = ctx.cwd ? ctx.cwd.replace(/\/+$/, '') : '';
  const boostFor = (r: RecentFolder): number => {
    let b = 0;
    if (ctx.host !== undefined && (r.host ?? undefined) === (ctx.host ?? undefined)) b += SAME_HOST_BOOST;
    if (cwd && (r.path === cwd || r.path.startsWith(cwd + '/'))) b += UNDER_CWD_BOOST;
    return b;
  };

  const scored: { r: RecentFolder; score: number; idx: number }[] = [];
  recents.forEach((r, idx) => {
    const base = q ? fuzzyScore(q, r.path) : 0;
    // With a query, drop only the truly-irrelevant (zero signal). The cwd/host
    // boost is NOT enough on its own to surface an unrelated folder — it only
    // re-ranks among things that already matched.
    if (q && base === 0) return;
    scored.push({ r, score: base + boostFor(r), idx });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.r);
}

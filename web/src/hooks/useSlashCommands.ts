import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSlashCommands, type SlashCommandItem } from '@/api/slash-commands';
import { perf } from '@/utils/perf-logger';

// Module-level global cache: shared across all hook instances (e.g. multiple DockTaskCards).
// Each key is fetched at most once per mount — avoids 3x duplicate requests (22KB each).
const globalCache = new Map<string, SlashCommandItem[]>();
const inflightRequests = new Map<string, Promise<SlashCommandItem[]>>();

// Key on BOTH cwd and host so remote/local lists never share a cache entry.
function cacheKeyOf(cwd?: string, host?: string): string {
  return `${cwd ?? '__no_cwd__'}::${host ?? '__local__'}`;
}

/**
 * Fetches all available slash commands for a session (skills + commands + Claude commands).
 *
 * Stale-while-revalidate: a cached list (if any) is shown instantly, then a background
 * fetch refreshes it so a skill just created on the remote host appears without a reload.
 * `refresh()` forces a server-side re-scan (?fresh=1), e.g. from the palette refresh button.
 */
export function useSlashCommands(cwd?: string, host?: string) {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Track the latest key so an in-flight refresh for a stale key never overwrites items.
  const keyRef = useRef('');

  const load = useCallback((fresh: boolean) => {
    const key = cacheKeyOf(cwd, host);
    keyRef.current = key;
    const cached = globalCache.get(key);
    if (cached) setItems(cached);          // show stale immediately
    if (cached && !fresh) {
      // Revalidate in the background — no spinner, no flash.
      void revalidate(key, cwd, host, false, () => keyRef.current === key, setItems);
      return;
    }

    setLoading(true);
    void revalidate(key, cwd, host, fresh, () => keyRef.current === key, setItems)
      .finally(() => { if (keyRef.current === key) setLoading(false); });
  }, [cwd, host]);

  useEffect(() => { load(false); }, [load]);

  /** Force a fresh server-side re-scan (bypasses both caches). */
  const refresh = useCallback(() => { load(true); }, [load]);

  const search = useCallback((query: string): SlashCommandItem[] => {
    if (!query) return items;
    const q = query.toLowerCase();
    // Score: name prefix > name contains > description contains
    const scored: { item: SlashCommandItem; score: number }[] = [];
    for (const item of items) {
      const nameLower = item.name.toLowerCase();
      const descLower = item.description.toLowerCase();
      if (nameLower.startsWith(q)) {
        scored.push({ item, score: 3 });
      } else if (nameLower.includes(q)) {
        scored.push({ item, score: 2 });
      } else if (descLower.includes(q)) {
        scored.push({ item, score: 1 });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
  }, [items]);

  return { items, loading, search, refresh };
}

/**
 * Fetch one key (deduping concurrent callers), write the global cache, and — if the
 * caller still cares about this key — push the result into component state.
 * `fresh` forces a server-side re-scan via ?fresh=1.
 */
async function revalidate(
  key: string,
  cwd: string | undefined,
  host: string | undefined,
  fresh: boolean,
  stillCurrent: () => boolean,
  setItems: (items: SlashCommandItem[]) => void,
): Promise<void> {
  // A forced refresh must not reuse a non-fresh inflight request.
  let promise = fresh ? undefined : inflightRequests.get(key);
  if (!promise) {
    const endPerf = perf.start('slash-commands:fetch');
    promise = fetchSlashCommands(cwd, host, fresh);
    inflightRequests.set(key, promise);
    promise.then((r) => endPerf(`${r.length} cmds`)).catch(() => endPerf('error'));
    promise.finally(() => {
      if (inflightRequests.get(key) === promise) inflightRequests.delete(key);
    });
  }

  try {
    const result = await promise;
    globalCache.set(key, result);
    if (stillCurrent()) setItems(result);
  } catch {
    // Keep whatever (stale) list we already have; transient daemon/ssh failures
    // shouldn't blank the palette.
  }
}

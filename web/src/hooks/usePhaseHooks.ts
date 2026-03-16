import { useState, useEffect } from 'react';
import { fetchPhaseHooks } from '@/api/hooks';

/**
 * Module-level cache — fetched once, shared across all components.
 *
 * Design: the cache is never invalidated because hooks are a static
 * server-side array that only changes on deploy, which reloads the
 * frontend anyway.  On fetch failure we return an empty map (graceful
 * degradation) and reset fetchPromise so the next mount retries.
 */
let cachedMap: Map<string, string> | null = null;
let fetchPromise: Promise<Map<string, string>> | null = null;

function loadHooks(): Promise<Map<string, string>> {
  if (cachedMap) return Promise.resolve(cachedMap);
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetchPhaseHooks()
    .then(hooks => {
      const map = new Map<string, string>();
      for (const h of hooks) map.set(h.triggerPhase, h.name);
      cachedMap = map;
      return map;
    })
    .catch(() => {
      // Reset so the next caller retries instead of returning the failed promise forever.
      fetchPromise = null;
      return new Map<string, string>();
    });
  return fetchPromise;
}

/** Returns a Map<triggerPhase, hookName> — shared module-level cache. */
export function usePhaseHooks(): Map<string, string> {
  const [hookPhases, setHookPhases] = useState<Map<string, string>>(cachedMap ?? new Map());

  useEffect(() => {
    loadHooks().then(map => setHookPhases(map));
  }, []);

  return hookPhases;
}

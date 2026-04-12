/**
 * Per-source search wrapper with source weights, temporal decay,
 * and guaranteed minimum slots per source.
 */
import { getMemoryStore, getNotesStore } from './qmd-store.js';
import { temporalDecay } from './temporal-decay.js';
import { log } from '../logging/index.js';
import type { HybridQueryResult } from '@tobilu/qmd';

interface SourceConfig {
  weight: number;
  minSlots: number;
  overFetch: number;
  decays: boolean;
  halfLife?: number;
}

const SOURCE_CONFIG: Record<string, SourceConfig> = {
  // Memory sources
  topic:      { weight: 1.5, minSlots: 2, overFetch: 50, decays: false },
  global:     { weight: 1.5, minSlots: 1, overFetch: 10, decays: false },
  project:    { weight: 1.2, minSlots: 1, overFetch: 50, decays: false },
  daily:      { weight: 1.0, minSlots: 1, overFetch: 50, decays: true, halfLife: 30 },
  repo:       { weight: 1.2, minSlots: 0, overFetch: 20, decays: false },
  compaction: { weight: 0.8, minSlots: 0, overFetch: 30, decays: true, halfLife: 30 },
  session:    { weight: 0.8, minSlots: 0, overFetch: 20, decays: true, halfLife: 14 },
  // Notes sources
  note_areas:     { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_projects:  { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_resources: { weight: 1.0, minSlots: 0, overFetch: 20, decays: false },
  note_archive:   { weight: 0.5, minSlots: 0, overFetch: 10, decays: false },
};

export interface MemorySearchResult {
  filepath: string;
  title: string;
  snippet: string;
  score: number;
  finalScore: number;
  source: string;
  collection: string;
}

export async function memoryNotesSearch(
  query: string,
  sources?: string[],
  limit: number = 8,
): Promise<MemorySearchResult[]> {
  const activeSources = sources ?? Object.keys(SOURCE_CONFIG).filter(s => !s.startsWith('note_'));

  // Step 1: per-source search in parallel
  const perSourceResults = await Promise.all(
    activeSources.map(async (src) => {
      const config = SOURCE_CONFIG[src];
      if (!config) return [];
      try {
        const store = src.startsWith('note_') ? await getNotesStore() : await getMemoryStore();
        const collection = src.startsWith('note_') ? src.replace('note_', '') : src;
        const raw: HybridQueryResult[] = await store.search({
          query,
          limit: config.overFetch,
          collection,
          rerank: false, // skip reranking per-source; we do our own scoring
        });
        return raw.map((r) => ({
          filepath: r.file ?? '',
          title: r.title ?? '',
          snippet: r.bestChunk ?? '',
          score: r.score ?? 0,
          source: src,
          collection,
          finalScore: (r.score ?? 0)
            * config.weight
            * (config.decays ? temporalDecay(r.file ?? '', config.halfLife!) : 1.0),
        }));
      } catch (err) {
        log.agent.debug(`memory search failed for source ${src}`, { error: String(err) });
        return [];
      }
    }),
  );

  // Step 2: guaranteed minimum slots
  const guaranteed: MemorySearchResult[] = [];
  const remaining: MemorySearchResult[] = [];
  for (const results of perSourceResults) {
    if (results.length === 0) continue;
    const src = results[0].source;
    const min = SOURCE_CONFIG[src]?.minSlots ?? 0;
    results.sort((a: MemorySearchResult, b: MemorySearchResult) => b.finalScore - a.finalScore);
    guaranteed.push(...results.slice(0, min));
    remaining.push(...results.slice(min));
  }

  // Step 3: fill remaining slots by finalScore
  remaining.sort((a, b) => b.finalScore - a.finalScore);
  const final = [...guaranteed, ...remaining.slice(0, Math.max(0, limit - guaranteed.length))];
  final.sort((a, b) => b.finalScore - a.finalScore);
  return final.slice(0, limit);
}

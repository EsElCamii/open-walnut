/**
 * web_search tool — search the web using Tavily, Brave Search, or Perplexity.
 */
import type { ToolDefinition } from '../tools.js';
import { getConfig } from '../../core/config-manager.js';
import { log } from '../../logging/index.js';
import {
  type CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from './web-shared.js';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const DEFAULT_PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const DEFAULT_PERPLEXITY_MODEL = 'sonar-pro';

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
};

type TavilySearchResponse = {
  query?: string;
  results?: TavilySearchResult[];
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

function resolveBraveApiKey(
  searchConfig?: Record<string, unknown>,
): string | undefined {
  const fromConfig =
    searchConfig && typeof searchConfig.api_key === 'string'
      ? searchConfig.api_key.trim()
      : '';
  const fromEnv = (process.env.BRAVE_API_KEY ?? '').trim();
  return fromConfig || fromEnv || undefined;
}

function resolvePerplexityApiKey(
  searchConfig?: Record<string, unknown>,
): string | undefined {
  const fromConfig =
    searchConfig && typeof searchConfig.perplexity_api_key === 'string'
      ? searchConfig.perplexity_api_key.trim()
      : '';
  const fromEnv = (process.env.PERPLEXITY_API_KEY ?? '').trim();
  return fromConfig || fromEnv || undefined;
}

// Brave and Tavily are mutually exclusive — they share tools.web_search.api_key in config.
// Perplexity has its own perplexity_api_key since it can coexist as an alternative.
function resolveTavilyApiKey(
  searchConfig?: Record<string, unknown>,
): string | undefined {
  const fromConfig =
    searchConfig && typeof searchConfig.api_key === 'string'
      ? searchConfig.api_key.trim()
      : '';
  const fromEnv = (process.env.TAVILY_API_KEY ?? '').trim();
  return fromConfig || fromEnv || undefined;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  country?: string;
  freshness?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `brave:${params.query}:${params.count}:${params.country || 'default'}:${params.freshness || 'default'}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set('q', params.query);
  url.searchParams.set('count', String(params.count));
  if (params.country) {
    url.searchParams.set('country', params.country);
  }
  if (params.freshness) {
    url.searchParams.set('freshness', params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? '',
    url: entry.url ?? '',
    description: entry.description ?? '',
    published: entry.age || undefined,
    siteName: resolveSiteName(entry.url),
  }));

  const payload: Record<string, unknown> = {
    query: params.query,
    provider: 'brave',
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runTavilySearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`tavily:${params.query}:${params.count}`);
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  const res = await fetch(TAVILY_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: params.apiKey,
      query: params.query,
      max_results: params.count,
      // Tavily can return an AI-synthesized answer; disabled to keep results consistent with Brave/Perplexity format
      include_answer: false,
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Tavily Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as TavilySearchResponse;
  const results = Array.isArray(data.results) ? data.results : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? '',
    url: entry.url ?? '',
    description: entry.content ?? '',
    published: entry.published_date || undefined,
    siteName: resolveSiteName(entry.url),
    score: entry.score,
  }));

  const payload: Record<string, unknown> = {
    query: params.query,
    provider: 'tavily',
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`perplexity:${params.query}`);
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const endpoint = `${params.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: params.query }],
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? 'No response';
  const citations = data.citations ?? [];

  const payload: Record<string, unknown> = {
    query: params.query,
    provider: 'perplexity',
    model: params.model,
    tookMs: Date.now() - start,
    content,
    citations,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web using Tavily, Brave Search, or Perplexity. Returns titles, URLs, descriptions for fast research. Provider and API key configured in settings.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string.' },
      count: {
        type: 'number',
        description: 'Number of results to return (1-10, default 5).',
      },
      country: {
        type: 'string',
        description: '2-letter country code for region-specific results (e.g. "US", "DE").',
      },
      freshness: {
        type: 'string',
        description:
          'Filter by discovery time (Brave only). Values: "pd" (past 24h), "pw" (past week), "pm" (past month), "py" (past year), or date range "YYYY-MM-DDtoYYYY-MM-DD".',
      },
    },
    required: ['query'],
  },
  async execute(params) {
    try {
      const query = params.query as string;
      if (!query?.trim()) {
        return 'Error: query is required and must be non-empty.';
      }

      const count = resolveSearchCount(params.count as number | undefined, DEFAULT_SEARCH_COUNT);
      const country = params.country as string | undefined;
      const freshness = params.freshness as string | undefined;

      const config = await getConfig();
      const searchConfig = config.tools?.web_search;

      const providerRaw = ((searchConfig?.provider as string) ?? '').toLowerCase();
      const provider = providerRaw === 'perplexity' ? 'perplexity'
        : providerRaw === 'brave' ? 'brave'
        : 'tavily';

      const timeoutSeconds = resolveTimeoutSeconds(
        searchConfig?.timeout,
        DEFAULT_TIMEOUT_SECONDS,
      );
      const cacheTtlMs = resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES);

      if (provider === 'perplexity') {
        const apiKey = resolvePerplexityApiKey(searchConfig);
        if (!apiKey) {
          return JSON.stringify({
            error: 'missing_perplexity_api_key',
            message:
              'web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY env var, or configure tools.web_search.perplexity_api_key in config.',
          }, null, 2);
        }
        const baseUrl = (searchConfig?.perplexity_base_url as string) || DEFAULT_PERPLEXITY_BASE_URL;
        const model = (searchConfig?.perplexity_model as string) || DEFAULT_PERPLEXITY_MODEL;
        const result = await runPerplexitySearch({
          query, apiKey, baseUrl, model, timeoutSeconds, cacheTtlMs,
        });
        return JSON.stringify(result, null, 2);
      }

      if (provider === 'brave') {
        const apiKey = resolveBraveApiKey(searchConfig);
        if (!apiKey) {
          return JSON.stringify({
            error: 'missing_brave_api_key',
            message:
              'web_search needs a Brave Search API key. Set BRAVE_API_KEY env var, or configure tools.web_search.api_key in settings.',
          }, null, 2);
        }
        const result = await runBraveSearch({
          query, count, apiKey, timeoutSeconds, cacheTtlMs, country, freshness,
        });
        return JSON.stringify(result, null, 2);
      }

      // Tavily Search (default)
      const apiKey = resolveTavilyApiKey(searchConfig);
      if (!apiKey) {
        return JSON.stringify({
          error: 'missing_tavily_api_key',
          message:
            'web_search (tavily) needs an API key. Configure tools.web_search.api_key in settings, or set TAVILY_API_KEY env var.',
        }, null, 2);
      }

      const result = await runTavilySearch({
        query, count, apiKey, timeoutSeconds, cacheTtlMs,
      });
      return JSON.stringify(result, null, 2);
    } catch (err) {
      log.agent.error('web_search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** Exported for testing */
export const __testing = { SEARCH_CACHE, runBraveSearch, runTavilySearch, runPerplexitySearch } as const;

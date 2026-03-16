/**
 * Hardcoded model catalog — the baseline of known models per provider.
 *
 * This is code-level data, NOT stored in config.yaml.
 * Users can override/extend via config.providers[name].models.
 * Merge: code catalog + user overrides (user wins for same ID, appended for new IDs).
 */
import type { ModelEntry, ProviderConfig } from './types.js';

/** Baseline model catalog. Provider name → known models. */
export const MODEL_CATALOG: Record<string, ModelEntry[]> = {
  bedrock: [
    { id: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock',
      label: 'Opus 4.6', max_tokens: 32768, context_window: 200_000 },
    { id: 'global.anthropic.claude-opus-4-6-v1[1m]', provider: 'bedrock',
      label: 'Opus 4.6 (1M)', max_tokens: 32768, context_window: 1_000_000 },
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', provider: 'bedrock',
      label: 'Sonnet 4.5', max_tokens: 16384, context_window: 200_000 },
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]', provider: 'bedrock',
      label: 'Sonnet 4.5 (1M)', max_tokens: 16384, context_window: 1_000_000 },
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', provider: 'bedrock',
      label: 'Haiku 4.5', max_tokens: 16384, context_window: 200_000 },
  ],
  anthropic: [
    { id: 'claude-opus-4-6-20250918', provider: 'anthropic',
      label: 'Opus 4.6', max_tokens: 32768, context_window: 200_000 },
    { id: 'claude-sonnet-4-5-20241022', provider: 'anthropic',
      label: 'Sonnet 4.5', max_tokens: 16384, context_window: 200_000 },
    { id: 'claude-haiku-4-5-20251001', provider: 'anthropic',
      label: 'Haiku 4.5', max_tokens: 16384, context_window: 200_000 },
  ],
  openai: [
    { id: 'gpt-4o', provider: 'openai',
      label: 'GPT-4o', max_tokens: 16384, context_window: 128_000 },
    { id: 'gpt-4o-mini', provider: 'openai',
      label: 'GPT-4o Mini', max_tokens: 16384, context_window: 128_000 },
    { id: 'o3-mini', provider: 'openai',
      label: 'o3-mini', max_tokens: 65536, context_window: 200_000 },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', provider: 'gemini',
      label: 'Gemini 2.5 Flash', max_tokens: 65536, context_window: 1_000_000 },
    { id: 'gemini-2.5-pro', provider: 'gemini',
      label: 'Gemini 2.5 Pro', max_tokens: 65536, context_window: 1_000_000 },
  ],
  deepseek: [
    { id: 'deepseek-chat', provider: 'deepseek',
      label: 'DeepSeek V3', max_tokens: 8192, context_window: 64_000 },
    { id: 'deepseek-reasoner', provider: 'deepseek',
      label: 'DeepSeek R1', max_tokens: 8192, context_window: 64_000 },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4', provider: 'openrouter',
      label: 'Claude Sonnet 4', max_tokens: 16384, context_window: 200_000 },
    { id: 'google/gemini-2.5-flash', provider: 'openrouter',
      label: 'Gemini 2.5 Flash', max_tokens: 65536, context_window: 1_000_000 },
    { id: 'openai/gpt-4o-mini', provider: 'openrouter',
      label: 'GPT-4o Mini', max_tokens: 16384, context_window: 128_000 },
  ],
  // Empty by default — user adds from their local installs
  ollama: [],
  together: [],
  moonshot: [],
  qwen: [],
  doubao: [],
  nvidia: [],
};

/**
 * Get models for a provider: code catalog merged with user config override.
 * User overrides win for matching IDs; new IDs are appended.
 */
export function getModelsForProvider(
  providerName: string,
  configOverrides?: ModelEntry[],
): ModelEntry[] {
  const catalog = MODEL_CATALOG[providerName] ?? [];
  if (!configOverrides?.length) return [...catalog];

  const merged = [...catalog];
  for (const override of configOverrides) {
    const idx = merged.findIndex(m => m.id === override.id);
    if (idx >= 0) {
      // User override replaces catalog entry (spread keeps catalog defaults for missing fields)
      merged[idx] = { ...merged[idx], ...override };
    } else {
      // New model from user — append with provider set
      merged.push({ provider: providerName, ...override });
    }
  }
  return merged;
}

/**
 * Get models for a provider from a full providers map.
 * Convenience wrapper for use in route handlers.
 */
export function getProviderModels(
  providerName: string,
  providers: Record<string, ProviderConfig>,
): ModelEntry[] {
  const prov = providers[providerName];
  return getModelsForProvider(providerName, prov?.models);
}

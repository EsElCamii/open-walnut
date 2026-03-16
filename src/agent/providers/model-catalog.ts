/**
 * Hardcoded model catalog — the baseline of known models per provider.
 *
 * This is code-level data, NOT stored in config.yaml.
 * Users can override/extend via config.providers[name].models.
 * Merge: code catalog + user overrides (user wins for same ID, appended for new IDs).
 */
import type { ModelEntry } from './types.js';

/** Baseline model catalog. Provider name → known models.
 *  Only includes providers we actively test. Users can add more via config. */
export const MODEL_CATALOG: Record<string, ModelEntry[]> = {
  // ── AWS Bedrock (Claude via cross-region inference) ──
  bedrock: [
    { id: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock',
      label: 'Opus 4.6', max_tokens: 128_000, context_window: 1_000_000 },
    { id: 'global.anthropic.claude-sonnet-4-6-v1', provider: 'bedrock',
      label: 'Sonnet 4.6', max_tokens: 64_000, context_window: 1_000_000 },
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', provider: 'bedrock',
      label: 'Haiku 4.5', max_tokens: 64_000, context_window: 200_000 },
  ],
  // ── Anthropic Direct API ──
  anthropic: [
    { id: 'claude-opus-4-6', provider: 'anthropic',
      label: 'Opus 4.6', max_tokens: 128_000, context_window: 1_000_000 },
    { id: 'claude-sonnet-4-6', provider: 'anthropic',
      label: 'Sonnet 4.6', max_tokens: 64_000, context_window: 1_000_000 },
    { id: 'claude-haiku-4-5', provider: 'anthropic',
      label: 'Haiku 4.5', max_tokens: 64_000, context_window: 200_000 },
  ],
  // ── OpenAI ──
  openai: [
    { id: 'gpt-5.2', provider: 'openai',
      label: 'GPT-5.2', max_tokens: 128_000, context_window: 400_000 },
    { id: 'gpt-5-mini', provider: 'openai',
      label: 'GPT-5 Mini', max_tokens: 128_000, context_window: 400_000 },
    { id: 'gpt-4o', provider: 'openai',
      label: 'GPT-4o', max_tokens: 16_384, context_window: 128_000 },
    { id: 'gpt-4o-mini', provider: 'openai',
      label: 'GPT-4o Mini', max_tokens: 16_384, context_window: 128_000 },
  ],
  // ── Google Gemini ──
  gemini: [
    { id: 'gemini-2.5-pro', provider: 'gemini',
      label: 'Gemini 2.5 Pro', max_tokens: 65_536, context_window: 1_000_000 },
    { id: 'gemini-2.5-flash', provider: 'gemini',
      label: 'Gemini 2.5 Flash', max_tokens: 65_536, context_window: 1_000_000 },
    { id: 'gemini-2.5-flash-lite', provider: 'gemini',
      label: 'Gemini 2.5 Flash Lite', max_tokens: 65_536, context_window: 1_000_000 },
  ],
  // ── OpenRouter (aggregator — popular picks) ──
  openrouter: [
    { id: 'anthropic/claude-opus-4-6', provider: 'openrouter',
      label: 'Claude Opus 4.6', max_tokens: 128_000, context_window: 1_000_000 },
    { id: 'anthropic/claude-sonnet-4-6', provider: 'openrouter',
      label: 'Claude Sonnet 4.6', max_tokens: 64_000, context_window: 1_000_000 },
    { id: 'google/gemini-2.5-flash', provider: 'openrouter',
      label: 'Gemini 2.5 Flash', max_tokens: 65_536, context_window: 1_000_000 },
    { id: 'openai/gpt-5.2', provider: 'openrouter',
      label: 'GPT-5.2', max_tokens: 128_000, context_window: 400_000 },
  ],
  // ── Ollama (local) — empty baseline, user adds their installed models ──
  ollama: [],
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


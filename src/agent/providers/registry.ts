/**
 * Provider Registry — resolves provider config to protocol adapter.
 *
 * The registry is the single mapping from provider names (config) to adapter
 * instances (code). It:
 *   1. Reads providers from config.yaml
 *   2. Auto-discovers providers from environment variables
 *   3. Merges explicit config over auto-detected (explicit wins)
 *   4. Caches adapter instances per protocol (adapters are stateless)
 *   5. Resolves secrets before passing config to adapters
 */
import type { ApiProtocol, ProtocolAdapter, ProviderConfig } from './types.js';
import { resolveProviderSecrets, autoDetectApiKey } from './secret.js';
import { KNOWN_PROVIDERS } from './defaults.js';
import { BedrockAdapter } from './adapter-bedrock.js';
import { AnthropicAdapter } from './adapter-anthropic.js';
import { OpenAIAdapter } from './adapter-openai.js';
import { GoogleAdapter } from './adapter-google.js';
import { OllamaAdapter } from './adapter-ollama.js';
import { log } from '../../logging/index.js';

// ── Adapter factory ──

const adapterCache = new Map<ApiProtocol, ProtocolAdapter>();

function getOrCreateAdapter(protocol: ApiProtocol): ProtocolAdapter {
  let adapter = adapterCache.get(protocol);
  if (adapter) return adapter;

  switch (protocol) {
    case 'bedrock':
      adapter = new BedrockAdapter();
      break;
    case 'anthropic-messages':
      adapter = new AnthropicAdapter();
      break;
    case 'openai-chat':
      adapter = new OpenAIAdapter();
      break;
    case 'google-generative-ai':
      adapter = new GoogleAdapter();
      break;
    case 'ollama':
      adapter = new OllamaAdapter();
      break;
    default:
      throw new Error(`Unknown protocol: ${protocol}`);
  }

  adapterCache.set(protocol, adapter);
  return adapter;
}

// ── Provider resolution ──

export interface ResolvedProvider {
  config: ProviderConfig;
  adapter: ProtocolAdapter;
}

/**
 * Resolve a provider by name from the config's providers section.
 * Returns the resolved config (secrets expanded) + the protocol adapter.
 */
export function resolveProvider(
  providerName: string,
  providers: Record<string, ProviderConfig>,
): ResolvedProvider {
  const rawConfig = providers[providerName];
  if (!rawConfig) {
    throw new Error(`Provider "${providerName}" not found in config. Available: ${Object.keys(providers).join(', ')}`);
  }

  const config = resolveProviderSecrets(rawConfig, providerName);
  const adapter = getOrCreateAdapter(config.api);
  return { config, adapter };
}

/**
 * Build the merged providers map: explicit config + auto-detected from env.
 * Explicit config always wins over auto-detected.
 */
export function buildProviderMap(
  explicitProviders?: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const result: Record<string, ProviderConfig> = {};

  // 1. Auto-detect from environment
  for (const [name, template] of Object.entries(KNOWN_PROVIDERS)) {
    const apiKey = autoDetectApiKey(name);
    if (apiKey || name === 'bedrock' || name === 'ollama') {
      result[name] = { ...template, ...(apiKey ? { api_key: apiKey } : {}) };
    }
  }

  // 2. Overlay explicit config (wins over auto-detected)
  if (explicitProviders) {
    for (const [name, config] of Object.entries(explicitProviders)) {
      result[name] = config;
    }
  }

  // 3. Inject Bedrock bearer token from env if not already set.
  //    Supports Identity Center (SSO) bearer-token auth for Bedrock.
  if (result.bedrock && !result.bedrock.bearer_token) {
    const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (envToken) {
      result.bedrock = { ...result.bedrock, bearer_token: envToken };
    }
  }

  return result;
}

/**
 * Synthesize a providers map from legacy config fields.
 * Called when config has no `providers` section — backward compat.
 */
export function synthesizeFromLegacy(config: {
  provider?: { bedrock_region?: string; bedrock_bearer_token?: string };
  agent?: { region?: string };
}): Record<string, ProviderConfig> {
  const region = config.provider?.bedrock_region
    ?? config.agent?.region
    ?? process.env.AWS_REGION
    ?? 'us-west-2';

  const bearerToken = config.provider?.bedrock_bearer_token
    ?? process.env.AWS_BEARER_TOKEN_BEDROCK;

  const providers: Record<string, ProviderConfig> = {
    bedrock: {
      api: 'bedrock',
      region,
      ...(bearerToken ? { bearer_token: bearerToken } : {}),
    },
  };

  // Also auto-detect other providers from env
  return buildProviderMap(providers);
}

/**
 * Reset all cached adapter instances. Useful for credential refresh.
 */
export function resetAllAdapters(): void {
  for (const adapter of adapterCache.values()) {
    adapter.resetClient();
  }
  adapterCache.clear();
  log.agent.info('all provider adapters reset');
}

/**
 * List all available provider names (for UI display).
 */
export function listProviders(providers: Record<string, ProviderConfig>): string[] {
  return Object.keys(providers);
}

import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SecretInput } from '../inputs/SecretInput';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { NumberInput } from '../inputs/NumberInput';
import { fetchProviders, testProvider, testConnection, type ProviderStatus, type TestConnectionResult, type ModelEntry } from '@/api/config';

// All known providers — shown as a catalog. User fills in API key to enable.
const ALL_PROVIDERS: { name: string; label: string; api: string; base_url?: string; needsKey: boolean }[] = [
  { name: 'bedrock', label: 'AWS Bedrock', api: 'bedrock', needsKey: false },
  { name: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', needsKey: true },
  { name: 'openai', label: 'OpenAI', api: 'openai-chat', needsKey: true },
  { name: 'openrouter', label: 'OpenRouter', api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', needsKey: true },
  { name: 'deepseek', label: 'DeepSeek', api: 'openai-chat', base_url: 'https://api.deepseek.com/v1', needsKey: true },
  { name: 'together', label: 'Together AI', api: 'openai-chat', base_url: 'https://api.together.xyz/v1', needsKey: true },
  { name: 'gemini', label: 'Google Gemini', api: 'google-generative-ai', needsKey: true },
  { name: 'ollama', label: 'Ollama (Local)', api: 'ollama', needsKey: false },
  { name: 'moonshot', label: 'Moonshot', api: 'openai-chat', base_url: 'https://api.moonshot.cn/v1', needsKey: true },
  { name: 'qwen', label: 'Qwen (Tongyi)', api: 'openai-chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
  { name: 'doubao', label: 'Doubao (ByteDance)', api: 'openai-chat', base_url: 'https://ark.cn-beijing.volces.com/api/v3', needsKey: true },
  { name: 'nvidia', label: 'NVIDIA NIM', api: 'openai-chat', base_url: 'https://integrate.api.nvidia.com/v1', needsKey: true },
];

const BEDROCK_REGIONS = [
  'us-west-2', 'us-east-1', 'us-east-2',
  'eu-west-1', 'eu-west-3',
  'ap-southeast-1', 'ap-northeast-1',
];

const PROTOCOL_LABELS: Record<string, string> = {
  'anthropic-messages': 'Anthropic Messages API',
  'openai-chat': 'OpenAI-compatible',
  'bedrock': 'AWS Bedrock',
  'google-generative-ai': 'Google Generative AI',
  'ollama': 'Local Ollama',
};

/** Display label for a model entry — use label if available, else truncated ID. */
function modelLabel(m: ModelEntry): string {
  return m.label ?? (m.id.length > 40 ? m.id.slice(0, 37) + '...' : m.id);
}

// Truncate long error messages (e.g. raw JSON from 401 responses)
function truncateError(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max) + '...';
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

// ── Bedrock-specific config inside the active card ──
function BedrockConfig({
  config,
  onSave,
  onTest,
  testStatus,
  testMsg,
}: {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onTest: (region: string, token: string) => Promise<void>;
  testStatus: 'idle' | 'testing' | 'ok' | 'error';
  testMsg?: string;
}) {
  const envHint = (config as Config & { _envTokenHint?: string })._envTokenHint ?? '';
  const [region, setRegion] = useState(config.provider?.bedrock_region ?? 'us-west-2');
  const [token, setToken] = useState(config.provider?.bedrock_bearer_token ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRegion(config.provider?.bedrock_region ?? 'us-west-2');
    setToken(config.provider?.bedrock_bearer_token ?? '');
  }, [config]);

  const displayValue = token || envHint;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        provider: {
          ...config.provider,
          type: config.provider?.type ?? 'bedrock',
          bedrock_region: region,
          ...(token ? { bedrock_bearer_token: token } : {}),
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="provider-active-config">
      <div className="provider-config-row">
        <div className="form-group" style={{ margin: 0, flex: 1, maxWidth: 200 }}>
          <label htmlFor="bedrock-region">Region</label>
          <select id="bedrock-region" value={region} onChange={(e) => setRegion(e.target.value)}>
            {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0, flex: 2 }}>
          <label htmlFor="bedrock-token">Bearer Token</label>
          <SecretInput
            id="bedrock-token"
            value={displayValue}
            onChange={setToken}
            placeholder="Via environment variable or paste here"
          />
          {!token && envHint && (
            <p className="text-sm text-muted" style={{ marginTop: 2 }}>
              From environment variable.
            </p>
          )}
        </div>
      </div>
      <div className="provider-config-row" style={{ alignItems: 'center', gap: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button" className="btn btn-sm"
          onClick={() => onTest(region, token)}
          disabled={testStatus === 'testing'}
        >
          {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        {testStatus !== 'idle' && (
          <StatusIndicator
            status={testStatus === 'ok' ? 'connected' : testStatus === 'error' ? 'error' : 'unknown'}
            text={testMsg}
          />
        )}
      </div>
    </div>
  );
}

// ── Model config inside the active provider card ──
function ModelConfig({
  models,
  mainModel,
  sessionModel,
  maxTokens,
  showModels,
  onMainModelChange,
  onSessionModelChange,
  onMaxTokensChange,
  onAddModel,
  onRemoveModel,
  onToggleModels,
}: {
  models: ModelEntry[];
  mainModel?: string;           // undefined = non-active provider, hide global controls
  sessionModel?: string;
  maxTokens?: number | undefined;
  showModels: boolean;
  onMainModelChange: (v: string) => void;
  onSessionModelChange: (v: string) => void;
  onMaxTokensChange: (v: number | undefined) => void;
  onAddModel: (id: string) => void;
  onRemoveModel: (id: string) => void;
  onToggleModels: () => void;
}) {
  const [newModelId, setNewModelId] = useState('');

  return (
    <div className="provider-model-config">
      <div className="provider-config-row">
        {models.length > 0 && (
          <div className="form-group" style={{ margin: 0, flex: 1 }}>
            <label htmlFor="main-model">Model</label>
            <select
              id="main-model"
              value={mainModel ?? ''}
              onChange={(e) => onMainModelChange(e.target.value)}
            >
              <option value="">Default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{modelLabel(m)}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="session-model">Session Model</label>
          <select
            id="session-model"
            value={sessionModel ?? 'opus'}
            onChange={(e) => onSessionModelChange(e.target.value)}
          >
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </div>
        <div className="form-group" style={{ margin: 0, flex: 1, maxWidth: 160 }}>
          <label htmlFor="max-tokens">Max Tokens</label>
          <NumberInput
            id="max-tokens"
            value={maxTokens}
            onChange={onMaxTokensChange}
            placeholder="16384"
            min={1}
          />
        </div>
      </div>

      {/* Model list — always visible when card is expanded */}
      <div className="provider-models-toggle" onClick={onToggleModels}>
        <span className="provider-card-arrow">{showModels ? '▾' : '▸'}</span>
        <span>Available Models ({models.length})</span>
      </div>
      {showModels && (
        <div className="provider-models-editor">
          {models.map((m) => (
            <div key={m.id} className="provider-model-chip">
              <span>{m.label ? `${m.label} — ${m.id}` : m.id}</span>
              <button type="button" className="chip-remove" onClick={() => onRemoveModel(m.id)}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="Add model ID..."
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newModelId.trim()) {
                  onAddModel(newModelId.trim());
                  setNewModelId('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!newModelId.trim()}
              onClick={() => { onAddModel(newModelId.trim()); setNewModelId(''); }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Individual provider card ──
function ProviderCard({
  def,
  isActive,
  serverInfo,
  configApiKey,
  config,
  mainModel,
  sessionModel,
  maxTokens,
  showModels,
  onSelectActive,
  onSave,
  onSaveKey,
  onSaveMainModel,
  onSaveSessionModel,
  onSaveMaxTokens,
  onSaveProviderModels,
  onToggleModels,
  onReloadProviders,
}: {
  def: typeof ALL_PROVIDERS[number];
  isActive: boolean;
  serverInfo?: ProviderStatus;
  configApiKey?: string;
  config: Config;
  mainModel: string;
  sessionModel: string;
  maxTokens: number | undefined;
  showModels: boolean;
  onSelectActive: (name: string) => void;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onSaveKey: (name: string, key: string) => Promise<void>;
  onSaveMainModel: (v: string) => void;
  onSaveSessionModel: (v: string) => void;
  onSaveMaxTokens: (v: number | undefined) => void;
  onSaveProviderModels: (providerName: string, models: ModelEntry[]) => Promise<void>;
  onToggleModels: () => void;
  onReloadProviders: () => void;
}) {
  const [expanded, setExpanded] = useState(isActive);
  const [apiKey, setApiKey] = useState(configApiKey ?? '');
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState<string | undefined>();

  // Auto-expand when becoming active
  useEffect(() => { if (isActive) setExpanded(true); }, [isActive]);
  useEffect(() => { setApiKey(configApiKey ?? ''); }, [configApiKey]);

  const isConfigured = !!(serverInfo?.status === 'ready');
  const isEnv = !!(serverInfo?.auto_detected && isConfigured);
  const hasKey = !!(serverInfo?.key_hint || configApiKey);

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMsg(undefined);
    try {
      const result: TestConnectionResult = await testProvider(def.name);
      if (result.ok) {
        setTestStatus('ok');
        setTestMsg(`Connected${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
      } else {
        setTestStatus('error');
        setTestMsg(truncateError(result.error ?? 'Connection failed'));
      }
    } catch (err) {
      setTestStatus('error');
      setTestMsg(truncateError((err as Error).message));
    }
  };

  const handleBedrockTest = async (region: string, token: string) => {
    setTestStatus('testing');
    setTestMsg(undefined);
    try {
      const result = await testConnection({ bedrock_region: region, bedrock_bearer_token: token || undefined });
      if (result.ok) {
        setTestStatus('ok');
        setTestMsg(`Connected${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
      } else {
        setTestStatus('error');
        setTestMsg(truncateError(result.error ?? 'Connection failed'));
      }
    } catch (err) {
      setTestStatus('error');
      setTestMsg(truncateError((err as Error).message));
    }
  };

  const handleSaveKey = async () => {
    setSaving(true);
    try {
      await onSaveKey(def.name, apiKey.trim());
    } finally {
      setSaving(false);
    }
  };

  const handleRadioClick = () => {
    if (!isActive) {
      onSelectActive(def.name);
    }
  };

  // Status display
  let statusDot: 'connected' | 'error' | 'unknown' = 'unknown';
  let statusLabel = 'Not configured';
  if (testStatus === 'ok') { statusDot = 'connected'; statusLabel = testMsg!; }
  else if (testStatus === 'error') { statusDot = 'error'; statusLabel = testMsg!; }
  else if (testStatus === 'testing') { statusDot = 'unknown'; statusLabel = 'Testing...'; }
  else if (isConfigured) { statusDot = 'connected'; statusLabel = isEnv ? 'Ready (env)' : 'Ready'; }
  else if (!def.needsKey) { statusDot = 'connected'; statusLabel = 'Available'; }

  const envKeyName = `${def.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  return (
    <div className={`provider-card${isActive ? ' provider-card-active' : ''}`}>
      <div className="provider-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="provider-card-left">
          {/* Radio button for selecting active provider */}
          <span
            className={`provider-radio${isActive ? ' provider-radio-selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleRadioClick(); }}
          />
          <span className="provider-card-label">{def.label}</span>
          {isEnv && <span className="provider-badge auto">env</span>}
          {hasKey && !isEnv && !isActive && <span className="provider-badge configured">key</span>}
        </div>
        <div className="provider-card-right" onClick={(e) => e.stopPropagation()}>
          <StatusIndicator status={statusDot} text={statusLabel} />
          {isConfigured && !isActive && (
            <button type="button" className="btn btn-sm" onClick={handleTest} disabled={testStatus === 'testing'}>
              {testStatus === 'testing' ? '...' : 'Test'}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="provider-card-body">
          <div className="provider-card-meta">
            <span>Protocol: {PROTOCOL_LABELS[def.api] ?? def.api}</span>
            {def.base_url && <span>URL: {def.base_url}</span>}
          </div>

          {/* Bedrock: region + bearer token */}
          {def.api === 'bedrock' && isActive && (
            <BedrockConfig
              config={config}
              onSave={onSave}
              onTest={handleBedrockTest}
              testStatus={testStatus}
              testMsg={testMsg}
            />
          )}

          {/* API Key input for providers that need one */}
          {def.needsKey && (
            <div className="provider-card-key-row">
              <div className="form-group" style={{ margin: 0, flex: 1 }}>
                <label htmlFor={`key-${def.name}`}>API Key</label>
                <SecretInput
                  id={`key-${def.name}`}
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={isEnv ? `Configured via ${envKeyName}` : `Paste ${envKeyName}`}
                />
                {isEnv && !configApiKey && (
                  <p className="text-sm text-muted" style={{ marginTop: 2 }}>
                    Detected from <code style={{ fontSize: 11 }}>{envKeyName}</code>. Paste a key above to override.
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', paddingBottom: 2 }}>
                <button
                  type="button" className="btn btn-primary btn-sm"
                  onClick={handleSaveKey} disabled={saving || !apiKey.trim()}
                >
                  {saving ? 'Saving...' : 'Save Key'}
                </button>
                {!isConfigured && apiKey.trim() && (
                  <button type="button" className="btn btn-sm" onClick={handleTest} disabled={testStatus === 'testing'}>
                    Test
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Non-key providers (bedrock handled above, ollama) */}
          {!def.needsKey && def.api !== 'bedrock' && (
            <p className="text-sm text-muted">
              No API key required — connects to local server.
            </p>
          )}

          {/* Model config: active provider shows full config, others show model list only */}
          <ModelConfig
            models={serverInfo?.models ?? []}
            mainModel={isActive ? mainModel : undefined}
            sessionModel={isActive ? sessionModel : undefined}
            maxTokens={isActive ? maxTokens : undefined}
            showModels={showModels}
            onMainModelChange={onSaveMainModel}
            onSessionModelChange={onSaveSessionModel}
            onMaxTokensChange={onSaveMaxTokens}
            onAddModel={async (id) => {
              const current = serverInfo?.models ?? [];
              const newEntry: ModelEntry = { id, provider: def.name };
              await onSaveProviderModels(def.name, [...current, newEntry]);
            }}
            onRemoveModel={async (id) => {
              const current = serverInfo?.models ?? [];
              await onSaveProviderModels(def.name, current.filter(m => m.id !== id));
            }}
            onToggleModels={onToggleModels}
          />
        </div>
      )}
    </div>
  );
}

export function ProvidersSection({ config, onSave }: Props) {
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading] = useState(true);
  const activeProvider = config.agent?.main_provider ?? 'bedrock';
  const [showModels, setShowModels] = useState(false);

  // Global model selection state (lives in config.agent, not per-provider)
  const [mainModel, setMainModel] = useState(config.agent?.main_model ?? '');
  const [sessionModel, setSessionModel] = useState(config.agent?.session_model ?? 'opus');
  const [maxTokens, setMaxTokens] = useState<number | undefined>(config.agent?.maxTokens);

  useEffect(() => {
    setMainModel(config.agent?.main_model ?? '');
    setSessionModel(config.agent?.session_model ?? 'opus');
    setMaxTokens(config.agent?.maxTokens);
  }, [config]);

  const loadProviders = useCallback(async () => {
    try {
      const data = await fetchProviders();
      setProviders(data);
    } catch {
      // API not available yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const handleSaveKey = async (name: string, key: string) => {
    const existing = config.providers ?? {};
    const template = ALL_PROVIDERS.find(p => p.name === name);
    const current = existing[name] ?? {};
    const updated = {
      ...existing,
      [name]: {
        ...current,
        api: template?.api ?? 'openai-chat',
        ...(template?.base_url ? { base_url: template.base_url } : {}),
        ...(key ? { api_key: key } : {}),
      },
    };
    await onSave({ providers: updated });
    await loadProviders();
  };

  const handleSetActive = async (name: string) => {
    await onSave({ agent: { ...config.agent, main_provider: name } });
  };

  // Save global agent-level settings (main_model, session_model, maxTokens)
  const handleSaveMainModel = async (v: string) => {
    setMainModel(v);
    await onSave({ agent: { ...config.agent, main_model: v || undefined } });
  };
  const handleSaveSessionModel = async (v: string) => {
    setSessionModel(v);
    await onSave({ agent: { ...config.agent, session_model: v || undefined } });
  };
  const handleSaveMaxTokens = async (v: number | undefined) => {
    setMaxTokens(v);
    await onSave({ agent: { ...config.agent, maxTokens: v } });
  };

  // Save per-provider model overrides to config.providers[name].models
  const handleSaveProviderModels = async (providerName: string, models: ModelEntry[]) => {
    const existing = config.providers ?? {};
    const current = existing[providerName] ?? {};
    const template = ALL_PROVIDERS.find(p => p.name === providerName);
    await onSave({
      providers: {
        ...existing,
        [providerName]: {
          ...current,
          api: template?.api ?? current.api ?? 'openai-chat',
          models,
        },
      },
    });
    await loadProviders();
  };

  return (
    <SectionCard
      id="providers"
      title="AI Provider"
      description="Choose your AI provider and model."
      showSave={false}
    >
      {loading ? (
        <p className="text-sm text-muted">Loading providers...</p>
      ) : (
        <div className="provider-catalog">
          {ALL_PROVIDERS.map((def) => (
            <ProviderCard
              key={def.name}
              def={def}
              isActive={def.name === activeProvider}
              serverInfo={providers[def.name]}
              configApiKey={(config.providers as Record<string, { api_key?: string }> | undefined)?.[def.name]?.api_key}
              config={config}
              mainModel={mainModel}
              sessionModel={sessionModel}
              maxTokens={maxTokens}
              showModels={showModels}
              onSelectActive={handleSetActive}
              onSave={onSave}
              onSaveKey={handleSaveKey}
              onSaveMainModel={handleSaveMainModel}
              onSaveSessionModel={handleSaveSessionModel}
              onSaveMaxTokens={handleSaveMaxTokens}
              onSaveProviderModels={handleSaveProviderModels}
              onToggleModels={() => setShowModels(prev => !prev)}
              onReloadProviders={loadProviders}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

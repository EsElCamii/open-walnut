import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { fetchSttStatus, type SttStatus } from '@/api/stt';

type SttEngine = 'sherpa-onnx' | 'openai' | 'whisper-cpp';

const ENGINE_OPTIONS: { value: SttEngine | ''; label: string; description: string }[] = [
  { value: '', label: 'None', description: 'Voice input disabled' },
  { value: 'sherpa-onnx', label: 'sherpa-onnx (Local)', description: 'SenseVoice, Whisper, Paraformer, etc.' },
  { value: 'openai', label: 'OpenAI-compatible (Cloud)', description: 'OpenAI / Groq / Fireworks' },
  { value: 'whisper-cpp', label: 'whisper.cpp (Local)', description: 'Whisper models via CLI' },
];

const OPENAI_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { label: 'Groq (fast)', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  { label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'whisper-v3' },
];

const SHERPA_PRESETS: { label: string; modelType: string }[] = [
  { label: 'SenseVoice', modelType: 'sense_voice' },
  { label: 'Whisper', modelType: 'whisper' },
  { label: 'Paraformer', modelType: 'paraformer' },
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function SttSection({ config, onSave }: Props) {
  const stt = config.stt;
  const [engine, setEngine] = useState<SttEngine | ''>(stt?.engine ?? '');
  const [language, setLanguage] = useState(stt?.language ?? '');

  // sherpa-onnx
  const [sherpaModelDir, setSherpaModelDir] = useState(stt?.sherpa_model_dir ?? '');
  const [sherpaModelType, setSherpaModelType] = useState(stt?.sherpa_model_type ?? 'sense_voice');

  // openai
  const [openaiApiKey, setOpenaiApiKey] = useState(stt?.openai_api_key ?? '');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(stt?.openai_base_url ?? '');
  const [openaiModel, setOpenaiModel] = useState(stt?.openai_model ?? '');

  // whisper-cpp
  const [whisperCppPath, setWhisperCppPath] = useState(stt?.whisper_cpp_path ?? '');
  const [whisperCppModel, setWhisperCppModel] = useState(stt?.whisper_cpp_model ?? '');

  // Status check
  const [status, setStatus] = useState<SttStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  useEffect(() => {
    setEngine(stt?.engine ?? '');
    setLanguage(stt?.language ?? '');
    setSherpaModelDir(stt?.sherpa_model_dir ?? '');
    setSherpaModelType(stt?.sherpa_model_type ?? 'sense_voice');
    setOpenaiApiKey(stt?.openai_api_key ?? '');
    setOpenaiBaseUrl(stt?.openai_base_url ?? '');
    setOpenaiModel(stt?.openai_model ?? '');
    setWhisperCppPath(stt?.whisper_cpp_path ?? '');
    setWhisperCppModel(stt?.whisper_cpp_model ?? '');
  }, [config]);

  const handleSave = async () => {
    await onSave({
      stt: engine ? {
        engine: engine as SttEngine,
        language: language || undefined,
        sherpa_model_dir: sherpaModelDir || undefined,
        sherpa_model_type: (sherpaModelType as 'sense_voice' | 'whisper' | 'paraformer') || undefined,
        openai_api_key: openaiApiKey || undefined,
        openai_base_url: openaiBaseUrl || undefined,
        openai_model: openaiModel || undefined,
        whisper_cpp_path: whisperCppPath || undefined,
        whisper_cpp_model: whisperCppModel || undefined,
      } : undefined,
    });
  };

  const checkStatus = async () => {
    setCheckingStatus(true);
    try {
      const s = await fetchSttStatus();
      setStatus(s);
    } catch (err) {
      setStatus({ engine: null, available: false, error: String(err) });
    } finally {
      setCheckingStatus(false);
    }
  };

  const applyOpenAiPreset = (preset: typeof OPENAI_PRESETS[number]) => {
    setOpenaiBaseUrl(preset.baseUrl);
    setOpenaiModel(preset.model);
  };

  return (
    <SectionCard
      id="stt"
      title="Speech-to-Text"
      description="Configure voice input for all text fields. Click the microphone button to dictate."
      onSave={handleSave}
    >
      <div className="form-group">
        <label htmlFor="stt-engine">Engine</label>
        <select
          id="stt-engine"
          value={engine}
          onChange={(e) => setEngine(e.target.value as SttEngine | '')}
        >
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {engine && (
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            {ENGINE_OPTIONS.find((o) => o.value === engine)?.description}
          </p>
        )}
      </div>

      {engine && (
        <div className="form-group">
          <label htmlFor="stt-language">Language Hint</label>
          <input
            id="stt-language"
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="auto (leave empty) or zh, en, ja..."
          />
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            ISO 639-1 code. Empty = auto-detect.
          </p>
        </div>
      )}

      {/* sherpa-onnx settings */}
      {engine === 'sherpa-onnx' && (
        <>
          <div className="form-group">
            <label>Model Preset</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SHERPA_PRESETS.map((p) => (
                <button
                  key={p.modelType}
                  type="button"
                  className={`btn btn-sm${sherpaModelType === p.modelType ? ' btn-primary' : ''}`}
                  onClick={() => setSherpaModelType(p.modelType)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="stt-sherpa-dir">Model Directory</label>
            <input
              id="stt-sherpa-dir"
              type="text"
              value={sherpaModelDir}
              onChange={(e) => setSherpaModelDir(e.target.value)}
              placeholder="~/stt-models/sense-voice-int8"
            />
          </div>
        </>
      )}

      {/* OpenAI-compatible settings */}
      {engine === 'openai' && (
        <>
          <div className="form-group">
            <label>Provider Preset</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {OPENAI_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`btn btn-sm${openaiBaseUrl === p.baseUrl ? ' btn-primary' : ''}`}
                  onClick={() => applyOpenAiPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="stt-openai-key">API Key</label>
            <input
              id="stt-openai-key"
              type="password"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              placeholder="sk-... or ${env:OPENAI_API_KEY}"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="stt-openai-url">Base URL</label>
              <input
                id="stt-openai-url"
                type="text"
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className="form-group">
              <label htmlFor="stt-openai-model">Model</label>
              <input
                id="stt-openai-model"
                type="text"
                value={openaiModel}
                onChange={(e) => setOpenaiModel(e.target.value)}
                placeholder="whisper-1"
              />
            </div>
          </div>
        </>
      )}

      {/* whisper.cpp settings */}
      {engine === 'whisper-cpp' && (
        <>
          <div className="form-group">
            <label htmlFor="stt-wcpp-bin">Binary Path</label>
            <input
              id="stt-wcpp-bin"
              type="text"
              value={whisperCppPath}
              onChange={(e) => setWhisperCppPath(e.target.value)}
              placeholder="whisper-cli or /path/to/whisper-cli"
            />
          </div>
          <div className="form-group">
            <label htmlFor="stt-wcpp-model">Model File</label>
            <input
              id="stt-wcpp-model"
              type="text"
              value={whisperCppModel}
              onChange={(e) => setWhisperCppModel(e.target.value)}
              placeholder="/path/to/ggml-base.en.bin"
            />
          </div>
        </>
      )}

      {/* Status check */}
      {engine && (
        <div className="form-group" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={checkStatus}
            disabled={checkingStatus}
          >
            {checkingStatus ? 'Checking...' : 'Check Availability'}
          </button>
          {status && (
            <p className="text-sm" style={{
              margin: '6px 0 0',
              color: status.available ? 'var(--success)' : 'var(--error)',
            }}>
              {status.available
                ? `${status.engine} is available`
                : `Not available: ${status.error}`}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

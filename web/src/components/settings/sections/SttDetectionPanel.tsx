/**
 * System detection panel for STT settings.
 * Shows a checklist of detected system capabilities
 * with recommendations and action buttons.
 */

import { useState, useEffect } from 'react';
import {
  fetchSttDetection,
  autoConfigStt,
  type DetectionResult,
  type DetectionItem,
  MODEL_CATALOG,
} from '@/api/stt';
import { SttSetupProgress } from './SttSetupProgress';

interface Props {
  /** Called after auto-config succeeds — parent should reload config */
  onConfigured: () => void;
}

function CheckItem({ item }: { item: DetectionItem }) {
  return (
    <div className="stt-check-item">
      <span className={`stt-check-icon ${item.found ? 'stt-check-ok' : 'stt-check-missing'}`}>
        {item.found ? '\u2713' : '\u2717'}
      </span>
      <span className="stt-check-label">{item.name}</span>
      {item.found && item.path && (
        <span className="stt-check-detail">{item.path}</span>
      )}
      {item.found && item.version && (
        <span className="stt-check-detail">v{item.version}</span>
      )}
      {!item.found && item.error && (
        <span className="stt-check-detail stt-check-error">{item.error}</span>
      )}
    </div>
  );
}

type SetupStep = {
  action: string;
  params: Record<string, string>;
  label: string;
};

export function SttDetectionPanel({ onConfigured }: Props) {
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupSteps, setSetupSteps] = useState<SetupStep[] | null>(null);
  const [autoConfiguring, setAutoConfiguring] = useState(false);

  const runDetection = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSttDetection();
      setDetection(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { runDetection(); }, []);

  const handleOneClick = () => {
    if (!detection?.recommendation) return;
    const steps: SetupStep[] = [];
    const missing = detection.recommendation.missingSteps;

    if (missing.includes('install_ffmpeg')) {
      steps.push({ action: 'install_brew_pkg', params: { pkg: 'ffmpeg' }, label: 'Install ffmpeg' });
    }
    if (missing.includes('install_whisper_cpp')) {
      steps.push({ action: 'install_brew_pkg', params: { pkg: 'whisper-cpp' }, label: 'Install whisper-cpp' });
    }
    if (missing.includes('download_model')) {
      // Default to base.en for quick start
      steps.push({
        action: 'download_ggml_model',
        params: { model: 'ggml-base.en' },
        label: 'Download model (ggml-base.en)',
      });
    }
    setSetupSteps(steps);
  };

  const handleDownloadModel = (modelName: string) => {
    setSetupSteps([{
      action: 'download_ggml_model',
      params: { model: modelName },
      label: `Download ${modelName}`,
    }]);
  };

  const handleSetupComplete = () => {
    setSetupSteps(null);
    // Re-detect after setup
    runDetection();
  };

  const handleAutoConfig = async () => {
    setAutoConfiguring(true);
    try {
      const result = await autoConfigStt();
      if (result.success) {
        onConfigured();
      } else {
        setError(`Auto-config failed: ${result.status.error ?? 'unknown error'}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoConfiguring(false);
    }
  };

  if (loading) {
    return (
      <div className="stt-detection-panel">
        <div className="stt-detection-header">
          <h4>System Detection</h4>
        </div>
        <p className="text-sm text-muted">Scanning system...</p>
      </div>
    );
  }

  if (error && !detection) {
    return (
      <div className="stt-detection-panel">
        <div className="stt-detection-header">
          <h4>System Detection</h4>
          <button className="btn btn-sm" onClick={runDetection}>Retry</button>
        </div>
        <p className="text-sm" style={{ color: 'var(--error)' }}>{error}</p>
      </div>
    );
  }

  if (!detection) return null;

  const rec = detection.recommendation;
  const isReady = rec && rec.missingSteps.length === 0;
  const needsInstall = rec && rec.missingSteps.length > 0 && rec.engine === 'whisper-cpp';
  const onlyNeedsModel = rec && rec.missingSteps.length === 1 && rec.missingSteps[0] === 'download_model';

  return (
    <div className="stt-detection-panel">
      <div className="stt-detection-header">
        <h4>System Detection</h4>
        <button className="btn btn-sm" onClick={runDetection}>Re-scan</button>
      </div>

      <div className="stt-check-list">
        <CheckItem item={detection.ffmpeg} />
        <CheckItem item={detection.whisperCli} />
        <CheckItem item={detection.sherpaOnnxNode} />
        <CheckItem item={detection.homebrew} />
        <div className="stt-check-item">
          <span className={`stt-check-icon ${detection.models.length > 0 ? 'stt-check-ok' : 'stt-check-missing'}`}>
            {detection.models.length > 0 ? '\u2713' : '\u2717'}
          </span>
          <span className="stt-check-label">GGML models</span>
          {detection.models.length > 0 ? (
            <span className="stt-check-detail">{detection.models.map(m => m.name).join(', ')}</span>
          ) : (
            <span className="stt-check-detail stt-check-error">No models found</span>
          )}
        </div>
      </div>

      {/* Recommendation banner */}
      {rec && (
        <div className={`stt-recommendation ${isReady ? 'stt-rec-ready' : 'stt-rec-action'}`}>
          <p>{rec.reason}</p>

          {isReady && (
            <button
              className="btn btn-sm btn-primary"
              onClick={handleAutoConfig}
              disabled={autoConfiguring}
            >
              {autoConfiguring ? 'Configuring...' : 'Apply Recommended Config'}
            </button>
          )}

          {needsInstall && detection.homebrew.found && (
            <button className="btn btn-sm btn-primary" onClick={handleOneClick}>
              One-Click Install
            </button>
          )}
        </div>
      )}

      {/* Model download cards (when only model is missing, or for additional models) */}
      {(onlyNeedsModel || (isReady && detection.models.length < 3)) && !setupSteps && (
        <div className="stt-model-grid">
          {MODEL_CATALOG.filter(m => !detection.models.some(dm => dm.name === m.filename.replace('.bin', ''))).map(m => (
            <button
              key={m.name}
              className="stt-model-card btn"
              onClick={() => handleDownloadModel(m.name)}
            >
              <strong>{m.label}</strong>
              <span className="text-sm text-muted">{m.description}</span>
            </button>
          ))}
        </div>
      )}

      {/* Setup progress */}
      {setupSteps && (
        <SttSetupProgress
          steps={setupSteps}
          onComplete={handleSetupComplete}
          onCancel={() => setSetupSteps(null)}
        />
      )}

      {error && (
        <p className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>{error}</p>
      )}
    </div>
  );
}

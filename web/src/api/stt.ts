/**
 * STT (Speech-to-Text) API client.
 */

import { apiGet, apiPost } from './client';

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

export interface SttStatus {
  engine: string | null;
  available: boolean;
  error?: string;
}

export interface DetectionItem {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface GgmlModel {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface Recommendation {
  engine: 'whisper-cpp' | 'sherpa-onnx' | 'openai';
  reason: string;
  modelPath?: string;
  missingSteps: string[];
}

export interface DetectionResult {
  ffmpeg: DetectionItem;
  whisperCli: DetectionItem;
  sherpaOnnxNode: DetectionItem;
  homebrew: DetectionItem;
  models: GgmlModel[];
  recommendation: Recommendation | null;
}

export interface SetupEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  message?: string;
  percent?: number;
  path?: string;
}

export interface ModelCatalogEntry {
  name: string;
  label: string;
  filename: string;
  sizeBytes: number;
  description: string;
}

export interface AutoConfigResult {
  success: boolean;
  engine: string;
  config: Record<string, string>;
  status: { available: boolean; error?: string };
}

/**
 * Transcribe audio via server STT engine.
 * Uses a 60s timeout (longer than the default 15s) because
 * local engines may need time for first-load model init.
 */
export async function transcribeAudio(
  audioBase64: string,
  format: string,
  language?: string,
): Promise<TranscribeResult> {
  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: audioBase64, format, language }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* use statusText */ }
    throw new Error(message);
  }
  return res.json();
}

export function fetchSttStatus(): Promise<SttStatus> {
  return apiGet<SttStatus>('/api/stt/status');
}

export function fetchSttDetection(): Promise<DetectionResult> {
  return apiGet<DetectionResult>('/api/stt/detect');
}

/**
 * Start a setup action (brew install or model download) via SSE.
 * Returns an EventSource-like reader that yields SetupEvents.
 */
export async function startSetup(
  action: string,
  params: Record<string, string>,
  onEvent: (event: SetupEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/stt/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
    signal: signal ?? AbortSignal.timeout(1800_000), // 30 min for large downloads
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* use statusText */ }
    onEvent({ type: 'error', message });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onEvent({ type: 'error', message: 'No response body' });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete last line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6)) as SetupEvent;
          onEvent(event);
        } catch { /* skip malformed */ }
      }
    }
  }

  // Process any remaining buffer
  if (buffer.startsWith('data: ')) {
    try {
      const event = JSON.parse(buffer.slice(6)) as SetupEvent;
      onEvent(event);
    } catch { /* skip */ }
  }
}

export function autoConfigStt(): Promise<AutoConfigResult> {
  return apiPost<AutoConfigResult>('/api/stt/auto-config');
}

/** Known model catalog — mirrored from server for UI display */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    name: 'ggml-base.en',
    label: 'Base English (148 MB)',
    filename: 'ggml-base.en.bin',
    sizeBytes: 148_000_000,
    description: 'Fast English-only model',
  },
  {
    name: 'ggml-small',
    label: 'Small Multilingual (488 MB)',
    filename: 'ggml-small.bin',
    sizeBytes: 488_000_000,
    description: 'Multilingual — good balance of speed and quality',
  },
  {
    name: 'ggml-medium',
    label: 'Medium Multilingual (1.5 GB)',
    filename: 'ggml-medium.bin',
    sizeBytes: 1_500_000_000,
    description: 'High quality multilingual transcription',
  },
];

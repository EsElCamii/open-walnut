/**
 * STT (Speech-to-Text) API client.
 */

import { apiGet } from './client';

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

export interface SttStatus {
  engine: string | null;
  available: boolean;
  error?: string;
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

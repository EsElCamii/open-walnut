/** STT engine abstraction types */

export interface SttRequest {
  /** Base64-encoded audio data */
  audio: string;
  /** Audio format (webm, wav, mp3, etc.) */
  format: string;
  /** ISO 639-1 language hint. Empty/undefined = auto-detect. */
  language?: string;
}

export interface SttResult {
  text: string;
  durationMs: number;
}

export interface SttEngine {
  readonly name: string;
  /** Check if this engine is available (model exists, binary found, etc.) */
  isAvailable(): Promise<{ available: boolean; error?: string }>;
  /** Transcribe audio to text */
  transcribe(req: SttRequest): Promise<SttResult>;
}

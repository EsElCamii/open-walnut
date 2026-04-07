/**
 * STT (Speech-to-Text) module entry point.
 *
 * Factory function creates the appropriate engine based on config.
 */

import type { Config } from '../types.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';
import { resolveSecret } from '../../agent/providers/secret.js';
import { log } from '../../logging/index.js';
import { createSherpaEngine } from './engine-sherpa.js';
import { createOpenAiEngine } from './engine-openai.js';
import { createWhisperCppEngine } from './engine-whisper-cpp.js';

export type { SttEngine, SttRequest, SttResult } from './types.js';

/** Create an STT engine from config. Returns null if not configured. */
export function createEngine(config: Config): SttEngine | null {
  const stt = config.stt;
  if (!stt?.engine) return null;

  switch (stt.engine) {
    case 'sherpa-onnx':
      return createSherpaEngine({
        modelDir: stt.sherpa_model_dir ?? '',
        modelType: stt.sherpa_model_type ?? 'sense_voice',
      });
    case 'openai':
      return createOpenAiEngine({
        apiKey: resolveSecret(stt.openai_api_key) ?? '',
        baseUrl: stt.openai_base_url,
        model: stt.openai_model,
      });
    case 'whisper-cpp':
      return createWhisperCppEngine({
        binaryPath: stt.whisper_cpp_path ?? 'whisper-cli',
        modelPath: stt.whisper_cpp_model ?? '',
        vadModelPath: stt.whisper_cpp_vad_model,
        prompt: stt.whisper_cpp_prompt,
      });
    default:
      log.stt.warn(`Unknown STT engine: ${stt.engine}`);
      return null;
  }
}

/** Transcribe audio using the configured engine. */
export async function transcribeAudio(config: Config, req: SttRequest): Promise<SttResult> {
  const engine = createEngine(config);
  if (!engine) {
    throw new Error('No STT engine configured. Go to Settings → Speech-to-Text to set one up.');
  }

  const { available, error } = await engine.isAvailable();
  if (!available) {
    throw new Error(`STT engine "${engine.name}" is not available: ${error}`);
  }

  log.stt.info(`Transcribing with ${engine.name} (format=${req.format}, lang=${req.language ?? 'auto'})`);
  const result = await engine.transcribe(req);
  log.stt.info(`Transcription complete: ${result.text.length} chars in ${result.durationMs}ms`);
  return result;
}

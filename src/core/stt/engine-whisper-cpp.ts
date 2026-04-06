/**
 * whisper.cpp local STT engine.
 *
 * Runs the whisper-cli binary with ffmpeg for audio conversion.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { log } from '../../logging/index.js';
import { convertToWav, cleanupTempFile, isFfmpegAvailable } from './audio-convert.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

const execFileAsync = promisify(execFile);

interface WhisperCppConfig {
  binaryPath: string;   // path to whisper-cli or main binary
  modelPath: string;    // path to ggml model file
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

export function createWhisperCppEngine(cfg: WhisperCppConfig): SttEngine {
  return {
    name: 'whisper-cpp',

    async isAvailable() {
      if (!(await fileExists(cfg.binaryPath))) {
        return { available: false, error: `whisper-cpp binary not found: ${cfg.binaryPath}` };
      }
      if (!(await fileExists(cfg.modelPath))) {
        return { available: false, error: `Model file not found: ${cfg.modelPath}` };
      }
      if (!(await isFfmpegAvailable())) {
        return { available: false, error: 'ffmpeg is required for audio conversion but not found' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();

      const wavPath = await convertToWav(req.audio, req.format);
      try {
        const args = [
          '-m', cfg.modelPath,
          '-f', wavPath,
          '--no-timestamps',
        ];
        if (req.language) {
          args.push('-l', req.language);
        }

        log.info('stt', `Running whisper-cpp: ${cfg.binaryPath} ${args.join(' ')}`);

        const { stdout } = await execFileAsync(cfg.binaryPath, args, {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });

        const text = stdout.trim();
        return { text, durationMs: Date.now() - t0 };
      } finally {
        await cleanupTempFile(wavPath);
      }
    },
  };
}

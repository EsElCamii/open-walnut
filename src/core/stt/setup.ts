/**
 * STT setup helpers — brew install packages and download ggml models.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { log } from '../../logging/index.js';

const execFileAsync = promisify(execFile);

export interface SetupEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  message?: string;
  /** 0-100 for downloads */
  percent?: number;
  /** For done events */
  path?: string;
}

export interface ModelCatalogEntry {
  name: string;
  label: string;
  filename: string;
  url: string;
  sizeBytes: number;
  description: string;
}

const HUGGINGFACE_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/master';

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    name: 'ggml-base.en',
    label: 'Base English (148 MB)',
    filename: 'ggml-base.en.bin',
    url: `${HUGGINGFACE_BASE}/ggml-base.en.bin`,
    sizeBytes: 148_000_000,
    description: 'Fast English-only model',
  },
  {
    name: 'ggml-small',
    label: 'Small Multilingual (488 MB)',
    filename: 'ggml-small.bin',
    url: `${HUGGINGFACE_BASE}/ggml-small.bin`,
    sizeBytes: 488_000_000,
    description: 'Multilingual, good balance of speed and quality',
  },
  {
    name: 'ggml-medium',
    label: 'Medium Multilingual (1.5 GB)',
    filename: 'ggml-medium.bin',
    url: `${HUGGINGFACE_BASE}/ggml-medium.bin`,
    sizeBytes: 1_500_000_000,
    description: 'High quality multilingual transcription',
  },
];

/** Default model directory */
export function getModelDir(): string {
  return join(homedir(), '.local', 'share', 'whisper-cpp');
}

/**
 * Install a package via Homebrew. Yields progress events.
 */
export async function* installViaBrew(pkg: string): AsyncGenerator<SetupEvent> {
  // Check if brew exists
  try {
    await execFileAsync('which', ['brew'], { timeout: 5000 });
  } catch {
    yield { type: 'error', message: 'Homebrew not found. Install from https://brew.sh' };
    return;
  }

  // Check if already installed
  try {
    await execFileAsync('brew', ['list', pkg], { timeout: 10000 });
    yield { type: 'log', message: `${pkg} is already installed` };
    yield { type: 'done', message: `${pkg} already installed` };
    return;
  } catch {
    // Not installed, proceed
  }

  yield { type: 'log', message: `Installing ${pkg} via Homebrew...` };
  yield { type: 'progress', percent: 5, message: `brew install ${pkg}` };

  const child = spawn('brew', ['install', pkg], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000, // 10 min max
  });

  let lastLine = '';

  const processLine = (line: string) => {
    if (line.trim()) {
      lastLine = line.trim();
      log.stt.info(`[brew] ${lastLine}`);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').forEach(processLine);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').forEach(processLine);
  });

  // Emit periodic progress
  let progressInterval: ReturnType<typeof setInterval> | undefined;
  let percent = 10;
  const progressGen = {
    events: [] as SetupEvent[],
  };

  progressInterval = setInterval(() => {
    if (percent < 90) percent += 5;
    progressGen.events.push({ type: 'progress', percent, message: lastLine || `Installing ${pkg}...` });
  }, 3000);

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  clearInterval(progressInterval);

  // Yield any accumulated progress events
  for (const evt of progressGen.events) {
    yield evt;
  }

  if (exitCode !== 0) {
    yield { type: 'error', message: `brew install ${pkg} failed (exit ${exitCode}): ${lastLine}` };
    return;
  }

  yield { type: 'progress', percent: 100, message: `${pkg} installed` };
  yield { type: 'done', message: `${pkg} installed successfully` };
}

/**
 * Download a ggml model file. Yields progress events.
 */
export async function* downloadGgmlModel(
  url: string,
  destDir: string,
  filename: string,
): AsyncGenerator<SetupEvent> {
  await mkdir(destDir, { recursive: true });

  const destPath = join(destDir, filename);
  const tmpPath = destPath + '.downloading';

  // Check if already exists
  try {
    const s = await stat(destPath);
    if (s.isFile() && s.size > 1_000_000) {
      yield { type: 'log', message: `${filename} already exists (${(s.size / 1e6).toFixed(0)} MB)` };
      yield { type: 'done', message: `${filename} already exists`, path: destPath };
      return;
    }
  } catch { /* doesn't exist */ }

  yield { type: 'log', message: `Downloading ${filename}...` };
  yield { type: 'progress', percent: 0, message: `Starting download: ${filename}` };

  log.stt.info(`Downloading model: ${url} → ${destPath}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(1800_000) }); // 30 min timeout
  if (!res.ok) {
    yield { type: 'error', message: `Download failed: HTTP ${res.status} ${res.statusText}` };
    return;
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: 'No response body' };
    return;
  }

  const writeStream = createWriteStream(tmpPath);
  let downloaded = 0;
  let lastPercent = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      writeStream.write(value);
      downloaded += value.length;

      if (contentLength > 0) {
        const percent = Math.round((downloaded / contentLength) * 100);
        if (percent - lastPercent >= 2) {
          lastPercent = percent;
          yield {
            type: 'progress',
            percent,
            message: `${(downloaded / 1e6).toFixed(1)} / ${(contentLength / 1e6).toFixed(0)} MB`,
          };
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });

    // Atomic rename
    await rename(tmpPath, destPath);

    log.stt.info(`Model downloaded: ${destPath} (${(downloaded / 1e6).toFixed(0)} MB)`);
    yield { type: 'progress', percent: 100, message: `Download complete` };
    yield { type: 'done', message: `${filename} downloaded`, path: destPath };
  } catch (err) {
    writeStream.destroy();
    await unlink(tmpPath).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message: `Download failed: ${msg}` };
  }
}

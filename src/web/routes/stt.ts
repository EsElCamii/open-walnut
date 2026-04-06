/**
 * STT (Speech-to-Text) API routes.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { getConfig, updateConfig } from '../../core/config-manager.js';
import { transcribeAudio, createEngine } from '../../core/stt/index.js';
import { detectSystem } from '../../core/stt/detect.js';
import { installViaBrew, downloadGgmlModel, MODEL_CATALOG, getModelDir } from '../../core/stt/setup.js';
import { log } from '../../logging/index.js';

export const sttRouter = Router();

const ALLOWED_FORMATS = new Set(['webm', 'wav', 'mp3', 'ogg', 'mp4', 'm4a', 'flac']);

/**
 * POST /api/stt/transcribe
 * Body: { audio: string (base64), format: string, language?: string }
 * Response: { text: string, durationMs: number }
 */
sttRouter.post('/transcribe', express.json({ limit: '35mb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { audio, format, language } = req.body;
    if (!audio || typeof audio !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "audio" field (base64 string expected)' });
      return;
    }
    if (!format || typeof format !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "format" field' });
      return;
    }
    if (!ALLOWED_FORMATS.has(format)) {
      res.status(400).json({ error: `Unsupported audio format: ${format}` });
      return;
    }

    // Limit size: ~25MB base64 ≈ ~18MB raw
    if (audio.length > 25 * 1024 * 1024) {
      res.status(413).json({ error: 'Audio too large (max 25MB base64)' });
      return;
    }

    const config = await getConfig();
    const effectiveLanguage = language || config.stt?.language;
    const result = await transcribeAudio(config, { audio, format, language: effectiveLanguage });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stt/status
 * Response: { engine: string | null, available: boolean, error?: string }
 */
sttRouter.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig();
    const engine = createEngine(config);
    if (!engine) {
      res.json({ engine: null, available: false, error: 'No STT engine configured' });
      return;
    }
    const status = await engine.isAvailable();
    res.json({ engine: engine.name, ...status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stt/detect
 * Scan system for available STT engines, binaries, and models.
 */
sttRouter.get('/detect', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await detectSystem();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/stt/setup
 * SSE stream for installing binaries or downloading models.
 * Body: { action: 'install_brew_pkg', pkg: string } | { action: 'download_ggml_model', model: string }
 */
sttRouter.post('/setup', express.json(), async (req: Request, res: Response) => {
  const { action } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (action === 'install_brew_pkg') {
      const { pkg } = req.body;
      if (!pkg || typeof pkg !== 'string') {
        send({ type: 'error', message: 'Missing "pkg" field' });
        res.end();
        return;
      }
      // Only allow known safe packages
      const allowed = new Set(['ffmpeg', 'whisper-cpp']);
      if (!allowed.has(pkg)) {
        send({ type: 'error', message: `Package not allowed: ${pkg}` });
        res.end();
        return;
      }
      for await (const event of installViaBrew(pkg)) {
        send(event);
      }
    } else if (action === 'download_ggml_model') {
      const { model } = req.body;
      if (!model || typeof model !== 'string') {
        send({ type: 'error', message: 'Missing "model" field' });
        res.end();
        return;
      }
      const catalogEntry = MODEL_CATALOG.find(m => m.name === model);
      if (!catalogEntry) {
        send({ type: 'error', message: `Unknown model: ${model}. Available: ${MODEL_CATALOG.map(m => m.name).join(', ')}` });
        res.end();
        return;
      }
      const destDir = getModelDir();
      for await (const event of downloadGgmlModel(catalogEntry.url, destDir, catalogEntry.filename)) {
        send(event);
      }
    } else {
      send({ type: 'error', message: `Unknown action: ${action}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.stt.error(`Setup failed: ${msg}`);
    send({ type: 'error', message: msg });
  }

  res.end();
});

/**
 * POST /api/stt/auto-config
 * Detect system → pick best engine → save config → verify.
 */
sttRouter.post('/auto-config', express.json(), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const detection = await detectSystem();
    const rec = detection.recommendation;

    if (!rec || rec.missingSteps.length > 0) {
      res.status(400).json({
        error: 'Cannot auto-configure: prerequisites missing',
        recommendation: rec,
        detection,
      });
      return;
    }

    // Apply recommended config
    if (rec.engine === 'whisper-cpp') {
      const whisperPath = detection.whisperCli.path ?? 'whisper-cli';
      const modelPath = rec.modelPath ?? detection.models[0]?.path;
      if (!modelPath) {
        res.status(400).json({ error: 'No model found to auto-configure' });
        return;
      }

      await updateConfig({
        stt: {
          engine: 'whisper-cpp',
          whisper_cpp_path: whisperPath,
          whisper_cpp_model: modelPath,
        },
      });

      // Verify the engine works
      const config = await getConfig();
      const engine = createEngine(config);
      const status = engine ? await engine.isAvailable() : { available: false, error: 'Engine creation failed' };

      res.json({
        success: status.available,
        engine: 'whisper-cpp',
        config: { whisper_cpp_path: whisperPath, whisper_cpp_model: modelPath },
        status,
      });
    } else {
      res.status(400).json({
        error: `Auto-config for "${rec.engine}" requires manual configuration`,
        recommendation: rec,
      });
    }
  } catch (err) {
    next(err);
  }
});

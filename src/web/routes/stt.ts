/**
 * STT (Speech-to-Text) API routes.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { getConfig } from '../../core/config-manager.js';
import { transcribeAudio, createEngine } from '../../core/stt/index.js';

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

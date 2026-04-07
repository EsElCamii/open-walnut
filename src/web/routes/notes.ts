/**
 * Notes routes — global user notes stored locally.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { GLOBAL_NOTES_FILE } from '../../constants.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'

const MAX_NOTES_SIZE = 1_000_000 // 1 MB

export const notesRouter = Router()

// GET /api/notes/global — read global notes
notesRouter.get('/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let content = ''
    try {
      content = await fsp.readFile(GLOBAL_NOTES_FILE, 'utf-8')
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      // File doesn't exist yet — return empty string
    }
    const contentHash = computeContentHash(content)
    res.json({ content, contentHash })
  } catch (err) {
    next(err)
  }
})

// PUT /api/notes/global — write global notes
notesRouter.put('/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content, expectedHash } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    if (content.length > MAX_NOTES_SIZE) {
      res.status(413).json({ error: `Content too large (max ${MAX_NOTES_SIZE} bytes)` })
      return
    }

    // Optimistic locking: reject if file was modified externally.
    // Optional for backward compatibility — callers that don't send
    // expectedHash accept last-write-wins semantics.
    if (expectedHash) {
      let currentContent = ''
      try {
        currentContent = await fsp.readFile(GLOBAL_NOTES_FILE, 'utf-8')
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err
      }
      const currentHash = computeContentHash(currentContent)
      if (currentHash !== expectedHash) {
        res.status(409).json({
          error: 'Content was modified externally',
          currentHash,
        })
        return
      }
    }

    await fsp.mkdir(path.dirname(GLOBAL_NOTES_FILE), { recursive: true })
    await fsp.writeFile(GLOBAL_NOTES_FILE, content, 'utf-8')
    const contentHash = computeContentHash(content)
    log.memory.info('Global notes updated via browser', { size: content.length })
    bus.emit(EventNames.NOTES_UPDATED, { source: 'notes/global', contentHash }, ['web-ui'])
    res.json({ ok: true, contentHash })
  } catch (err) {
    next(err)
  }
})

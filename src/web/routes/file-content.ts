/**
 * Serve local or remote file content for the FileViewer overlay.
 *
 * GET /api/file-content?path=/absolute/path/to/file.ts&host=optional-ssh-host
 *
 * Security:
 * - Must be absolute path
 * - No directory traversal (explicit .. rejection)
 * - File size limit (512 KB for text content)
 * - Binary detection (first 8KB NUL scan)
 * - Localhost-only server
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { createFileReader } from '../../core/session-file-reader.js'

export const fileContentRouter = Router()

const MAX_FILE_SIZE = 512 * 1024 // 512 KB

/** Detect binary content by scanning for NUL bytes in the first 8KB */
function isBinaryContent(buffer: Buffer): boolean {
  const scanLen = Math.min(buffer.length, 8192)
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

fileContentRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const host = req.query.host

    if (!rawPath || typeof rawPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }

    // No directory traversal
    if (rawPath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }

    // Expand `~`/`~/…` for local reads (Node fs has no shell expansion). Remote
    // keeps `~` — the daemon's fs.read expands it on the remote host's HOME.
    let filePath = rawPath
    if (!host && (filePath === '~' || filePath.startsWith('~/'))) {
      filePath = os.homedir() + filePath.slice(1)
    }

    // Must be absolute (after ~ expansion); remote `~` paths are allowed through.
    const isRemote = typeof host === 'string' && host.length > 0
    if (!isRemote && !path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    const ext = path.extname(filePath).slice(1).toLowerCase()

    // Raw mode: serve the file's bytes directly with a real Content-Type so the
    // browser treats it as a standalone document. Used by the HTML preview iframe
    // (via `src`), which gives the page its own URL — so in-page anchors, relative
    // links and scripts resolve against the file itself instead of the Walnut SPA.
    const raw = req.query.raw === '1' || req.query.raw === 'true'
    if (raw) {
      // Read may throw on a remote transport failure (DaemonFileReader.readFile
      // only returns null for ENOENT). Catch it so the iframe gets a clean
      // text/plain error instead of the outer error handler's JSON/stack body.
      let content: string | null = null
      try {
        if (isRemote) {
          const reader = await createFileReader(host as string)
          content = await reader.readFile(filePath)
        } else {
          content = await fsp.readFile(filePath, 'utf-8')
        }
      } catch (err) {
        const msg = isRemote
          ? `Cannot reach remote host: ${err instanceof Error ? err.message : String(err)}`
          : 'File not found'
        res.status(isRemote ? 502 : 404).type('text/plain').send(msg)
        return
      }
      if (content === null) {
        res.status(404).type('text/plain').send('File not found')
        return
      }
      const ctype = ext === 'htm' || ext === 'html' ? 'text/html; charset=utf-8'
        : ext === 'svg' ? 'image/svg+xml'
        : 'text/plain; charset=utf-8'
      // The framed doc runs as the SPA's own origin (sandbox allow-scripts +
      // allow-same-origin in FileContentView). Acceptable for a localhost personal
      // tool serving files the user explicitly opened; no untrusted-upload surface.
      res.type(ctype).send(content)
      return
    }

    if (typeof host === 'string' && host) {
      // Remote file via SSH daemon
      try {
        const reader = await createFileReader(host)
        const content = await reader.readFile(filePath)
        if (content === null) {
          res.json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: ext })
          return
        }
        const truncated = content.length > MAX_FILE_SIZE
        const displayContent = truncated ? content.slice(0, MAX_FILE_SIZE) : content
        res.json({
          content: displayContent,
          size: content.length,
          truncated,
          binary: false,
          extension: ext,
        })
      } catch (err) {
        res.json({
          content: null,
          size: 0,
          truncated: false,
          binary: false,
          error: `Cannot reach remote host: ${err instanceof Error ? err.message : String(err)}`,
          extension: ext,
        })
      }
      return
    }

    // Local file
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      res.json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: ext })
      return
    }

    if (!stat.isFile()) {
      res.json({ content: null, size: 0, truncated: false, binary: false, error: 'Not a regular file', extension: ext })
      return
    }

    // Binary detection
    const fd = await fsp.open(filePath, 'r')
    try {
      const probe = Buffer.alloc(Math.min(8192, stat.size))
      await fd.read(probe, 0, probe.length, 0)
      if (isBinaryContent(probe)) {
        res.json({
          content: null,
          size: stat.size,
          truncated: false,
          binary: true,
          extension: ext,
        })
        return
      }
    } finally {
      await fd.close()
    }

    const truncated = stat.size > MAX_FILE_SIZE
    const buffer = truncated
      ? await readPartial(filePath, MAX_FILE_SIZE)
      : await fsp.readFile(filePath)

    res.json({
      content: buffer.toString('utf-8'),
      size: stat.size,
      truncated,
      binary: false,
      extension: ext,
    })
  } catch (err) {
    next(err)
  }
})

/** Read first N bytes of a file */
async function readPartial(filePath: string, bytes: number): Promise<Buffer> {
  const fd = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    await fd.read(buf, 0, bytes, 0)
    return buf
  } finally {
    await fd.close()
  }
}

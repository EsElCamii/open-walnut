/**
 * Serve image files referenced by absolute path.
 *
 * GET /api/local-image?path=/absolute/path/to/file.png[&host=clouddev]
 *
 * When `host` is provided and the file doesn't exist locally, the daemon
 * fetches it from the remote host and caches it under REMOTE_IMAGES_DIR.
 *
 * Security:
 * - Extension whitelist (png, jpg, jpeg, gif, webp) — no SVG (XSS risk)
 * - Must be absolute path
 * - No directory traversal (explicit .. rejection)
 * - File size limit (50 MB)
 * - Must be a regular file
 * - Localhost-only server
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { REMOTE_IMAGES_DIR } from '../../constants.js'

export const localImageRouter = Router()

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_TO_MIME))

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

async function resolveSessionHost(sessionId: string): Promise<string | null> {
  try {
    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    return record?.host ?? null
  } catch { return null }
}

async function fetchFromRemote(host: string, remotePath: string): Promise<Buffer | null> {
  try {
    const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef?.hostname) return null
    const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }
    const conn = await getDaemonConnection(host, sshTarget)
    const result = await conn.send('fs.read', { path: remotePath, encoding: 'base64' })
    if (!result.ok || !result.data) return null
    return Buffer.from(result.data as string, 'base64')
  } catch { return null }
}

localImageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filePath = req.query.path
    const host = req.query.host
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }

    // Must be absolute
    if (!path.isAbsolute(filePath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    // Extension whitelist
    const ext = path.extname(filePath).slice(1).toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: 'File type not allowed' })
      return
    }

    // No directory traversal: reject paths containing '..' segments
    if (filePath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }

    // Try local file first
    let buffer: Buffer | null = null
    try {
      const stat = await fsp.stat(filePath)
      if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
        buffer = await fsp.readFile(filePath)
      }
    } catch {
      // File not found locally — try remote fallback
    }

    // Remote fallback: fetch via daemon and cache locally
    if (!buffer && host && typeof host === 'string') {
      buffer = await fetchFromRemote(host, filePath)
      if (buffer) {
        const cachePath = path.join(REMOTE_IMAGES_DIR, host, path.basename(filePath))
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        fs.writeFileSync(cachePath, buffer)
      }
    }

    // Auto-detect remote session images: /tmp/open-walnut/images/remote/<sessionId>/file.png
    // The path is identical on the remote host (EKS MCP writes there directly).
    if (!buffer && filePath.startsWith(REMOTE_IMAGES_DIR + '/')) {
      const relToRemote = filePath.slice(REMOTE_IMAGES_DIR.length + 1)
      const slashIdx = relToRemote.indexOf('/')
      if (slashIdx > 0) {
        const sessionId = relToRemote.slice(0, slashIdx)
        const remoteHost = await resolveSessionHost(sessionId)
        if (remoteHost) {
          buffer = await fetchFromRemote(remoteHost, filePath)
          if (buffer) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, buffer)
          }
        }
      }
    }

    if (!buffer) {
      res.status(404).json({ error: 'File not found' })
      return
    }

    if (buffer.length > MAX_FILE_SIZE) {
      res.status(400).json({ error: 'File too large' })
      return
    }

    const contentType = EXT_TO_MIME[ext]!
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

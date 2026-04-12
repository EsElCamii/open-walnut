/**
 * API key authentication middleware.
 *
 * - Requests from localhost/loopback skip auth (backward compat with web SPA).
 * - Remote requests require `Authorization: Bearer <key>` matching a key in config.yaml.
 * - Keys are stored in config.yaml under `api_keys[]`.
 */

import type { Request, Response, NextFunction } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { log } from '../../logging/index.js'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

// Walnut is a personal tool that runs on a home/office LAN. Devices on the same
// private network (phones, tablets) need API access without API keys; only
// requests arriving from the public internet require Bearer auth.
function isPrivateNetwork(ip: string): boolean {
  // Strip ::ffff: prefix for IPv4-mapped IPv6
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (LOCALHOST_ADDRS.has(ip)) return true
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  const parts = v4.split('.').map(Number)
  if (parts.length !== 4) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isLocalhost(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? ''
  return isPrivateNetwork(ip)
}

/**
 * Express middleware: authenticate remote requests via Bearer token.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Localhost requests always pass through (backward compat with web SPA)
  if (isLocalhost(req)) {
    next()
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required. Use Authorization: Bearer <api_key>' })
    return
  }

  const token = authHeader.slice(7) // strip "Bearer "
  try {
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const match = keys.find((k) => k.key === token)

    if (!match) {
      log.web.warn('auth: invalid API key', { ip: req.ip })
      res.status(403).json({ error: 'Invalid API key' })
      return
    }

    // Attach key info to request for downstream use
    ;(req as Request & { apiKeyName?: string }).apiKeyName = match.name
    next()
  } catch (err) {
    log.web.error('auth middleware error', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'Internal auth error' })
  }
}

/**
 * Validate an API key string against config. Returns the key name or null.
 */
export async function validateApiKey(key: string): Promise<string | null> {
  try {
    const config = await getConfig()
    const keys = config.api_keys ?? []
    const match = keys.find((k) => k.key === key)
    return match?.name ?? null
  } catch {
    return null
  }
}

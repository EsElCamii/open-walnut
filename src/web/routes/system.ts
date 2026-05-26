/**
 * System health API — exposes daemon connection status.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { getDaemonPoolStatus } from '../../providers/daemon-connection.js'
import { getConfig } from '../../core/config-manager.js'

export const systemRouter = Router()

// GET /api/system/health — current health snapshot (+ daemon connection status)
systemRouter.get('/health', async (_req, res) => {
  const health = getSystemHealth()

  // Build response with optional daemons field
  const response: Record<string, unknown> = { ...health }

  try {
    const config = await getConfig()
    const hosts = config.hosts
    if (hosts && Object.keys(hosts).length > 0) {
      let activeMap = new Map<string, { connected: boolean }>()
      try {
        activeMap = new Map(getDaemonPoolStatus().map(d => [d.host, d]))
      } catch { /* pool not ready */ }

      response.daemons = Object.entries(hosts).map(([key, def]) => ({
        host: key,
        label: def.label ?? def.hostname,
        connected: activeMap.get(key)?.connected ?? false,
      }))
    }
  } catch { /* config not ready */ }

  res.json(response)
})

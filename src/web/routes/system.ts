/**
 * System health API — exposes embedding status and allows manual reindex.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { broadcastEvent } from '../ws/handler.js'
import { log } from '../../logging/index.js'
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

// POST /api/system/health/reindex — trigger re-reconciliation
systemRouter.post('/health/reindex', async (_req, res) => {
  try {
    // Run reconciliation in background, respond immediately
    res.json({ status: 'started' })

    const { reconcileAllEmbeddings } = await import('../../core/embedding/pipeline.js')
    const result = await reconcileAllEmbeddings()

    // Update the shared health state (imported by reference)
    const health = getSystemHealth()
    health.embedding = {
      total: result.totalTasks,
      indexed: result.indexedTasks,
      unindexed: result.totalTasks - result.indexedTasks,
      ollamaAvailable: result.ollamaAvailable,
      lastReconcileAt: new Date().toISOString(),
    }

    broadcastEvent('system:health', health)
    log.memory.info('manual reindex complete', {
      total: result.totalTasks,
      indexed: result.indexedTasks,
      ollamaAvailable: result.ollamaAvailable,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.memory.error('manual reindex failed', { error: errMsg })

    const health = getSystemHealth()
    health.embedding.ollamaAvailable = false
    health.embedding.lastError = errMsg
    broadcastEvent('system:health', health)
  }
})

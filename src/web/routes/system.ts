/**
 * System health API — exposes embedding status and allows manual reindex.
 */

import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import { getSystemHealth, refreshSystemHealth } from '../server.js'
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

// ── One-click install for dependencies ──

const INSTALL_TARGETS = ['claude-cli', 'ollama'] as const
type InstallTarget = typeof INSTALL_TARGETS[number]

function runCommand(cmd: string, args: string[], timeout = 300_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr?.toString() ?? '' })
    })
  })
}

function runShell(command: string, timeout = 300_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    child.on('close', (code) => resolve({ ok: code === 0, output }))
    child.on('error', (e) => resolve({ ok: false, output: e.message }))
  })
}

// POST /api/system/install — install a dependency (claude-cli or ollama)
systemRouter.post('/install', async (req, res) => {
  const { target } = req.body as { target?: string }
  if (!target || !INSTALL_TARGETS.includes(target as InstallTarget)) {
    res.status(400).json({ ok: false, error: `Invalid target. Must be one of: ${INSTALL_TARGETS.join(', ')}` })
    return
  }

  const platform = os.platform()
  if (platform !== 'darwin' && platform !== 'linux') {
    res.status(400).json({ ok: false, error: `Unsupported platform: ${platform}. Only macOS and Linux are supported.` })
    return
  }

  log.web.info(`install: starting ${target}`, { platform })

  try {
    if (target === 'claude-cli') {
      // Check if npm is available
      const npmCheck = await runCommand('which', ['npm'], 5000)
      if (!npmCheck.ok) {
        res.json({ ok: false, error: 'npm not found. Install Node.js first.' })
        return
      }
      const result = await runShell('npm install -g @anthropic-ai/claude-code')
      if (!result.ok) {
        log.web.error('install: claude-cli failed', { output: result.output.slice(-500) })
        res.json({ ok: false, error: 'Installation failed. Check server logs for details.' })
        return
      }
    } else if (target === 'ollama') {
      // macOS: use brew (no sudo needed); Linux: use official install script
      let result: { ok: boolean; output: string }
      if (platform === 'darwin') {
        const brewCheck = await runCommand('which', ['brew'], 5000)
        if (!brewCheck.ok) {
          res.json({ ok: false, error: 'Homebrew not found. Install it first: https://brew.sh' })
          return
        }
        result = await runShell('brew install ollama')
      } else {
        result = await runShell('curl -fsSL https://ollama.com/install.sh | sh')
      }
      if (!result.ok) {
        log.web.error('install: ollama failed', { output: result.output.slice(-500) })
        res.json({ ok: false, error: result.output.includes('sudo') ? 'Installation requires sudo. Run manually: curl -fsSL https://ollama.com/install.sh | sh' : 'Installation failed. Check server logs for details.' })
        return
      }
      // Start ollama serve in background if not already running
      try {
        const pingRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
        if (!pingRes.ok) throw new Error('not running')
      } catch {
        const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' })
        child.unref()
        // Wait for service to come up
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000))
          try {
            const pingRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) })
            if (pingRes.ok) break
          } catch { /* retry */ }
        }
      }
    }

    // Refresh health and broadcast to all clients
    await refreshSystemHealth()
    log.web.info(`install: ${target} completed successfully`)
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.web.error(`install: ${target} failed`, { error: msg })
    res.json({ ok: false, error: msg })
  }
})

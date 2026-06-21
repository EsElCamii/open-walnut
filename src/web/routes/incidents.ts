/**
 * Forensic Observability — incident HTTP routes (Module 5).
 *
 * Exposes the durable incident corpus (incidents.ts, Module 3) over HTTP and
 * backs the "Investigate" button in both session panels. The Investigate flow:
 * POST /investigate freezes an evidence bundle (bundle.ts, Module 4) for the
 * session, opens a manual incident pointing at it, and returns the incident so
 * the UI can confirm ("Evidence captured — incident <id>").
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { listIncidents, getIncident, createIncident, updateIncidentStatus } from '../../core/observability/incidents.js'
import { captureBundle } from '../../core/observability/bundle.js'
import type { IncidentStatus } from '../../core/observability/types.js'

export const incidentsRouter = Router()

const VALID_STATUSES = ['open', 'investigating', 'resolved', 'dismissed'] as const

// GET /api/incidents — list incidents (most-recent first, as stored).
incidentsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const incidents = await listIncidents()
    res.json({ incidents })
  } catch (err) {
    next(err)
  }
})

// GET /api/incidents/:id — fetch a single incident.
incidentsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const incident = await getIncident(String(req.params.id))
    if (!incident) {
      res.status(404).json({ error: 'incident not found' })
      return
    }
    res.json({ incident })
  } catch (err) {
    next(err)
  }
})

// POST /api/incidents/investigate { sessionId, taskId? } — manual incident.
// Captures an evidence bundle NOW (before logs rotate), then opens a
// trigger:'manual' incident pointing at the frozen bundle.
incidentsRouter.post('/investigate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId, taskId } = req.body as { sessionId?: string; taskId?: string }

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    if (taskId !== undefined && typeof taskId !== 'string') {
      res.status(400).json({ error: 'taskId must be a string' })
      return
    }

    log.obs.info('manual investigate requested', { sessionId, taskId })

    // Freeze the evidence bundle first. A capture failure must NOT block opening
    // the incident — we still want the case file, just without a bundle path.
    let bundlePath: string | undefined
    try {
      bundlePath = await captureBundle(sessionId)
    } catch (err) {
      log.obs.warn('manual investigate: bundle capture failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const incident = await createIncident({
      sessionId,
      ...(taskId ? { taskId } : {}),
      trigger: 'manual',
      label: 'manual',
      summary: 'User-initiated investigation',
      severity: 'warn',
      status: 'open',
      ...(bundlePath ? { bundlePath } : {}),
    })

    log.obs.info('manual incident created', { sessionId, incidentId: incident.id, bundlePath })
    res.json({ incident })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/incidents/:id { status } — update incident lifecycle status.
incidentsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { status } = req.body as { status?: string }

    if (!status || !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
      return
    }

    const incident = await updateIncidentStatus(id, status as IncidentStatus)
    if (!incident) {
      res.status(404).json({ error: 'incident not found' })
      return
    }
    res.json({ incident })
  } catch (err) {
    next(err)
  }
})

/**
 * Focus Bar routes — manage pinned tasks via task-level fields.
 *
 * Pin state lives on each Task object (pinned + pin_order + focus_tier fields).
 * Three tiers: focus (current sprint), next (queued sprint), satellite (backlog).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { togglePin, reorderPins, getPinnedTasks, setFocusTier } from '../../core/task-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs with 3-tier split
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pinned = await getPinnedTasks()
    res.json({
      pinned_tasks: pinned.map((t) => t.id),
      focus_tasks: pinned.filter((t) => t.focus_tier === 'focus').map((t) => t.id),
      next_tasks: pinned.filter((t) => t.focus_tier === 'next').map((t) => t.id),
      satellite_tasks: pinned.filter((t) => !t.focus_tier).map((t) => t.id),
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/focus/tasks/:id — pin a task
focusRouter.post('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const current = await getPinnedTasks()
    if (current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Cannot pin a completed task')) {
      res.status(409).json({ error: err.message })
      return
    }
    next(err)
  }
})

// DELETE /api/focus/tasks/:id — unpin a task
focusRouter.delete('/tasks/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const current = await getPinnedTasks()
    if (!current.some((t) => t.id === taskId)) {
      res.json({ pinned_tasks: current.map((t) => t.id) })
      return
    }
    const result = await togglePin(taskId)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: result.pinned_tasks })
  } catch (err) {
    next(err)
  }
})

// PUT /api/focus/reorder — reorder pinned tasks
focusRouter.put('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task_ids } = req.body as { task_ids: string[] }
    if (!Array.isArray(task_ids)) {
      res.status(400).json({ error: 'task_ids must be an array of strings' })
      return
    }
    const ordered = await reorderPins(task_ids)
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
    res.json({ pinned_tasks: ordered })
  } catch (err) {
    next(err)
  }
})

const VALID_TIERS = ['focus', 'next', 'satellite'] as const

// PUT /api/focus/tasks/:id/tier — set tier (focus / next / satellite)
focusRouter.put('/tasks/:id/tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskId = req.params.id as string
    const { tier } = req.body as { tier: string }
    if (!VALID_TIERS.includes(tier as typeof VALID_TIERS[number])) {
      res.status(400).json({ error: `tier must be one of: ${VALID_TIERS.join(', ')}` })
      return
    }
    const result = await setFocusTier(taskId, tier as typeof VALID_TIERS[number])
    res.json(result)
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('Task not found') || err.message.startsWith('Task is not pinned'))) {
      res.status(400).json({ error: err.message })
      return
    }
    next(err)
  }
})

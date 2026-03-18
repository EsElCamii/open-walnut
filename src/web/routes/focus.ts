/**
 * Focus Bar routes — manage pinned tasks via task-level fields.
 *
 * Pin state lives on each Task object (pinned + pin_order fields).
 * Legacy config.yaml pin lists (if any) are ignored — do not add migration code.
 * Users can pin any number of tasks. The Focus Dock UI shows only the first 3;
 * the Todo Sidebar pinned section shows all.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { togglePin, reorderPins, getPinnedTasks } from '../../core/task-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const focusRouter = Router()

// GET /api/focus/tasks — list pinned task IDs (sorted by pin_order)
focusRouter.get('/tasks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pinned = await getPinnedTasks()
    res.json({ pinned_tasks: pinned.map((t) => t.id) })
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

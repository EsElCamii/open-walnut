/**
 * Notification center routes — the durable feed behind the bell icon.
 *
 * Backs the persistent feed + unread badge in NotificationPanel. Realtime toasts
 * still arrive over WebSocket (cron:notification, session:permission-request);
 * this endpoint is the on-load snapshot + the read-state mutator so the feed and
 * unread count survive a refresh. Store lives in core/notifications/store.ts.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { listNotifications, markRead } from '../../core/notifications/store.js'

export const notificationsRouter = Router()

// GET /api/notifications — feed (newest-last) + unread count.
notificationsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { feed, unreadCount } = await listNotifications()
    res.json({ feed, unreadCount })
  } catch (err) {
    next(err)
  }
})

// POST /api/notifications/mark-read { ids? } — mark some (or, with no ids, all)
// notifications read. Returns the resulting unread count.
notificationsRouter.post('/mark-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body as { ids?: string[] }
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) {
      res.status(400).json({ error: 'ids must be an array of strings' })
      return
    }
    const { unreadCount } = await markRead(ids)
    res.json({ unreadCount })
  } catch (err) {
    next(err)
  }
})

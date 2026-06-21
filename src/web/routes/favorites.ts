/**
 * Favorites routes — manage category/project/note favorites via config.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

export const favoritesRouter = Router()

// GET /api/favorites
favoritesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({
      categories: config.favorites?.categories ?? [],
      projects: config.favorites?.projects ?? [],
      notes: config.favorites?.notes ?? [],
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/favorites/categories/:name — add category favorite
favoritesRouter.post('/categories/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = decodeURIComponent(req.params.name as string)
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.categories) config.favorites.categories = []
    if (!config.favorites.categories.includes(name)) {
      config.favorites.categories.push(name)
    }
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ categories: config.favorites.categories })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/favorites/categories/:name — remove category favorite
favoritesRouter.delete('/categories/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = decodeURIComponent(req.params.name as string)
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.categories = (config.favorites.categories ?? []).filter((c) => c !== name)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ categories: config.favorites.categories })
  } catch (err) {
    next(err)
  }
})

// POST /api/favorites/projects/:name — add project favorite
favoritesRouter.post('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = decodeURIComponent(req.params.name as string)
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.projects) config.favorites.projects = []
    if (!config.favorites.projects.includes(name)) {
      config.favorites.projects.push(name)
    }
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ projects: config.favorites.projects })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/favorites/projects/:name — remove project favorite
favoritesRouter.delete('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = decodeURIComponent(req.params.name as string)
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.projects = (config.favorites.projects ?? []).filter((p) => p !== name)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ projects: config.favorites.projects })
  } catch (err) {
    next(err)
  }
})

// Note favorites carry the vault-relative path (slashes + .md) in the request BODY
// rather than a URL param, since path-encoding slash-bearing names is fragile.

// POST /api/favorites/notes — add note favorite { path }
favoritesRouter.post('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = req.body?.path
    if (typeof path !== 'string' || !path) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.notes) config.favorites.notes = []
    if (!config.favorites.notes.includes(path)) {
      config.favorites.notes.push(path)
    }
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/favorites/notes — remove note favorite { path } (or ?path=)
favoritesRouter.delete('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = (req.body?.path ?? req.query.path) as unknown
    if (typeof path !== 'string' || !path) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.notes = (config.favorites.notes ?? []).filter((p) => p !== path)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})

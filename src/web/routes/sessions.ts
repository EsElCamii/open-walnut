/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { listSessions, getRecentSessions, getSessionSummaries, getSessionsForTask, getSessionByClaudeId, updateSessionRecord, isTriageSession } from '../../core/session-tracker.js'
import { readSessionHistory, extractPlanContent, rewriteHistoryRemoteImages } from '../../core/session-history.js'
import { listTasks, getTask, addTask, updateTask } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import fs from 'node:fs'
import path from 'path'
import { isSessionProcessAlive } from '../../utils/session-liveness.js'
import { readPlanFromSession, buildPlanExecutionMessage } from '../../utils/plan-message.js'
import { getFrequentDirs, compileFromSessions } from '../../core/frequent-dirs.js'
import type { SessionRecord, Task } from '../../core/types.js'
import type { SessionHistoryMessage } from '../../core/session-history.js'
import { processAndSaveImages, buildSessionImageContext } from './images.js'
import type { ImagePayload } from './images.js'

/** Diagnose message ordering — logs whether user text messages are interleaved or bunched at end. */
function logMessageOrdering(phase: string, sessionId: string, messages: SessionHistoryMessage[], host?: string): void {
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i].text?.trim()) userIndices.push(i)
  }
  if (userIndices.length <= 1) return // no diagnostic needed for 0-1 user messages
  const lastAsst = messages.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1)
  const usersAfterLastAsst = userIndices.filter(i => i > lastAsst).length
  const bunched = usersAfterLastAsst > userIndices.length / 2
  if (!bunched) return // only log anomalies — skip normal cases to reduce production noise
  log.web.warn('session history: user messages bunched at end', {
    phase,
    sessionId: sessionId.substring(0, 8),
    host: host ?? 'local',
    total: messages.length,
    userText: userIndices.length,
    lastAsstIdx: lastAsst,
    usersAfterLastAsst,
  })
}

/** Recompute process_status live via PID check (for GET responses).
 *  Runs all PID checks in parallel to avoid blocking the event loop. */
async function enrichWithLiveStatus(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  // Parallel liveness checks via unified session liveness utility.
  // Routes to local PID check for local sessions, daemon connection check for remote.
  const needsCheck: number[] = []
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    if (s.process_status === 'running' || s.process_status === 'idle') {
      needsCheck.push(i)
    }
  }

  if (needsCheck.length > 0) {
    const results = await Promise.allSettled(
      needsCheck.map(i => isSessionProcessAlive(sessions[i]))
    )
    for (let j = 0; j < needsCheck.length; j++) {
      const r = results[j]
      const alive = r.status === 'fulfilled' && r.value === true
      if (!alive) {
        sessions[needsCheck[j]].process_status = 'stopped'
      }
    }
  }

  return sessions
}

/** Resolve host aliases to full hostnames from config (for tooltip display). */
async function enrichWithHostnames(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  const hostsNeeded = sessions.some(s => s.host && !s.hostname)
  if (!hostsNeeded) return sessions
  try {
    const config = await getConfig()
    const hosts = config.hosts
    if (!hosts) return sessions
    for (const s of sessions) {
      if (s.host && !s.hostname) {
        const def = hosts[s.host]
        if (def) {
          s.hostname = def.hostname
        }
      }
    }
  } catch { /* config read failure — non-critical */ }
  return sessions
}

export const sessionsRouter = Router()

// GET /api/sessions/working-dirs — deduplicated working directories from persistent store
sessionsRouter.get('/working-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    const defaultCat = config.defaults?.category ?? 'Inbox'
    const now = Date.now()

    // Find max age and max count for normalization
    let maxAgeMs = 1
    let maxCount = 1
    for (const d of dirs) {
      const age = now - new Date(d.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (d.count > maxCount) maxCount = d.count
    }

    // Compute score, hostLabel, resolved category at read time
    const entries = dirs.map(d => {
      // Majority vote for category
      let bestCat = defaultCat
      let bestCount = 0
      for (const [cat, cnt] of Object.entries(d.categoryVotes)) {
        if (cnt > bestCount) { bestCat = cat; bestCount = cnt }
      }

      const hostLabel = d.host ? hosts[d.host]?.label ?? d.host : undefined
      const ageMs = now - new Date(d.lastUsed).getTime()
      const recencyScore = 1 - (ageMs / maxAgeMs)
      const freqScore = d.count / maxCount
      const score = freqScore * 0.3 + recencyScore * 0.7

      return {
        cwd: d.cwd,
        host: d.host,
        hostLabel,
        category: bestCat,
        count: d.count,
        lastUsed: d.lastUsed,
        score,
      }
    })

    entries.sort((a, b) => b.score - a.score)
    const result = entries.map(({ score: _s, ...rest }) => rest)
    res.json({ dirs: result })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/working-dirs/recompile — rebuild frequent-directories.json from sessions
sessionsRouter.post('/working-dirs/recompile', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // compileFromSessions imported statically at top
    await compileFromSessions()
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    res.json({ status: 'ok', count: dirs.length })
  } catch (err) {
    next(err)
  }
})

// In-memory cache for SSH directory listings (avoid re-SSHing for 60s)
const dirCache = new Map<string, { dirs: string[]; ts: number }>()
const DIR_CACHE_TTL = 60_000

// GET /api/sessions/list-dirs — list subdirectories on a host (local or daemon) for path auto-complete
// Remote hosts use DaemonConnection for fast directory listing.
sessionsRouter.get('/list-dirs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prefix = String(req.query.prefix ?? '/')
    const host = req.query.host as string | undefined
    const depth = Math.min(Number(req.query.depth) || 2, 4) // preload depth, default 2, max 4

    if (prefix.length > 4096) {
      res.status(400).json({ error: 'prefix too long' })
      return
    }

    // Sanitize: no shell metacharacters allowed in prefix
    if (/[;&|`$(){}!<>]/.test(prefix)) {
      res.status(400).json({ error: 'invalid characters in prefix' })
      return
    }

    // Expand ~ to home directory
    let expandedPrefix = prefix
    if (expandedPrefix === '~' || expandedPrefix.startsWith('~/')) {
      if (host) {
        // Remote: keep ~ as-is — the daemon's fs.ls handles ~ expansion on the remote host
      } else {
        const os = await import('node:os')
        const home = os.homedir()
        // Preserve trailing slash: ~/ → /Users/me/, ~/foo → /Users/me/foo
        expandedPrefix = home + expandedPrefix.slice(1)
      }
    }

    // Find the parent directory to list.
    // Partial matching is handled by the frontend's filterChildren — backend returns all entries.
    const dir = expandedPrefix.endsWith('/') ? expandedPrefix : path.dirname(expandedPrefix)

    if (host) {
      // Remote: resolve host from config and use DaemonConnection for directory listing
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef) {
        res.status(400).json({ error: `Unknown host: ${host}` })
        return
      }
      const hostname = hostDef.hostname
      if (!hostname) {
        res.status(400).json({ error: `Host "${host}" has no hostname` })
        return
      }

      // Check in-memory cache first
      const cacheKey = `${host}::${dir}::${depth}`
      const cached = dirCache.get(cacheKey)
      if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
        res.json({ dirs: cached.dirs, parent: dir, cached: true })
        return
      }

      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
      const conn = await getDaemonConnection(host, sshTarget)

      // Recursive BFS directory listing via daemon's fs.ls command.
      // The daemon's fs.ls expands ~ to the remote home directory.
      const entries: string[] = []
      let resolvedDir = dir

      // First call resolves ~ and gives us the real base path
      const rootResult = await conn.send('fs.ls', { path: dir })
      if (!rootResult.ok) {
        res.status(400).json({ error: `Cannot list directory: ${rootResult.error ?? dir}` })
        return
      }
      if (rootResult.resolvedPath && typeof rootResult.resolvedPath === 'string') {
        resolvedDir = (rootResult.resolvedPath as string).endsWith('/')
          ? rootResult.resolvedPath as string
          : rootResult.resolvedPath + '/'
      }

      // Process root entries, then BFS walk
      const queue: { dirPath: string; currentDepth: number }[] = []
      const rootEntries = rootResult.entries as Array<{ name: string; type: string }>
      for (const e of rootEntries) {
        if (e.type !== 'dir' || e.name.startsWith('.')) continue
        const fullPath = resolvedDir.endsWith('/')
          ? `${resolvedDir}${e.name}`
          : `${resolvedDir}/${e.name}`
        entries.push(fullPath)
        if (depth > 1) {
          queue.push({ dirPath: fullPath, currentDepth: 1 })
        }
      }

      while (queue.length > 0 && entries.length < 500) {
        const batch = queue.splice(0, queue.length)
        for (const item of batch) {
          if (entries.length >= 500) break
          try {
            const result = await conn.send('fs.ls', { path: item.dirPath })
            if (!result.ok) continue
            const lsEntries = result.entries as Array<{ name: string; type: string }>
            for (const e of lsEntries) {
              if (entries.length >= 500) break
              if (e.type !== 'dir' || e.name.startsWith('.')) continue
              const fullPath = `${item.dirPath}/${e.name}`
              entries.push(fullPath)
              if (item.currentDepth + 1 < depth) {
                queue.push({ dirPath: fullPath, currentDepth: item.currentDepth + 1 })
              }
            }
          } catch {
            // Directory unreadable or daemon error — skip
          }
        }
      }

      // Cache results
      const resolvedCacheKey = `${host}::${resolvedDir}::${depth}`
      dirCache.set(cacheKey, { dirs: entries, ts: Date.now() })
      if (resolvedCacheKey !== cacheKey) {
        dirCache.set(resolvedCacheKey, { dirs: entries, ts: Date.now() })
      }

      res.json({ dirs: entries, parent: resolvedDir })
    } else {
      // Local filesystem — also preload multiple levels
      const entries: string[] = []
      const walkLocal = (d: string, currentDepth: number) => {
        if (currentDepth > depth || entries.length >= 500) return
        try {
          const names = fs.readdirSync(d)
          for (const name of names) {
            if (entries.length >= 500) break
            // Skip hidden directories
            if (name.startsWith('.')) continue
            const full = path.join(d, name)
            try {
              if (fs.statSync(full).isDirectory()) {
                entries.push(full)
                if (currentDepth < depth) walkLocal(full, currentDepth + 1)
              }
            } catch { /* skip unreadable */ }
          }
        } catch { /* dir doesn't exist */ }
      }
      walkLocal(dir, 1)

      res.json({ dirs: entries, parent: dir })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // SSH failures return 400, not 500
    res.status(400).json({ error: msg })
  }
})

// POST /api/sessions/quick-start — create task + start session in one step
sessionsRouter.post('/quick-start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cwd, host, message, category, model, mode, images, taskId: existingTaskId } = req.body as {
      cwd: string
      host?: string
      message: string
      category?: string
      model?: string
      mode?: string
      images?: ImagePayload[]
      taskId?: string // retry mode: reuse existing task instead of creating a new one
    }

    if (!cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd is required' })
      return
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' })
      return
    }

    if (mode) {
      const validModes = ['bypass', 'accept', 'default', 'plan']
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
        return
      }
    }

    // Length limits
    if (cwd.length > 4096) {
      res.status(400).json({ error: 'cwd too long (max 4096 chars)' })
      return
    }
    if (message.length > 50000) {
      res.status(400).json({ error: 'message too long (max 50000 chars)' })
      return
    }

    // Process attached images — save to disk and build session-friendly context
    let sessionMessage = message
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) {
        const imageContext = buildSessionImageContext(processed.savedImages)
        sessionMessage = imageContext + message
      }
    }

    const config = await getConfig()
    const taskCategory = category || config.defaults?.category || 'Inbox'

    let updatedTask: Task

    if (existingTaskId) {
      // Retry mode: reuse existing task, archive error sessions
      updatedTask = await getTask(existingTaskId)
      if (!updatedTask) {
        res.status(404).json({ error: `Task "${existingTaskId}" not found` })
        return
      }
      // Archive all error/stopped sessions under this task to free the slot
      const existingSessions = await getSessionsForTask(updatedTask.id)
      for (const s of existingSessions) {
        if (!s.archived && (s.process_status === 'error' || s.process_status === 'stopped')) {
          await updateSessionRecord(s.claudeSessionId, { archived: true, archive_reason: 'retry' })
          try {
            const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
            await clearSession(updatedTask.id, s.claudeSessionId)
            await clearSessionSlot(updatedTask.id, s.claudeSessionId)
          } catch { /* task may not exist */ }
        }
      }
    } else {
      // Normal mode: create new task
      const title = `Session: ${path.basename(cwd.replace(/\/+$/, '') || '/')}`
      const { task } = await addTask({
        title,
        category: taskCategory,
        project: 'Quick Start',
      })
      await updateTask(task.id, { starred: true, cwd }, { source: 'quick-start' })
      updatedTask = await getTask(task.id)
    }

    if (!existingTaskId) {
      bus.emit(EventNames.TASK_CREATED, { task: updatedTask }, ['web-ui', 'main-agent'], { source: 'quick-start' })
    }

    // Build system prompt hint for session AI
    const appendSystemPrompt = [
      '<quick_start_task>',
      'This task was created via Quick Start. When your work is complete:',
      '1. Update the task title to be descriptive (replace the generic "Session: ..." title) using update_task',
      `2. If "${taskCategory} / Quick Start" is not the right project, move the task to the correct project within the same category "${taskCategory}" using update_task with the project field`,
      '</quick_start_task>',
    ].join('\n')

    // Emit SESSION_START event (sessionMessage includes image path annotations if images were attached)
    bus.emit(EventNames.SESSION_START, {
      taskId: updatedTask.id,
      message: sessionMessage,
      cwd,
      project: 'Quick Start',
      mode,
      model,
      host,
      appendSystemPrompt,
    }, ['session-runner'], { source: 'quick-start' })

    log.web.info('quick-start: created task + started session', { taskId: updatedTask.id, cwd, host, category: taskCategory, retry: !!existingTaskId })

    res.json({ taskId: updatedTask.id, task: updatedTask })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/tree — sessions grouped by task hierarchy
sessionsRouter.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hideCompleted = req.query.hideCompleted === 'true'
    const sessions = await enrichWithHostnames(await enrichWithLiveStatus(await listSessions()))
    const tasks = await listTasks()
    const config = await getConfig()
    const favCats: string[] = config.favorites?.categories ?? []
    const favProjs: string[] = config.favorites?.projects ?? []

    // Build taskId → sessions map
    const taskSessionMap = new Map<string, SessionRecord[]>()
    const orphanSessions: SessionRecord[] = []
    const taskMap = new Map<string, Task>()

    for (const t of tasks) {
      taskMap.set(t.id, t)
    }

    for (const s of sessions) {
      // Triage subagent runs are high-volume housekeeping — exclude from session tree.
      // Non-triage embedded sessions (e.g. general agent) are shown.
      if (isTriageSession(s)) continue
      if (s.archived) continue
      // hideCompleted now uses task.phase (checked at display layer) — sessions no longer carry work_status
      if (!s.taskId || !taskMap.has(s.taskId)) {
        orphanSessions.push(s)
      } else {
        const list = taskSessionMap.get(s.taskId) ?? []
        list.push(s)
        taskSessionMap.set(s.taskId, list)
      }
    }

    // Build hierarchy from tasks that have sessions
    interface TreeTask { taskId: string; taskTitle: string; taskStatus: string; taskPriority: string; taskStarred: boolean; sessions: SessionRecord[] }
    interface TreeProject { project: string; tasks: TreeTask[] }
    interface TreeCategory { category: string; projects: TreeProject[]; directTasks: TreeTask[] }

    const categoryMap = new Map<string, { projects: Map<string, TreeTask[]>; directTasks: TreeTask[] }>()

    for (const [taskId, taskSessions] of taskSessionMap) {
      const task = taskMap.get(taskId)!
      const treeTask: TreeTask = {
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        taskPriority: task.priority,
        taskStarred: !!task.starred
          || favCats.some(c => c.toLowerCase() === (task.category || '').toLowerCase())
          || favProjs.some(p => p.toLowerCase() === (task.project || '').toLowerCase()),
        sessions: taskSessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      }

      const cat = task.category || 'Uncategorized'
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { projects: new Map(), directTasks: [] })
      }
      const catEntry = categoryMap.get(cat)!

      if (!task.project || task.project === cat) {
        catEntry.directTasks.push(treeTask)
      } else {
        const projTasks = catEntry.projects.get(task.project) ?? []
        projTasks.push(treeTask)
        catEntry.projects.set(task.project, projTasks)
      }
    }

    // Convert to array
    const tree: TreeCategory[] = []
    for (const [cat, entry] of categoryMap) {
      const projects: TreeProject[] = []
      for (const [proj, projTasks] of entry.projects) {
        projects.push({ project: proj, tasks: projTasks })
      }
      tree.push({ category: cat, projects, directTasks: entry.directTasks })
    }

    // Sort categories alphabetically
    tree.sort((a, b) => a.category.localeCompare(b.category))

    res.json({ tree, orphanSessions })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions
sessionsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await listSessions()
    const sessions = all.filter(s => !isTriageSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/recent
sessionsRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const all = await getRecentSessions(limit)
    const sessions = all.filter(s => !isTriageSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/summaries
sessionsRouter.get('/summaries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const summaries = await getSessionSummaries(limit)
    res.json({ summaries })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/task/:taskId
sessionsRouter.get('/task/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Resolve task ID prefix to full ID (frontend may pass short prefix from URL params)
    let taskId = String(req.params.taskId)
    try {
      const task = await getTask(taskId)
      taskId = task.id
    } catch { /* task not found — use raw param as-is */ }
    const all = await getSessionsForTask(taskId)
    // Exclude triage subagent runs (archived sessions kept — frontend needs them for collapsed section)
    const sessions = all.filter(s => !isTriageSession(s))
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId
sessionsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionByClaudeId(String(req.params.sessionId))
    if (!session) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const [enriched] = await enrichWithHostnames(await enrichWithLiveStatus([session]))
    res.json({ session: enriched })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/sessions/:sessionId
sessionsRouter.patch('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, activity, human_note, archived, archive_reason } = req.body as { title?: string; activity?: string; human_note?: string; archived?: boolean; archive_reason?: string }

    if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
      res.status(400).json({ error: 'title must be a string (max 500 chars)' })
      return
    }

    if (human_note !== undefined && (typeof human_note !== 'string' || human_note.length > 50000)) {
      res.status(400).json({ error: 'human_note must be a string (max 50000 chars)' })
      return
    }

    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }

    const sessionId = String(req.params.sessionId)

    // Archive/unarchive: validate session is stopped before archiving
    if (archived === true) {
      const existing = await getSessionByClaudeId(sessionId)
      if (!existing) {
        res.status(404).json({ error: 'session not found' })
        return
      }
      if (existing.process_status !== 'stopped') {
        res.status(400).json({ error: 'Stop session before archiving' })
        return
      }
    }

    const updates: Partial<SessionRecord> = {}
    if (title !== undefined) updates.title = title
    if (activity !== undefined) updates.activity = activity
    if (human_note !== undefined) updates.human_note = human_note
    if (archived !== undefined) {
      updates.archived = archived
      if (archived && archive_reason) updates.archive_reason = archive_reason
      if (!archived) updates.archive_reason = undefined  // clear reason on unarchive
    }

    const updated = await updateSessionRecord(sessionId, updates)
    log.web.info('session updated via REST', { sessionId, fields: Object.keys(updates) })

    // Emit status change so frontend updates in real time
    if (archived !== undefined) {
      bus.emit(EventNames.SESSION_STATUS_CHANGED, {
        sessionId,
        taskId: updated.taskId,
        process_status: updated.process_status,
        activity: updated.activity,
        mode: updated.mode,
        ...(updated.planCompleted ? { planCompleted: true } : {}),
        ...(archived !== undefined ? { archived } : {}),
      }, ['web-ui'])
    }

    // Archive: clear task session slot to free it for new sessions
    if (archived === true && updated.taskId) {
      try {
        const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
        await clearSession(updated.taskId, sessionId)
        const { task } = await clearSessionSlot(updated.taskId, sessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-archived' })
      } catch { /* task may not exist */ }
    }

    res.json({ session: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      res.status(404).json({ error: message })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId/history
// ?source=streams — fast path: local-only reads (skip SSH).
// Local sessions: reads canonical JSONL (~1ms, same result as full path).
// Remote sessions: returns empty (no local files exist for remote sessions).
sessionsRouter.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const source = req.query.source as string | undefined
    const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined

    // Look up session record to get cwd
    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd

    if (source === 'streams') {
      // Fast path: host=undefined forces local-only reads (canonical JSONL + streams fallback).
      // Skips SSH entirely. For local sessions this returns full data (~1ms).
      // For remote sessions this returns empty (they have no local files).
      const messages = await readSessionHistory(sessionId, cwd, undefined, record?.outputFile)
      logMessageOrdering('P1:streams', sessionId, messages, record?.host)
      const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
      res.json({ messages: sliced, total: messages.length })
      return
    }

    // Full path: reads from source of truth (SSH for remote sessions)
    let messages: Awaited<ReturnType<typeof readSessionHistory>>
    try {
      messages = await readSessionHistory(sessionId, cwd, record?.host, record?.outputFile)
    } catch (err) {
      // Surface remote read errors (SSH auth, daemon connection, etc.) to the frontend
      const msg = err instanceof Error ? err.message : String(err)
      log.web.warn('session history read failed', { sessionId, host: record?.host, error: msg })
      res.status(502).json({ error: msg })
      return
    }
    logMessageOrdering('P2:full', sessionId, messages, record?.host)
    if (messages.length === 0 && !record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Rewrite remote image paths to local paths for remote sessions
    if (record?.host) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd)
    }

    // Fork-aware: prepend source session history when this session was forked.
    // Follows the fork chain (A forked from B forked from C) with cycle detection.
    let forkedFromSessionId: string | undefined
    let forkBoundaryIndex: number | undefined
    if (record?.forkedFromSessionId) {
      forkedFromSessionId = record.forkedFromSessionId
      try {
        const forkChainMessages: typeof messages[] = []
        const visited = new Set<string>([sessionId])
        let currentForkId: string | undefined = record.forkedFromSessionId

        while (currentForkId && !visited.has(currentForkId)) {
          visited.add(currentForkId)
          const sourceRecord = await getSessionByClaudeId(currentForkId)
          if (!sourceRecord) break

          let sourceMessages = await readSessionHistory(
            currentForkId, sourceRecord.cwd, sourceRecord.host, sourceRecord.outputFile,
          )
          if (sourceRecord.host) {
            sourceMessages = await rewriteHistoryRemoteImages(sourceMessages, sourceRecord.host, currentForkId, sourceRecord.cwd)
          }
          if (sourceMessages.length > 0) {
            forkChainMessages.unshift(sourceMessages)
          }
          currentForkId = sourceRecord.forkedFromSessionId
        }

        if (forkChainMessages.length > 0) {
          const allSourceMessages = forkChainMessages.flat()
          messages = [...allSourceMessages, ...messages]
          forkBoundaryIndex = allSourceMessages.length
        }
      } catch (err) {
        log.web.warn('failed to load fork source history', {
          sessionId, forkedFrom: record.forkedFromSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const total = messages.length
    const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
    // Adjust forkBoundaryIndex for the sliced window
    const adjustedForkBoundary = forkBoundaryIndex != null && tail && tail > 0
      ? (forkBoundaryIndex >= total - tail ? forkBoundaryIndex - (total - tail) : undefined)
      : forkBoundaryIndex
    res.json({
      messages: sliced,
      total,
      ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
      ...(adjustedForkBoundary != null ? { forkBoundaryIndex: adjustedForkBoundary } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/plan — read plan content for a plan session (or its source plan session)
sessionsRouter.get('/:sessionId/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // If this is an execution session with fromPlanSessionId, follow the link to the source plan session
    const planSessionId = record.fromPlanSessionId ?? sessionId
    const isFollowedLink = planSessionId !== sessionId

    // Strategy 1: readPlanFromSession (planFile on disk, or JSONL slug → file)
    const planResult = await readPlanFromSession(planSessionId)
    if (!('error' in planResult)) {
      res.json({
        content: planResult.content,
        planFile: planResult.planFile,
        sourceSessionId: isFollowedLink ? planSessionId : undefined,
      })
      return
    }

    // Strategy 2: extractPlanContent from JSONL (Write to plans/ or ExitPlanMode.input.plan)
    const planRecord = isFollowedLink ? await getSessionByClaudeId(planSessionId) : record
    if (planRecord) {
      const extracted = await extractPlanContent(planSessionId, planRecord.cwd, planRecord.host)
      if (extracted) {
        res.json({
          content: extracted,
          planFile: planRecord.planFile ?? undefined,
          sourceSessionId: isFollowedLink ? planSessionId : undefined,
        })
        return
      }
    }

    res.status(404).json({ error: 'No plan content found for this session' })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-continue — resume a completed plan session with bypass permissions
sessionsRouter.post('/:sessionId/execute-continue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const session = await getSessionByClaudeId(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!session.planCompleted) {
      res.status(400).json({ error: 'Not a completed plan session' })
      return
    }
    // Update mode to bypass for execution
    await updateSessionRecord(session.claudeSessionId, { mode: 'bypass' })

    // If session process is alive (running or idle), stop it first
    // so it restarts with bypass permissions via --resume
    const needsInterrupt = session.process_status !== 'stopped'

    const message = 'Execute the plan. Implement all steps as planned.'
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    await sendMessageToSession(session.claudeSessionId, message, {
      source: 'web-api',
      taskId: session.taskId,
      mode: 'bypass',
      interrupt: needsInterrupt || undefined,
    })

    log.web.info('execute-continue: resuming plan session with bypass', { sessionId: session.claudeSessionId })

    res.json({ status: 'started', sessionId: session.claudeSessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute — execute a completed plan session
sessionsRouter.post('/:sessionId/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const planSessionId = req.params.sessionId as string
    const { task_id, working_directory, instructions, mode, host } = req.body as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
      host?: string
    }

    // Read plan file via shared resolver (same logic as agent tool's from_plan path)
    const planResult = await readPlanFromSession(planSessionId)
    if ('error' in planResult) {
      // Distinguish "session not found" (404) from "session exists but not a plan" (400)
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const record = await getSessionByClaudeId(planSessionId)
    const taskId = task_id ?? record?.taskId
    const cwd = working_directory ?? record?.cwd
    if (!cwd) {
      res.status(400).json({ error: 'working_directory is required (plan session has no stored cwd).' })
      return
    }

    const validModes = ['bypass', 'accept', 'default', 'plan']
    if (mode && !validModes.includes(mode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
      return
    }
    const execMode = mode ?? 'bypass'

    // Build message with plan content + file path reference (survives compaction via re-read).
    const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, instructions)

    // Use host from request body, or inherit from the plan session
    const execHost = host ?? record?.host

    // Archive the plan session (hidden from UI) and preserve planContent
    await updateSessionRecord(planSessionId, {
      archived: true,
      archive_reason: 'plan_executed',
      planContent: planResult.content,
    })
    log.web.info('execute: archived plan session', { planSessionId })

    // Clear task session slot so UI no longer shows archived plan as active
    if (taskId) {
      try {
        const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
        await clearSession(taskId, planSessionId)
        const { task } = await clearSessionSlot(taskId, planSessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-archived' })
      } catch { /* task may not exist */ }
    }

    // Notify frontend about the archive
    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: planSessionId,
      taskId: taskId ?? '',
      archived: true,
    }, ['web-ui'])

    // Set up a temporary bus listener BEFORE emitting SESSION_START so we
    // catch the status-changed event that carries the new session's ID.
    const WAIT_TIMEOUT_MS = 30_000
    const subName = `exec-wait-${planSessionId}`
    const newSessionPromise = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subName)
        resolve(undefined)
      }, WAIT_TIMEOUT_MS)

      bus.subscribe(subName, (event) => {
        if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
        const d = eventData<'session:status-changed'>(event)
        if (d.fromPlanSessionId === planSessionId && d.sessionId) {
          clearTimeout(timer)
          bus.unsubscribe(subName)
          resolve(d.sessionId)
        }
      }, { global: true })
    })

    bus.emit(EventNames.SESSION_START, {
      taskId: taskId ?? '',
      message: planMessage,
      cwd,
      project: record?.project ?? '',
      mode: execMode,
      title: `Execute plan from ${planSessionId.slice(0, 16)}...`,
      ...(execHost ? { host: execHost } : {}),
      fromPlanSessionId: planSessionId,
    }, ['session-runner'], { source: 'web-api' })

    // Wait for the new session to start (up to 30s) so we can return its ID
    const newSessionId = await newSessionPromise

    res.json({ status: 'started', planSessionId, taskId, mode: execMode, ...(newSessionId ? { sessionId: newSessionId } : {}), ...(execHost ? { host: execHost } : {}) })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/retry — retry a failed session
// Two paths: (1) resume via --resume if claudeSessionId exists (preserves history),
// (2) fallback to archive+new if no claudeSessionId (session failed before init).
sessionsRouter.post('/:sessionId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Only allow retry on failed/stopped sessions
    if (record.process_status !== 'error' && record.process_status !== 'stopped') {
      res.status(400).json({ error: `Session is ${record.process_status}, not retryable` })
      return
    }
    if (!record.taskId) {
      res.status(400).json({ error: 'Session has no associated task' })
      return
    }

    // ── Resume path: session has claudeSessionId → use --resume to preserve history ──
    // Don't touch process_status here — processNext() handles the full transition:
    // work_status='in_progress', clear errorMessage, emit status event, spawn --resume.
    // enrichWithLiveStatus() only checks running/idle sessions, so 'error' won't flash.
    if (record.claudeSessionId) {
      const { sendMessageToSession } = await import('../../core/session-message-queue.js')
      await sendMessageToSession(sessionId, 'Continue where you left off — connection was restored.', {
        source: 'retry',
        taskId: record.taskId,
      })
      log.web.info('session retry: resuming via --resume', { sessionId, taskId: record.taskId })
      res.json({ status: 'resuming', sessionId })
      return
    }

    // ── Fallback: no claudeSessionId (failed before init) → archive + start new ──
    const task = await getTask(record.taskId)
    if (!task) {
      res.status(404).json({ error: 'Associated task not found' })
      return
    }

    await updateSessionRecord(sessionId, { archived: true, archive_reason: 'retry' })
    try {
      const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
      await clearSession(task.id, sessionId)
      await clearSessionSlot(task.id, sessionId)
    } catch { /* task may not exist */ }

    let retryMessage = 'Retry session'
    try {
      const messages = await readSessionHistory(sessionId, record.cwd, record.host, record.outputFile)
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser?.text) retryMessage = firstUser.text
    } catch { /* history may be unavailable */ }

    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: retryMessage,
      cwd: record.cwd,
      project: task.project ?? '',
      mode: record.mode !== 'default' ? record.mode : undefined,
      model: record.model,
      host: record.host,
    }, ['session-runner'], { source: 'retry' })

    log.web.info('session retry: no claudeSessionId, started new session', {
      oldSessionId: sessionId, taskId: task.id,
    })
    res.json({ status: 'pending', taskId: task.id, oldSessionId: sessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/fork — fork a session to a different task
sessionsRouter.post('/:sessionId/fork', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceSessionId = req.params.sessionId as string
    const { task_id, create_child_task, child_title, message, title, model } = req.body as {
      task_id?: string
      create_child_task?: boolean
      child_title?: string
      message?: string
      title?: string
      model?: string
    }

    if (!task_id && !create_child_task) {
      res.status(400).json({ error: 'Either task_id or create_child_task is required' })
      return
    }
    if (task_id && create_child_task) {
      res.status(400).json({ error: 'task_id and create_child_task are mutually exclusive' })
      return
    }

    // Look up source session
    const sourceRecord = await getSessionByClaudeId(sourceSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Source session not found' })
      return
    }

    // Validate source session has a working directory BEFORE creating any child tasks
    if (!sourceRecord.cwd) {
      res.status(400).json({ error: 'Source session has no working directory — cannot fork' })
      return
    }

    let task: Task | undefined
    let childTaskCreated = false

    if (create_child_task) {
      // Auto-create a child task under the source session's task
      if (!sourceRecord.taskId) {
        res.status(400).json({ error: 'Source session has no task — cannot create child task' })
        return
      }
      let parentTask: Task
      try {
        parentTask = await getTask(sourceRecord.taskId)
      } catch {
        res.status(404).json({ error: `Parent task "${sourceRecord.taskId}" not found` })
        return
      }
      const newTitle = child_title ?? `Fork of ${parentTask.title}`
      const { task: newChild } = await addTask({
        title: newTitle,
        category: parentTask.category,
        project: parentTask.project,
        parent_task_id: parentTask.id,
        source: parentTask.source,
      })
      bus.emit(EventNames.TASK_CREATED, { task: newChild }, ['web-ui', 'main-agent'], { source: 'fork' })
      task = newChild
      childTaskCreated = true
    } else {
      // Look up target task by provided task_id
      task = await getTask(task_id!)
      if (!task) {
        res.status(404).json({ error: `Task "${task_id}" not found` })
        return
      }
    }

    // Check 1-session-per-task
    const existingSessions = await getSessionsForTask(task.id)
    const activeSessions = existingSessions.filter(s => !s.archived)
    if (activeSessions.length > 0) {
      res.status(409).json({
        error: 'Target task already has a session',
        existing_session_id: activeSessions[0].claudeSessionId,
      })
      return
    }

    const forkMessage = message || `Continue working on: ${task.title}`

    // Emit SESSION_START with forkedFromSessionId — handleStart() uses Claude Code's
    // native --resume + --fork-session to transfer conversation context efficiently.
    // No need to read source history or wait for session start; return immediately.
    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: forkMessage,
      cwd: sourceRecord.cwd,
      project: task.project ?? '',
      mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
      model,
      title: title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`,
      host: sourceRecord.host,
      forkedFromSessionId: sourceSessionId,
    }, ['session-runner'], { source: 'web-api' })

    res.json({
      status: 'pending',
      sourceSessionId,
      taskId: task.id,
      ...(childTaskCreated ? { childTaskCreated: true } : {}),
      ...(sourceRecord.host ? { host: sourceRecord.host } : {}),
    })
  } catch (err) {
    next(err)
  }
})

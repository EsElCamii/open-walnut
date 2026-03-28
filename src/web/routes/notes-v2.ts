/**
 * Notes v2 routes — multi-file notes with CRUD, search, backlinks.
 * Storage: ~/.open-walnut/notes/ (flat markdown files in folder hierarchy)
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { NOTES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

const MAX_NOTE_SIZE = 2_000_000 // 2 MB

export const notesV2Router = Router()

/** Ensure notes dir exists */
async function ensureNotesDir(): Promise<void> {
  await fsp.mkdir(NOTES_DIR, { recursive: true })
}

/** Resolve and validate a note path — prevent directory traversal */
function resolveSafePath(relativePath: string): string | null {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  const resolved = path.resolve(NOTES_DIR, cleaned)
  // Must be strictly inside NOTES_DIR (not NOTES_DIR itself)
  if (!resolved.startsWith(NOTES_DIR + path.sep)) {
    return null
  }
  return resolved
}

/** Extract wildcard path param — Express 5 returns arrays for *name params */
function getWildcardPath(req: Request): string | null {
  const raw = (req.params as any).path
  if (typeof raw === 'string') return raw || null
  if (Array.isArray(raw)) return raw.join('/') || null
  return null
}

/** Wiki-link regex: matches [[target]] or [[target|label]] */
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

// ─── Tree ────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string
  path: string       // relative to NOTES_DIR, forward slashes
  type: 'file' | 'folder'
  children?: TreeNode[]
}

async function scanDir(dirPath: string, relBase: string): Promise<TreeNode[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true })
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const nodes: TreeNode[] = []

  // Sort: folders first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // skip hidden files
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      const children = await scanDir(path.join(dirPath, entry.name), relPath)
      nodes.push({ name: entry.name, path: relPath, type: 'folder', children })
    } else if (entry.name.endsWith('.md')) {
      nodes.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }

  return nodes
}

// GET /api/notes-v2 — file tree
notesV2Router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureNotesDir()
    const tree = await scanDir(NOTES_DIR, '')
    res.json({ tree })
  } catch (err) {
    next(err)
  }
})

// ─── Content CRUD ────────────────────────────────────────────────────────

// GET /api/notes-v2/content/*path — read note
notesV2Router.get('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    // Ensure .md extension
    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    let content = ''
    let updatedAt: string | null = null
    try {
      content = await fsp.readFile(filePath, 'utf-8')
      const stat = await fsp.stat(filePath)
      updatedAt = stat.mtime.toISOString()
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Note not found' })
        return
      }
      throw err
    }

    res.json({ content, updatedAt })
  } catch (err) {
    next(err)
  }
})

// PUT /api/notes-v2/content/*path — create/update note
notesV2Router.put('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    if (content.length > MAX_NOTE_SIZE) {
      res.status(413).json({ error: `Content too large (max ${MAX_NOTE_SIZE} bytes)` })
      return
    }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, content, 'utf-8')

    const stat = await fsp.stat(filePath)
    log.memory.info('Note updated', { path: notePath, size: content.length })
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/notes-v2/content/*path — delete note
notesV2Router.delete('/content/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const fullPath = resolveSafePath(notePath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    const filePath = fullPath.endsWith('.md') ? fullPath : fullPath + '.md'

    try {
      await fsp.unlink(filePath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Note not found' })
        return
      }
      throw err
    }

    // Try to remove empty parent directories
    try {
      let dir = path.dirname(filePath)
      while (dir !== NOTES_DIR && dir.startsWith(NOTES_DIR)) {
        const entries = await fsp.readdir(dir)
        if (entries.length > 0) break
        await fsp.rmdir(dir)
        dir = path.dirname(dir)
      }
    } catch { /* best-effort cleanup */ }

    log.memory.info('Note deleted', { path: notePath })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── Move / Rename ───────────────────────────────────────────────────────

// POST /api/notes-v2/move — rename/move + update wiki links
notesV2Router.post('/move', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = req.body
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to (strings) are required' })
      return
    }

    const fromFull = resolveSafePath(from)
    const toFull = resolveSafePath(to)
    if (!fromFull || !toFull) { res.status(400).json({ error: 'invalid path' }); return }

    const fromFile = fromFull.endsWith('.md') ? fromFull : fromFull + '.md'
    const toFile = toFull.endsWith('.md') ? toFull : toFull + '.md'

    // Check source exists
    try {
      await fsp.stat(fromFile)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Source note not found' })
        return
      }
      throw err
    }

    // Check destination does not already exist — prevent silent overwrite
    try {
      await fsp.stat(toFile)
      // stat succeeded → file exists → conflict
      res.status(409).json({ error: 'Destination note already exists' })
      return
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      // ENOENT is expected — destination is free, proceed
    }

    // Move file
    await fsp.mkdir(path.dirname(toFile), { recursive: true })
    await fsp.rename(fromFile, toFile)

    // Update wiki links in all files that reference the old name
    const oldName = path.basename(from, '.md')
    const newName = path.basename(to, '.md')
    if (oldName !== newName) {
      await updateWikiLinksInAll(oldName, newName)
    }

    log.memory.info('Note moved', { from, to })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/** Update [[oldName]] → [[newName]] in all markdown files */
async function updateWikiLinksInAll(oldName: string, newName: string): Promise<void> {
  const allFiles = await getAllMdFiles(NOTES_DIR)
  const oldPattern = new RegExp(`\\[\\[${escapeRegExp(oldName)}(\\|[^\\]]*)?\\]\\]`, 'g')

  for (const filePath of allFiles) {
    const content = await fsp.readFile(filePath, 'utf-8')
    const updated = content.replace(oldPattern, (_, label) => {
      return label ? `[[${newName}${label}]]` : `[[${newName}]]`
    })
    if (updated !== content) {
      await fsp.writeFile(filePath, updated, 'utf-8')
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Search ──────────────────────────────────────────────────────────────

// GET /api/notes-v2/search?q=... — full-text search
notesV2Router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string || '').trim()
    if (!q) { res.json({ results: [] }); return }

    await ensureNotesDir()
    const allFiles = await getAllMdFiles(NOTES_DIR)
    const qLower = q.toLowerCase()
    const results: Array<{ path: string; name: string; snippet: string }> = []

    const MAX_RESULTS = 50
    for (const filePath of allFiles) {
      if (results.length >= MAX_RESULTS) break
      const content = await fsp.readFile(filePath, 'utf-8')
      const idx = content.toLowerCase().indexOf(qLower)
      if (idx >= 0) {
        const relPath = path.relative(NOTES_DIR, filePath).replace(/\\/g, '/')
        const start = Math.max(0, idx - 40)
        const end = Math.min(content.length, idx + q.length + 60)
        const snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '')
        results.push({ path: relPath, name: path.basename(relPath, '.md'), snippet })
      }
    }

    res.json({ results })
  } catch (err) {
    next(err)
  }
})

// ─── Backlinks ───────────────────────────────────────────────────────────

// GET /api/notes-v2/backlinks/*path — find notes that link to this note
notesV2Router.get('/backlinks/*path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = getWildcardPath(req)
    if (!notePath) { res.status(400).json({ error: 'path required' }); return }

    const targetName = path.basename(notePath, '.md')
    await ensureNotesDir()
    const allFiles = await getAllMdFiles(NOTES_DIR)
    const backlinks: Array<{ path: string; name: string; snippet: string }> = []

    for (const filePath of allFiles) {
      const relPath = path.relative(NOTES_DIR, filePath).replace(/\\/g, '/')
      // Don't include self
      if (relPath === notePath || relPath === notePath + '.md') continue

      const content = await fsp.readFile(filePath, 'utf-8')
      let match: RegExpExecArray | null
      // Reset lastIndex before every exec loop. WIKI_LINK_RE is a global regex
      // (`/g` flag), so its lastIndex persists across calls. Without this reset
      // the search would start mid-string on the second and subsequent files,
      // silently missing backlinks at the beginning of each file.
      WIKI_LINK_RE.lastIndex = 0

      while ((match = WIKI_LINK_RE.exec(content)) !== null) {
        const linkTarget = match[1].trim()
        if (linkTarget === targetName || linkTarget === notePath || linkTarget === notePath.replace(/\.md$/, '')) {
          const start = Math.max(0, match.index - 30)
          const end = Math.min(content.length, match.index + match[0].length + 30)
          const snippet = content.slice(start, end)
          backlinks.push({
            path: relPath,
            name: path.basename(relPath, '.md'),
            snippet,
          })
          break // one entry per file
        }
      }
    }

    res.json({ backlinks })
  } catch (err) {
    next(err)
  }
})

// ─── Folder CRUD ─────────────────────────────────────────────────────────

// POST /api/notes-v2/folder — create folder
notesV2Router.post('/folder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path: folderPath } = req.body
    if (typeof folderPath !== 'string') {
      res.status(400).json({ error: 'path (string) is required' })
      return
    }

    const fullPath = resolveSafePath(folderPath)
    if (!fullPath) { res.status(400).json({ error: 'invalid path' }); return }

    await fsp.mkdir(fullPath, { recursive: true })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Recursively collect all .md files */
async function getAllMdFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await getAllMdFiles(full))
    } else if (entry.name.endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

// ─── All notes list (for wiki-link autocomplete) ─────────────────────────

// GET /api/notes-v2/list — flat list of all note names/paths
notesV2Router.get('/list', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureNotesDir()
    const allFiles = await getAllMdFiles(NOTES_DIR)
    const notes = allFiles.map(f => {
      const relPath = path.relative(NOTES_DIR, f).replace(/\\/g, '/')
      return { path: relPath, name: path.basename(relPath, '.md') }
    })
    res.json({ notes })
  } catch (err) {
    next(err)
  }
})

/**
 * List a single directory's entries (dirs + files) for the Session File Explorer.
 *
 * GET /api/files/list?path=/absolute/dir&host=optional-ssh-host&showHidden=0
 *
 * Returns one level only (lazy-loaded tree). Directories sort before files,
 * each alphabetically. Capped at MAX_ENTRIES.
 *
 * Local:  fs.readdir(dir, { withFileTypes: true })
 * Remote: getDaemonConnection + fs.ls (daemon returns { name, type })
 *
 * Security:
 * - Absolute path required, '..' rejected, shell metacharacters rejected
 * - Read-only; never executes commands
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { getConfig } from '../../core/config-manager.js'

export const filesRouter = Router()

const MAX_ENTRIES = 1000
const REMOTE_TIMEOUT_MS = 15_000

export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}

/** Sort directories before files, each alphabetically (case-insensitive). */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

const MAX_UPWARD_LEVELS = 8

/** Build the ordered list of base dirs to try: cwd, then each parent up to N levels. */
function candidateBases(cwd: string): string[] {
  const bases: string[] = []
  let cur = cwd.replace(/\/+$/, '')
  for (let i = 0; i <= MAX_UPWARD_LEVELS; i++) {
    bases.push(cur)
    const parent = path.posix.dirname(cur)
    if (parent === cur) break // reached filesystem root
    cur = parent
  }
  return bases
}

/**
 * Resolve a (possibly extensionless, package-relative) path against a session cwd.
 *
 * GET /api/resolve-path?rel=<relPath>&cwd=<absDir>&host=<optional>
 *
 * Claude often emits monorepo-relative paths that don't sit directly under cwd
 * (e.g. cwd is pkg1 but the path lives in a sibling pkg or at the repo root).
 * We try cwd first, then walk up parent dirs, returning the first base where
 * `base/rel` exists. Stops one level past a dir containing `.git` (repo root).
 * Falls back to cwd/rel (resolved:false) when nothing exists.
 */
filesRouter.get('/resolve-path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rel = req.query.rel
    const cwd = req.query.cwd
    const host = req.query.host as string | undefined

    if (!rel || typeof rel !== 'string' || !cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'Missing rel or cwd parameter' })
      return
    }
    if (rel.includes('..') || cwd.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    if (/[;&|`$(){}!<>]/.test(rel) || /[;&|`$(){}!<>]/.test(cwd)) {
      res.status(400).json({ error: 'invalid characters in path' })
      return
    }
    // Absolute rel needs no resolution — pass through.
    if (rel.startsWith('/')) {
      res.json({ path: rel, resolved: true })
      return
    }

    const cleanRel = rel.replace(/^\.\//, '').replace(/\/+$/, '')
    const bases = candidateBases(cwd)
    const fallback = path.posix.join(cwd.replace(/\/+$/, ''), cleanRel)

    if (host) {
      // ── Remote: stat each candidate via daemon fs.stat ──
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef?.hostname) {
        res.json({ path: fallback, resolved: false })
        return
      }
      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }
      let conn
      try {
        let timeoutId: ReturnType<typeof setTimeout>
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('timeout')), REMOTE_TIMEOUT_MS)
        })
        conn = await Promise.race([getDaemonConnection(host, sshTarget), timeoutPromise])
          .finally(() => clearTimeout(timeoutId!))
      } catch {
        res.json({ path: fallback, resolved: false })
        return
      }
      for (const base of bases) {
        const candidate = path.posix.join(base, cleanRel)
        const st = await conn.send('fs.stat', { path: candidate })
        if (st.ok && st.exists) {
          res.json({ path: candidate, resolved: true })
          return
        }
        // Stop one level past the repo root.
        const git = await conn.send('fs.stat', { path: path.posix.join(base, '.git') })
        if (git.ok && git.exists) break
      }
      res.json({ path: fallback, resolved: false })
      return
    }

    // ── Local: stat each candidate ──
    for (const base of bases) {
      const candidate = path.posix.join(base, cleanRel)
      try {
        await fsp.stat(candidate)
        res.json({ path: candidate, resolved: true })
        return
      } catch { /* not here, keep walking up */ }
      try {
        await fsp.stat(path.join(base, '.git'))
        break // reached repo root — stop after this level
      } catch { /* not a repo root, continue */ }
    }
    res.json({ path: fallback, resolved: false })
  } catch (err) {
    next(err)
  }
})

filesRouter.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const host = req.query.host as string | undefined
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true'

    if (!rawPath || typeof rawPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }
    if (rawPath.length > 4096) {
      res.status(400).json({ error: 'path too long' })
      return
    }
    // No directory traversal
    if (rawPath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    // No shell metacharacters (defense in depth — remote path is passed to daemon)
    if (/[;&|`$(){}!<>]/.test(rawPath)) {
      res.status(400).json({ error: 'invalid characters in path' })
      return
    }

    // Expand ~ for local; remote keeps ~ (daemon's fs.ls expands on the remote host)
    let dirPath = rawPath
    if (!host && (dirPath === '~' || dirPath.startsWith('~/'))) {
      dirPath = os.homedir() + dirPath.slice(1)
    }

    if (!host && !path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    if (host) {
      // ── Remote ──
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

      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }

      let timeoutId: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), REMOTE_TIMEOUT_MS)
      })
      const conn = await Promise.race([
        getDaemonConnection(host, sshTarget),
        timeoutPromise,
      ]).finally(() => clearTimeout(timeoutId!))

      let result = await conn.send('fs.ls', { path: dirPath })
      let remoteSelectedFile: string | undefined
      // If the path is a file (not a dir), the daemon's readdir fails with ENOTDIR.
      // Behave like VS Code: list the parent dir and flag the file for preview.
      // (Detect via the error string — the daemon's fs.stat doesn't report dir-ness,
      // so this avoids a daemon binary rebuild/redeploy.)
      if (!result.ok && /ENOTDIR/.test(String(result.error))) {
        const parent = path.posix.dirname(dirPath)
        remoteSelectedFile = path.posix.basename(dirPath)
        result = await conn.send('fs.ls', { path: parent })
      }
      if (!result.ok) {
        res.status(400).json({ error: `Cannot list directory: ${result.error ?? dirPath}` })
        return
      }
      const resolvedPath = (typeof result.resolvedPath === 'string' && result.resolvedPath)
        ? result.resolvedPath
        : dirPath
      const lsEntries = (result.entries as Array<{ name: string; type: string; size?: number }>) ?? []
      const entries: DirEntry[] = []
      for (const e of lsEntries) {
        if (!showHidden && e.name.startsWith('.')) continue
        // Daemon fs.ls reports 'dir' | 'file' | 'other' (sockets/FIFOs/symlinks) and
        // never includes size — anything non-dir is shown as a (sizeless) file.
        entries.push({
          name: e.name,
          type: e.type === 'dir' ? 'dir' : 'file',
          ...(typeof e.size === 'number' ? { size: e.size } : {}),
        })
      }
      res.json({ path: resolvedPath, selectedFile: remoteSelectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
      return
    }

    // ── Local ──
    // If the path points at a file (not a dir), behave like VS Code: list its
    // parent directory and flag the file so the UI can select/preview it, instead
    // of failing with ENOTDIR on scandir.
    let listDir = dirPath
    let selectedFile: string | undefined
    try {
      const st = await fsp.stat(dirPath)
      if (!st.isDirectory()) {
        listDir = path.dirname(dirPath)
        selectedFile = path.basename(dirPath)
      }
    } catch {
      // stat failed (missing path / perms) — let readdir below produce the error
    }
    let dirents
    try {
      dirents = await fsp.readdir(listDir, { withFileTypes: true })
    } catch (err) {
      res.status(400).json({ error: `Cannot list directory: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    const visible = dirents.filter((d) => showHidden || !d.name.startsWith('.'))
    // stat() (follows symlinks) in parallel so a symlink-to-dir is classified as a
    // dir (readdir's withFileTypes uses lstat → symlinked dirs would look like files),
    // and to avoid N sequential round-trips on large/networked dirs. stat also yields
    // the file size. Falls back to the dirent type if stat fails (broken symlink/perm).
    const entries: DirEntry[] = await Promise.all(
      visible.map(async (dirent): Promise<DirEntry> => {
        try {
          const st = await fsp.stat(path.join(dirPath, dirent.name))
          if (st.isDirectory()) return { name: dirent.name, type: 'dir' }
          return { name: dirent.name, type: 'file', size: st.size }
        } catch {
          return { name: dirent.name, type: dirent.isDirectory() ? 'dir' : 'file' }
        }
      }),
    )
    res.json({ path: listDir, selectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
  } catch (err) {
    next(err)
  }
})

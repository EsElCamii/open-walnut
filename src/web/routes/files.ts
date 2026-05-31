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

      const result = await conn.send('fs.ls', { path: dirPath })
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
      res.json({ path: resolvedPath, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
      return
    }

    // ── Local ──
    let dirents
    try {
      dirents = await fsp.readdir(dirPath, { withFileTypes: true })
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
    res.json({ path: dirPath, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
  } catch (err) {
    next(err)
  }
})

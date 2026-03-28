/**
 * Repositories routes — CRUD for repository YAML profiles.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { REPOSITORIES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

const MAX_REPO_SIZE = 100_000 // 100 KB

export const repositoriesRouter = Router()

// GET /api/repositories — list all repos
repositoriesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await fsp.mkdir(REPOSITORIES_DIR, { recursive: true })
    const files = (await fsp.readdir(REPOSITORIES_DIR))
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort()

    const repos = await Promise.all(files.map(async (f) => {
      const slug = f.replace(/\.ya?ml$/, '')
      const fullPath = path.join(REPOSITORIES_DIR, f)
      const content = await fsp.readFile(fullPath, 'utf-8')
      const stat = await fsp.stat(fullPath)
      const header = parseYamlHeader(content)
      return {
        slug,
        name: header.name || slug,
        description: header.description || '',
        tech_stack: header.tech_stack || '',
        hosts: header.hosts,
        modified: stat.mtime.toISOString(),
        size: stat.size,
      }
    }))

    res.json({ repositories: repos })
  } catch (err) {
    next(err)
  }
})

// GET /api/repositories/:name — read single repo
repositoriesRouter.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params
    const filePath = path.join(REPOSITORIES_DIR, `${name}.yaml`)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const stat = await fsp.stat(filePath)
      res.json({ slug: name, content, modified: stat.mtime.toISOString() })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: `Repository "${name}" not found` })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/repositories/:name — create or update repo
repositoriesRouter.post('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    if (content.length > MAX_REPO_SIZE) {
      res.status(413).json({ error: `Content too large (max ${MAX_REPO_SIZE} bytes)` })
      return
    }
    // Validate slug
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      res.status(400).json({ error: 'Invalid repository name. Use alphanumeric, hyphens, dots, underscores.' })
      return
    }

    await fsp.mkdir(REPOSITORIES_DIR, { recursive: true })
    const filePath = path.join(REPOSITORIES_DIR, `${name}.yaml`)
    const existed = fs.existsSync(filePath)
    await fsp.writeFile(filePath, content, 'utf-8')
    log.memory.info(`Repository ${existed ? 'updated' : 'created'} via UI`, { name })
    res.json({ ok: true, status: existed ? 'updated' : 'created' })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/repositories/:name — delete repo
repositoriesRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params
    const filePath = path.join(REPOSITORIES_DIR, `${name}.yaml`)
    try {
      await fsp.unlink(filePath)
      log.memory.info('Repository deleted via UI', { name })
      res.json({ ok: true })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: `Repository "${name}" not found` })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

/**
 * Parse YAML header fields without a full YAML parser.
 */
function parseYamlHeader(content: string): { name?: string; description?: string; tech_stack?: string; hosts: Record<string, { path?: string; ssh_host?: string }> } {
  const lines = content.split('\n')
  let name: string | undefined
  let description: string | undefined
  let tech_stack: string | undefined
  const hosts: Record<string, { path?: string; ssh_host?: string }> = {}
  let inHosts = false
  let currentHost: string | null = null

  for (const line of lines) {
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '')
      inHosts = false
    } else if (line.startsWith('description:')) {
      const val = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '')
      if (val !== '|' && val !== '>') description = val
      else {
        // Read next indented line
        const idx = lines.indexOf(line)
        for (let i = idx + 1; i < lines.length; i++) {
          if (lines[i].startsWith(' ') && lines[i].trim()) {
            description = lines[i].trim()
            break
          }
          if (!lines[i].startsWith(' ') && lines[i].trim()) break
        }
      }
      inHosts = false
    } else if (line.startsWith('tech_stack:')) {
      const val = line.slice('tech_stack:'.length).trim()
      tech_stack = val.startsWith('[') ? val.replace(/[\[\]]/g, '').trim() : val
      inHosts = false
    } else if (line.startsWith('hosts:')) {
      inHosts = true
      currentHost = null
    } else if (inHosts) {
      const hostMatch = line.match(/^  (\S+):$/)
      if (hostMatch) {
        currentHost = hostMatch[1]
        hosts[currentHost] = {}
      } else if (currentHost) {
        const pathMatch = line.match(/^\s+path:\s*(.+)/)
        if (pathMatch) hosts[currentHost].path = pathMatch[1].trim().replace(/^["']|["']$/g, '')
        const sshMatch = line.match(/^\s+ssh_host:\s*(.+)/)
        if (sshMatch) hosts[currentHost].ssh_host = sshMatch[1].trim().replace(/^["']|["']$/g, '')
      } else if (!line.startsWith(' ')) {
        inHosts = false
      }
    }
  }

  return { name, description, tech_stack, hosts }
}

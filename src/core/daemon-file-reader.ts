/**
 * DaemonFileReader — reads remote session files via the walnut-daemon WebSocket protocol.
 *
 * Replaces RemoteFileReader (SSH-based) with daemon-based file access.
 * Uses fs.read, fs.ls, and fs.find commands instead of spawning SSH processes.
 */

import path from 'node:path'
import { getDaemonConnection } from '../providers/daemon-connection.js'
import { getConfig } from './config-manager.js'
import type { SshTarget } from '../providers/session-io.js'
import type { SessionFileReader } from './session-file-reader.js'

export class DaemonFileReader implements SessionFileReader {
  private host: string
  private sshTarget: SshTarget | null = null

  constructor(host: string) {
    this.host = host
  }

  private async resolve(): Promise<void> {
    if (this.sshTarget) return
    const config = await getConfig()
    const hostDef = config.hosts?.[this.host]
    if (!hostDef) throw new Error(`Unknown host: ${this.host}`)
    const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string
    if (!hostname) throw new Error(`Host ${this.host} missing hostname`)
    this.sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
  }

  async readFile(remotePath: string): Promise<string | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)

    // Handle glob patterns by using fs.find
    if (remotePath.includes('*')) {
      const dir = path.dirname(remotePath)
      const pattern = path.basename(remotePath).replace(/\*/g, '')
      const findResult = await conn.send('fs.find', { path: dir, name: pattern, maxDepth: 2 })
      if (!findResult.ok || !(findResult.files as string[])?.length) return null
      remotePath = (findResult.files as string[])[0]
    }

    const result = await conn.send('fs.read', { path: remotePath, encoding: 'utf-8' })
    return result.ok ? result.data as string : null
  }

  async listDir(remotePath: string): Promise<string[]> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.ls', { path: remotePath })
    return result.ok ? (result.entries as { name: string }[]).map(e => e.name) : []
  }

  /**
   * Search for a session JSONL file under ~/.claude/projects using fs.find.
   * Returns the file content if found, null otherwise.
   */
  async findSession(sessionId: string): Promise<string | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.find', {
      path: '~/.claude/projects',
      name: sessionId + '.jsonl',
      maxDepth: 3,
    })
    if (!result.ok || !(result.files as string[])?.length) return null
    const filePath = (result.files as string[])[0]
    const content = await conn.send('fs.read', { path: filePath, encoding: 'utf-8' })
    return content.ok ? content.data as string : null
  }

  /**
   * Batch-read all subagent JSONL files from a remote directory.
   * Returns a Map<filename, content>.
   */
  async batchReadSubagents(remoteDirPath: string): Promise<Map<string, string>> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = new Map<string, string>()

    const lsResult = await conn.send('fs.ls', { path: remoteDirPath })
    if (!lsResult.ok) return result

    const files = (lsResult.entries as { name: string; type: string }[])
      .filter(e => e.type === 'file' && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))

    for (const f of files) {
      const content = await conn.send('fs.read', {
        path: remoteDirPath + '/' + f.name,
        encoding: 'utf-8',
      })
      if (content.ok && content.data) {
        result.set(f.name, content.data as string)
      }
    }

    return result
  }
}

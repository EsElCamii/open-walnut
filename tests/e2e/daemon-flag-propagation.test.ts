/**
 * E2E test B4: use_daemon flag propagation
 *
 * Verifies the full pipeline from config.yaml use_daemon flag through to
 * transport selection. Tests that:
 *   - A host with use_daemon: true attempts the daemon path (which fails in test
 *     because remote-session-manager.js require() fails in vitest ESM context).
 *     The bus subscriber catches the error gracefully. No session is created.
 *   - A host without use_daemon uses the legacy SSH path and succeeds with mock SSH.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, config parsing,
 *   host resolution, transport factory dispatch.
 * What's mocked: constants.js (temp dir), SSH binary (mock-ssh.mjs via PATH override).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

// Path to mock scripts
const MOCK_SSH_SCRIPT = path.resolve(import.meta.dirname, '../providers/mock-ssh.mjs')
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
let mockSshBinDir: string
let originalPath: string | undefined

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

/**
 * Collect all WS events for a given duration. Useful for verifying what events
 * are (or are not) emitted.
 */
function collectWsEvents(ws: WebSocket, durationMs: number): Promise<WsEvent[]> {
  return new Promise((resolve) => {
    const events: WsEvent[] = []
    const handler = (raw: WebSocket.RawData) => {
      try {
        events.push(JSON.parse(raw.toString()) as WsEvent)
      } catch { /* skip non-JSON */ }
    }
    ws.on('message', handler)
    setTimeout(() => {
      ws.off('message', handler)
      resolve(events)
    }, durationMs)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // 1. Create mock SSH wrapper
  mockSshBinDir = path.join(os.tmpdir(), `mock-ssh-bin-daemon-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(mockSshBinDir, { recursive: true })
  const mockSshWrapper = path.join(mockSshBinDir, 'ssh')
  await fs.writeFile(mockSshWrapper, `#!/bin/sh\nexec node "${MOCK_SSH_SCRIPT}" "$@"\n`, { mode: 0o755 })

  // Prepend mock bin dir to PATH
  originalPath = process.env.PATH
  process.env.PATH = `${mockSshBinDir}:${process.env.PATH}`

  // 2. Wire mock CLI for non-SSH sessions
  const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
  sessionRunner.setCliCommand(MOCK_CLI)

  // 3. Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })

  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'daemon-flag-task-001',
          title: 'Daemon flag test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'DaemonTestProject',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'daemon-flag-task-002',
          title: 'Legacy SSH test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'DaemonTestProject',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
      ],
    }),
  )

  // 4. Write config.yaml with daemon-host (use_daemon: true) and legacy-host (no use_daemon)
  await fs.writeFile(
    path.join(WALNUT_HOME, 'config.yaml'),
    [
      'version: 1',
      'user:',
      '  name: TestUser',
      'defaults:',
      '  priority: none',
      '  category: Inbox',
      'hosts:',
      '  daemon-host:',
      '    hostname: daemon.example.com',
      '    user: daemonuser',
      '    use_daemon: true',
      '  legacy-host:',
      '    hostname: legacy.example.com',
      '    user: legacyuser',
    ].join('\n') + '\n',
  )

  // 5. Start the server
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 30000)

afterAll(async () => {
  if (originalPath !== undefined) {
    process.env.PATH = originalPath
  }

  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (mockSshBinDir) {
    await fs.rm(mockSshBinDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ═══════════════════════════════════════════════════════════════════
//  B4: use_daemon flag propagation E2E
// ═══════════════════════════════════════════════════════════════════

describe('use_daemon flag propagation', () => {
  it('daemon-host (use_daemon: true) attempts daemon path — fails gracefully, no session created', async () => {
    const ws = await connectWs()

    // Collect all WS events during the attempt. The daemon path fails because
    // require('./daemon-transport.js') throws in vitest ESM context.
    // The bus subscriber catches this error and logs it — no session:result is emitted.
    const eventsPromise = collectWsEvents(ws, 3000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'daemon-flag-task-001',
      message: 'test daemon path',
      project: 'DaemonTestProject',
      host: 'daemon-host',
      cwd: '/tmp/daemon-test',
    })

    // The RPC responds ok (it just emits to the bus)
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for events to settle
    const events = await eventsPromise

    // No session:result should have been emitted for this task
    const resultEvents = events.filter(
      (e) => e.type === 'event' && e.name === 'session:result' &&
        (e.data as { taskId?: string })?.taskId === 'daemon-flag-task-001',
    )
    expect(resultEvents).toHaveLength(0)

    // Server should still be healthy — REST API responds
    const healthRes = await fetch(apiUrl('/api/tasks/daemon-flag-task-001'))
    expect(healthRes.status).toBe(200)

    // No successful session should have been created for daemon-host.
    // The bus error isolation prevents the session from being created.
    const sessRes = await fetch(apiUrl('/api/sessions/task/daemon-flag-task-001'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{ host?: string; work_status?: string }>
    }

    // Either no sessions at all, or any that exist should not be in 'complete' state
    const daemonSessions = sessBody.sessions.filter((s) => s.host === 'daemon-host')
    for (const s of daemonSessions) {
      expect(s.work_status).not.toBe('complete')
    }

    ws.close()
    await delay(100)
  }, 15000)

  it('legacy-host (no use_daemon) uses legacy SSH path and succeeds', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'daemon-flag-task-002',
      message: 'test legacy ssh path',
      project: 'DaemonTestProject',
      host: 'legacy-host',
      cwd: '/tmp/legacy-test',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Without use_daemon, the legacy SSH path is used.
    // Mock SSH produces a valid JSONL stream → session completes successfully.
    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }

    expect(rd.taskId).toBe('daemon-flag-task-002')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    expect(rd.result).toContain('Remote session completed successfully')

    ws.close()
    await delay(100)
  }, 30000)

  it('legacy-host session record persists with host field', async () => {
    // The previous test started a session for daemon-flag-task-002. Verify persistence.
    await delay(500)

    const res = await fetch(apiUrl('/api/sessions/task/daemon-flag-task-002'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{ host?: string; claudeSessionId: string }>
    }
    expect(body.sessions.length).toBeGreaterThanOrEqual(1)

    const legacySession = body.sessions.find((s) => s.host === 'legacy-host')
    expect(legacySession).toBeDefined()
    expect(legacySession!.claudeSessionId).toBeTruthy()
    expect(legacySession!.host).toBe('legacy-host')
  })

  it('daemon-host has no successfully completed sessions', async () => {
    const res = await fetch(apiUrl('/api/sessions/task/daemon-flag-task-001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{
        host?: string
        work_status?: string
        process_status?: string
      }>
    }

    // Any sessions for daemon-host should NOT be in complete state
    const daemonSessions = body.sessions.filter((s) => s.host === 'daemon-host')
    for (const s of daemonSessions) {
      expect(s.work_status).not.toBe('complete')
    }
  })
})

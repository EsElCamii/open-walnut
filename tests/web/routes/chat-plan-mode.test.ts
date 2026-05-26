/**
 * Tests for plan mode signal injection in the chat RPC handler.
 *
 * Verifies that:
 * - planModeOff: true  => [EXECUTION MODE] prefix
 * - mode: 'plan', planModeFirst: true => [PLAN MODE] prefix
 * - No mode flags => no prefix injected
 *
 * What's real: Express server, WebSocket RPC, chat handler routing.
 * What's mocked: constants.js (temp dir), agent loop (captures userContent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

// Capture the userContent argument passed to runAgentLoop
let capturedUserContent: string | unknown[] = ''

vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (userContent: string | unknown[], history: unknown[]) => {
    capturedUserContent = userContent
    return {
      messages: [
        ...(history as Array<{ role: string; content: unknown }>),
        {
          role: 'user',
          content: typeof userContent === 'string'
            ? [{ type: 'text', text: userContent }]
            : userContent,
        },
        { role: 'assistant', content: [{ type: 'text', text: 'mock response' }] },
      ],
      response: 'mock response',
      aborted: false,
    }
  }),
}))

import type { Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendRpc(
  ws: WebSocket,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error('RPC timed out')), 15_000)

    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.type === 'res' && msg.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg as { ok: boolean; payload?: unknown; error?: string })
      }
    }

    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

// Expected constants from chat.ts
const EXECUTION_MODE_MESSAGE =
  '[EXECUTION MODE] Plan mode has been deactivated. You may now execute changes and take actions. Previous plan-mode restrictions no longer apply.'

const PLAN_MODE_REMINDER =
  '[Reminder: Plan mode is still active — discuss and explore only, do not execute or make changes.]'

describe('Chat RPC plan mode signal injection', () => {
  beforeEach(async () => {
    capturedUserContent = ''
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  afterEach(async () => {
    await stopServer()
    await new Promise((r) => setTimeout(r, 100))
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('B1: planModeOff: true => agent message starts with [EXECUTION MODE]', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'do the thing',
        planModeOff: true,
      })

      // capturedUserContent should be a string with EXECUTION_MODE_MESSAGE prefix
      expect(typeof capturedUserContent).toBe('string')
      const content = capturedUserContent as string
      expect(content).toContain(EXECUTION_MODE_MESSAGE)
      expect(content.startsWith(EXECUTION_MODE_MESSAGE)).toBe(true)
      // The original message should follow after the prefix
      expect(content).toContain('do the thing')
      // Should NOT contain plan mode instructions
      expect(content).not.toContain('[PLAN MODE]')
      expect(content).not.toContain(PLAN_MODE_REMINDER)
    } finally {
      ws.close()
    }
  })

  it('B2: mode=plan, planModeFirst=true => agent message starts with [PLAN MODE]', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'think about this',
        mode: 'plan',
        planModeFirst: true,
      })

      expect(typeof capturedUserContent).toBe('string')
      const content = capturedUserContent as string
      expect(content.startsWith('[PLAN MODE]')).toBe(true)
      // Should contain the original message
      expect(content).toContain('think about this')
      // Should NOT have the reminder suffix (planModeFirst uses full instruction, not reminder)
      expect(content).not.toContain(PLAN_MODE_REMINDER)
      // Should NOT have execution mode
      expect(content).not.toContain('[EXECUTION MODE]')
    } finally {
      ws.close()
    }
  })

  it('B2b: mode=plan without planModeFirst => reminder suffix appended', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'continue planning',
        mode: 'plan',
      })

      expect(typeof capturedUserContent).toBe('string')
      const content = capturedUserContent as string
      // Should NOT start with [PLAN MODE] (that's only for planModeFirst)
      expect(content.startsWith('[PLAN MODE]')).toBe(false)
      // Should contain the original message
      expect(content).toContain('continue planning')
      // Should end with the plan mode reminder suffix
      expect(content).toContain(PLAN_MODE_REMINDER)
      expect(content.endsWith(PLAN_MODE_REMINDER)).toBe(true)
      // Should NOT have execution mode
      expect(content).not.toContain('[EXECUTION MODE]')
    } finally {
      ws.close()
    }
  })

  it('B3: no mode flags => no prefix injected', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'just a normal message',
      })

      expect(typeof capturedUserContent).toBe('string')
      const content = capturedUserContent as string
      // Should be just the message, no prefixes or suffixes
      expect(content).toBe('just a normal message')
      expect(content).not.toContain('[PLAN MODE]')
      expect(content).not.toContain('[EXECUTION MODE]')
      expect(content).not.toContain(PLAN_MODE_REMINDER)
    } finally {
      ws.close()
    }
  })
})

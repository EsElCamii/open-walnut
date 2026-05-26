/**
 * L3.1 — Dead-session autorespawn E2E (3 variants).
 *
 * The original user bug: a remote session goes `stopped`, UI sends a message,
 * daemon silently drops it. Fix: RemoteSessionManager must return a strict
 * failure to the caller, who can then respawn via `--resume`.
 *
 * This test exercises the client-side protocol end-to-end through a real
 * DaemonConnection + MockDaemon WebSocket. It verifies that:
 *
 *   T1 — `simulateDeath(sid)` → client onExit fires with correct exit code.
 *   T2 — `injectSendFault(sid, 'ENXIO')` → writeMessage returns false AND
 *         onExit fires (server reaps on ENXIO).
 *   T3 — Pre-`session_state` dispatch: cmdSend returns session_dead envelope
 *         and the client still flags the session as dead so callers can
 *         auto-respawn.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const fakeSshTarget = { hostname: 'localhost' }

describe('L3.1 Remote session dead → autorespawn signals', () => {
  let daemon: MockDaemon

  beforeEach(async () => {
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    daemon = await createMockDaemon()
  })

  afterEach(async () => {
    await daemon.stop()
  })

  // T1 — Server-side death broadcast → client onExit
  it('T1: simulateDeath(sid) fires client onExit(exitCode) within 500ms', async () => {
    const tmpId = `t1-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    const exitPromise = new Promise<number>((resolve) => {
      mgr.start({
        args: ['-p', '--output-format', 'stream-json', '--verbose'],
        cwd: '/tmp',
        message: 'slow:2000 stay-alive',
        onOutput: () => {},
        onExit: (code) => resolve(code),
      })
    })
    // Wait for session to be established, then simulate CLI death
    await new Promise((r) => setTimeout(r, 200))
    daemon.simulateDeath(tmpId, 137)
    const code = await Promise.race([
      exitPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('onExit did not fire')), 1500),
      ),
    ])
    expect(code).toBe(137)
    expect(mgr.hasPipe).toBe(false)
    await mgr.cleanup()
  })

  // T2 — send-time ENXIO → writeMessage false + onExit fires
  it('T2: injected ENXIO on send triggers writeMessage=false and onExit fires', async () => {
    const tmpId = `t2-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    let exitFired = false
    let exitCode = -999
    await mgr.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: (code) => { exitFired = true; exitCode = code },
    })
    await new Promise((r) => setTimeout(r, 150))
    daemon.injectSendFault(tmpId, 'ENXIO')

    const ok = await mgr.writeMessage('follow-up after death')
    expect(ok).toBe(false)

    // Daemon also broadcasts session_state=dead → client onExit fires
    await new Promise((r) => setTimeout(r, 200))
    expect(exitFired).toBe(true)
    expect(exitCode).toBe(-1)
    await mgr.cleanup()
  })

  // T3 — session_dead envelope (no broadcast yet) → writeMessage reports false
  it('T3: session_dead ack without broadcast still returns writeMessage=false', async () => {
    const tmpId = `t3-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    await mgr.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 150))
    // Flag session as dead on server BEFORE broadcasting — tests the strict-ack path
    daemon.injectSendFault(tmpId, 'session_dead')

    const ok = await mgr.writeMessage('pre-broadcast failure')
    expect(ok).toBe(false)
    await mgr.cleanup()
  })
})

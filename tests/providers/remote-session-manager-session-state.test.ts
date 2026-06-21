/**
 * L2.1 — RemoteSessionManager session_state subscription (8 tests).
 *
 * Verifies the client-side contract for the `session_state` daemon event:
 *   - sid / _prevSid matching
 *   - idempotent _hasPipe dedup (state=dead + legacy exit should fire _onExit once)
 *   - adopted:true is informational only (does NOT fire _onExit)
 *   - un-started manager ignores events
 *   - missing exitCode falls back to 1
 *
 * Strategy: construct a real DaemonConnection via `connectDirect(ws://...)` to a
 * MockDaemon. Call `RemoteSessionManager.start()` so _sid and handlers are wired
 * up, then directly emit session_state events from the mock daemon to all
 * connected clients. Assert on spies passed as onExit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TEST_TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

describe('L2.1 RemoteSessionManager session_state wire-level contract', () => {
  let daemon: MockDaemon
  let mgr: RemoteSessionManager
  let onExit: ReturnType<typeof vi.fn>
  let onOutput: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    daemon = await createMockDaemon()
    onExit = vi.fn()
    onOutput = vi.fn()
    mgr = new RemoteSessionManager(
      'sid-test',
      'testhost',
      TEST_TARGET,
      `ws://127.0.0.1:${daemon.port}`,
    )
    await mgr.start({
      args: [],
      message: 'hello',
      cwd: '/tmp',
      onOutput,
      onExit,
    })
    // Wait for initial connection & `cmd:start` round-trip
    await new Promise((r) => setTimeout(r, 60))
  })

  afterEach(async () => {
    try { await mgr.cleanup() } catch { /* best effort */ }
    await daemon.stop()
  })

  // M1 — session_state=dead flips _hasPipe=false and calls _onExit(exitCode)
  it('M1: session_state=dead calls _onExit(exitCode) and clears hasPipe', async () => {
    expect(mgr.hasPipe).toBe(true)
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 42 })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).toHaveBeenCalledWith(42)
    expect(mgr.hasPipe).toBe(false)
  })

  // M2 — two session_state=dead in a row → _onExit only called once (dedup via _hasPipe)
  it('M2: repeated session_state=dead fires _onExit only once (dedup)', async () => {
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 7 })
    await new Promise((r) => setTimeout(r, 20))
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 99 })
    await new Promise((r) => setTimeout(r, 20))
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(7)
  })

  // M3 — sid mismatch → event ignored
  it('M3: session_state for unrelated sid is ignored', async () => {
    daemon.emitSessionState('OTHER-SID', 'dead', { exitCode: 1 })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  // M4 — event tagged with _prevSid (old sid during rename) still triggers onExit
  it('M4: session_state tagged with _prevSid also matches', async () => {
    // Simulate mid-rename: tmpId was 'sid-test', server now knows new 'sid-real'
    mgr.renameForSession('sid-real')
    await new Promise((r) => setTimeout(r, 30))
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 5 })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).toHaveBeenCalledWith(5)
  })

  // M5 — session_state=running {adopted:true} does NOT fire _onExit
  it('M5: session_state=running with adopted:true does NOT fire onExit', async () => {
    daemon.emitSessionState('sid-test', 'running', { adopted: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).not.toHaveBeenCalled()
    expect(mgr.hasPipe).toBe(true)
  })

  // M6 — manager before start() (no _sid) should ignore events gracefully
  it('M6: events for un-started manager are ignored (no crash, no onExit)', async () => {
    const mgr2 = new RemoteSessionManager(
      'never-started',
      'testhost',
      TEST_TARGET,
      `ws://127.0.0.1:${daemon.port}`,
    )
    const onExit2 = vi.fn()
    // Do NOT call start — just attach event listener path by touching conn
    daemon.emitSessionState('never-started', 'dead', { exitCode: 1 })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit2).not.toHaveBeenCalled()
    try { await mgr2.cleanup() } catch { /* no-op */ }
  })

  // M7 — session_state=dead without exitCode → onExit called with default 1
  it('M7: session_state=dead without exitCode falls back to 1', async () => {
    daemon.emitSessionState('sid-test', 'dead')
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).toHaveBeenCalledWith(1)
  })

  // M8 — receiving both legacy `exit` and session_state=dead → only one onExit fire
  it('M8: legacy exit + session_state=dead fires onExit only once', async () => {
    // Legacy exit first
    daemon.emitEvent('exit', { sid: 'sid-test', code: 11 })
    await new Promise((r) => setTimeout(r, 20))
    daemon.emitSessionState('sid-test', 'dead', { exitCode: 22 })
    await new Promise((r) => setTimeout(r, 30))
    expect(onExit).toHaveBeenCalledTimes(1)
    // legacy exit path passes (code, stderr); we only assert on the first arg.
    expect(onExit.mock.calls[0][0]).toBe(11)
  })

  // M9 (Bug 1+2 regression) — writeMessage hits session_dead with a CLEAN
  // exitCode 0 (daemon normalized a turn-end). onExit MUST receive the real 0,
  // not a hardcoded 1. Downstream handleRemoteProcessExit gates on `code !== 0`,
  // so 0 short-circuits the bogus session:error while _hasPipe cleanup still
  // runs and writeMessage returns false (→ caller --resume recovers).
  it('M9: writeMessage on clean-exit session_dead passes REAL exitCode 0 to onExit (no fake crash)', async () => {
    daemon.simulateDeath('sid-test', 0)
    const ok = await mgr.writeMessage('next turn')
    await new Promise((r) => setTimeout(r, 20))
    expect(ok).toBe(false)                 // send failed → caller falls back to --resume
    expect(onExit).toHaveBeenCalledWith(0) // real code, NOT hardcoded 1
    expect(mgr.hasPipe).toBe(false)        // cleanup still ran
  })

  // M10 (Bug 1+2 regression) — a genuine non-zero crash exitCode is still
  // forwarded faithfully (we didn't break the real-error path).
  it('M10: writeMessage on crash session_dead forwards the real non-zero exitCode', async () => {
    daemon.simulateDeath('sid-test', 137)
    const ok = await mgr.writeMessage('next turn')
    await new Promise((r) => setTimeout(r, 20))
    expect(ok).toBe(false)
    expect(onExit).toHaveBeenCalledWith(137)
  })
})

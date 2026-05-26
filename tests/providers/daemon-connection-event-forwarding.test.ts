/**
 * L2.2 — DaemonConnection event fan-out (5 tests).
 *
 * Validates the boundary between raw WebSocket messages and the
 * DaemonConnection event-handler API:
 *   - session_state events with all fields land intact on subscribers
 *   - Multiple handlers fan out
 *   - One handler throwing does not affect other handlers (isolation)
 *   - Unsubscribe actually stops delivery
 *   - Messages with `id` field go to pending-command resolve path, NOT to
 *     event handlers (wire-protocol separation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DaemonConnection, type DaemonEvent } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

describe('L2.2 DaemonConnection event forwarding', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection

  beforeEach(async () => {
    daemon = await createMockDaemon()
    conn = new DaemonConnection('test-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
  })

  afterEach(async () => {
    try { conn.disconnect() } catch { /* best effort */ }
    await daemon.stop()
  })

  // D1 — daemon emits session_state → subscriber receives all fields
  it('D1: session_state event preserves sid/state/exitCode/reason', async () => {
    const received: DaemonEvent[] = []
    conn.onEvent((e) => received.push(e))
    daemon.emitSessionState('abc', 'dead', { exitCode: 17, reason: 'test-reason' })
    await new Promise((r) => setTimeout(r, 30))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      ev: 'session_state',
      sid: 'abc',
      state: 'dead',
      exitCode: 17,
      reason: 'test-reason',
    })
  })

  // D2 — multiple subscribers receive the same event
  it('D2: multiple handlers all receive the event (fan-out)', async () => {
    const h1 = vi.fn(); const h2 = vi.fn(); const h3 = vi.fn()
    conn.onEvent(h1); conn.onEvent(h2); conn.onEvent(h3)
    daemon.emitEvent('jsonl', { sid: 'x', line: '{"type":"user"}' })
    await new Promise((r) => setTimeout(r, 30))
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h3).toHaveBeenCalledTimes(1)
  })

  // D3 — a throwing handler does not block the others
  it('D3: handler throwing does not break fan-out to siblings', async () => {
    const bad = vi.fn(() => { throw new Error('handler boom') })
    const good = vi.fn()
    conn.onEvent(bad)
    conn.onEvent(good)
    daemon.emitEvent('jsonl', { sid: 'x', line: 'hello' })
    await new Promise((r) => setTimeout(r, 30))
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })

  // D4 — unsubscribe stops delivery
  it('D4: unsubscribe stops further delivery', async () => {
    const handler = vi.fn()
    const unsub = conn.onEvent(handler)
    daemon.emitEvent('jsonl', { sid: 'x', line: 'first' })
    await new Promise((r) => setTimeout(r, 20))
    expect(handler).toHaveBeenCalledTimes(1)
    unsub()
    daemon.emitEvent('jsonl', { sid: 'x', line: 'second' })
    await new Promise((r) => setTimeout(r, 20))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // D5 — messages with numeric `id` route to pending-command resolve, NOT events
  it('D5: command reply (has numeric id) does not reach event handlers', async () => {
    const handler = vi.fn()
    conn.onEvent(handler)
    // `ping` is handled by MockDaemon and replies with {id, ok:true, pong:true}.
    // That reply has a numeric id and should be resolved via pending-command path.
    const reply = await conn.send('ping', {})
    expect(reply).toMatchObject({ ok: true, pong: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(handler).not.toHaveBeenCalled()
  })
})

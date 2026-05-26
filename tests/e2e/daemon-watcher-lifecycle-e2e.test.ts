/**
 * L3 E2E — walnut-side behaviour of the session-bound watcher refactor.
 *
 * The daemon-side invariants (watcher outlives ws, catch-up on attach, etc.)
 * are covered by `tests/providers/daemon-watcher-lifecycle.test.ts` via source
 * greps, and by the live daemon runs. This file covers the walnut-side
 * invariant that the whole architecture leans on:
 *
 *   If the daemon replays the same jsonl line twice (which it now can — the
 *   session-bound watcher catch-up on reconnect may re-send bytes that were
 *   already pushed before a ws flap), walnut must dedup on `uuid` and forward
 *   each line exactly once.
 *
 * Before the refactor, dedup wasn't necessary because ws.close tore down the
 * watcher entirely — the next attach started from wherever walnut's _fileSize
 * told it to. Now the watcher keeps running, so reconnect + catch-up is the
 * happy path, and dedup is the only thing preventing double-renders.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const fakeSshTarget: SshTarget = { hostname: 'localhost' }

let daemon: MockDaemon

beforeAll(async () => {
  fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
  daemon = await createMockDaemon()
})

afterAll(async () => {
  await daemon.stop()
})

describe('L3 watcher-lifecycle — walnut-side dedup + catch-up behavior', () => {
  it('duplicate jsonl lines with the same uuid are forwarded exactly once', async () => {
    const sid = `dedup-${Date.now()}`
    const transport = new RemoteSessionManager(
      sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`,
    )

    const linesForwarded: string[] = []
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'stay-alive',
      onOutput: (e) => linesForwarded.push(e.line),
      onExit: () => {},
    })

    // Let the mock-cli's initial events settle.
    await new Promise((r) => setTimeout(r, 400))
    const baseline = linesForwarded.length

    // Simulate the daemon replaying the same jsonl line twice (this is
    // the exact shape of an attach catch-up race: bytes that were already
    // pushed before the tunnel flapped get re-sent after reconnect).
    const replayed = JSON.stringify({
      type: 'assistant',
      uuid: 'replay-uuid-001',
      message: { id: 'msg_replay_001', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      session_id: sid,
    })
    daemon.emitEvent('jsonl', { sid, line: replayed })
    daemon.emitEvent('jsonl', { sid, line: replayed })  // duplicate — must be dropped
    daemon.emitEvent('jsonl', { sid, line: replayed })  // triplicate — must be dropped

    await new Promise((r) => setTimeout(r, 150))

    const newLines = linesForwarded.slice(baseline)
    const withUuid = newLines.filter((l) => l.includes('replay-uuid-001'))
    expect(withUuid.length).toBe(1)

    await transport.cleanup()
  }, 15000)

  it('lines without uuid always pass through (system/init events are not deduped)', async () => {
    const sid = `no-uuid-${Date.now()}`
    const transport = new RemoteSessionManager(
      sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`,
    )

    const linesForwarded: string[] = []
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'stay-alive',
      onOutput: (e) => linesForwarded.push(e.line),
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 400))
    const baseline = linesForwarded.length

    // System event, no uuid — dedup should NOT kick in, both copies pass through.
    const sysLine = JSON.stringify({ type: 'system', subtype: 'status', session_id: sid, marker: 'uniq-a' })
    daemon.emitEvent('jsonl', { sid, line: sysLine })
    daemon.emitEvent('jsonl', { sid, line: sysLine })

    await new Promise((r) => setTimeout(r, 150))

    const newLines = linesForwarded.slice(baseline)
    const matches = newLines.filter((l) => l.includes('uniq-a'))
    expect(matches.length).toBe(2)

    await transport.cleanup()
  }, 15000)

  it('malformed / non-JSON lines pass through without crashing the dedup layer', async () => {
    const sid = `malformed-${Date.now()}`
    const transport = new RemoteSessionManager(
      sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`,
    )

    const linesForwarded: string[] = []
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'stay-alive',
      onOutput: (e) => linesForwarded.push(e.line),
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 400))
    const baseline = linesForwarded.length

    daemon.emitEvent('jsonl', { sid, line: 'this is not json at all' })
    daemon.emitEvent('jsonl', { sid, line: '{incomplete json' })

    await new Promise((r) => setTimeout(r, 150))

    const newLines = linesForwarded.slice(baseline)
    expect(newLines.length).toBe(2)
    expect(newLines[0]).toBe('this is not json at all')
    expect(newLines[1]).toBe('{incomplete json')

    await transport.cleanup()
  }, 15000)

  it('dedup set persists across jsonl events — uuid seen in turn 1 is dropped in turn 2', async () => {
    const sid = `persist-${Date.now()}`
    const transport = new RemoteSessionManager(
      sid, 'test-host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`,
    )
    const linesForwarded: string[] = []
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'stay-alive',
      onOutput: (e) => linesForwarded.push(e.line),
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 400))
    const baseline = linesForwarded.length

    const first = JSON.stringify({ type: 'assistant', uuid: 'keep-across-turns', session_id: sid })
    daemon.emitEvent('jsonl', { sid, line: first })
    await new Promise((r) => setTimeout(r, 80))

    // Same uuid, later: should be dropped even though unrelated events happened in between.
    daemon.emitEvent('jsonl', { sid, line: JSON.stringify({ type: 'system', session_id: sid, s: 'intermission' }) })
    daemon.emitEvent('jsonl', { sid, line: first })

    await new Promise((r) => setTimeout(r, 150))

    const uuidLines = linesForwarded.slice(baseline).filter((l) => l.includes('keep-across-turns'))
    expect(uuidLines.length).toBe(1)

    await transport.cleanup()
  }, 15000)
})

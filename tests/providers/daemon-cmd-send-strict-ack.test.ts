/**
 * L1.5 daemon-cmd-send strict-ack.
 *
 * Validates P5.1: cmdSend returns a strict status envelope instead of
 * optimistic `ok:true`, with specific reason codes the client can branch on.
 *
 * Branches:
 *   - missing sid/message    → { error: '...' }
 *   - not_found               → { ok:false, reason:'not_found' }
 *   - session_dead            → { ok:false, reason:'session_dead', exitCode }
 *   - precheck ESRCH          → reap(send-precheck-dead) + session_dead
 *   - FIFO write ENXIO        → reap(send-enxio) + reason:'ENXIO'
 *   - FIFO write EAGAIN       → reason:'EAGAIN', retriable:true (no reap)
 *   - FIFO large payload      → loops past PIPE_BUF; full write or session_dead
 *   - successful write        → { ok:true }
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import {
  buildDeps,
  makeTestSession,
  createDaemonCore,
  killWithDead,
} from '../helpers/daemon-core-fixtures.js'

describe('L1.5 daemon cmdSend strict-ack', () => {
  let ctx: Awaited<ReturnType<typeof buildDeps>>

  beforeEach(async () => {
    ctx = await buildDeps()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  function makeFifo(): string {
    const p = path.join(ctx.tmpDir, `fifo-${Math.random().toString(36).slice(2)}.pipe`)
    try { execSync(`mkfifo ${p}`) } catch (err) {
      throw new Error('mkfifo failed (needed for strict-ack FIFO tests): ' + (err as Error).message)
    }
    return p
  }

  // S1 — missing fields
  it('missing sid returns {error:...}', () => {
    const core = createDaemonCore(ctx.deps)
    const res = core.handleSendCommand(undefined, 'hello')
    expect(res).toMatchObject({ error: expect.stringContaining('missing sid') })
  })

  it('missing message returns {error:...}', () => {
    const core = createDaemonCore(ctx.deps)
    const res = core.handleSendCommand('sid-x', undefined)
    expect(res).toMatchObject({ error: expect.stringContaining('missing') })
  })

  // S2 — unknown session
  it('session not in Map returns {ok:false, reason:not_found}', () => {
    const core = createDaemonCore(ctx.deps)
    const res = core.handleSendCommand('ghost', 'hello')
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  // S3 — session already dead
  it('session with state=dead returns {ok:false, reason:session_dead, exitCode}', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({ pid: 100, state: 'dead', exitCode: 7 }))

    const res = core.handleSendCommand('sid', 'hello')
    expect(res).toEqual({ ok: false, reason: 'session_dead', exitCode: 7 })
  })

  // S4 — precheck kill(pid,0) ESRCH reaps + returns session_dead
  it('precheck ESRCH reaps(send-precheck-dead) and returns session_dead', async () => {
    const freshCtx = await buildDeps({ killImpl: killWithDead(new Set([200])) })
    try {
      const core = createDaemonCore(freshCtx.deps)
      freshCtx.sessions.set('sid', makeTestSession({ pid: 200 }))

      const res = core.handleSendCommand('sid', 'hello')

      expect(res).toMatchObject({ ok: false, reason: 'session_dead' })
      expect(freshCtx.sessions.get('sid')!.state).toBe('dead')
      expect(freshCtx.sessions.get('sid')!.exitReason).toBe('send-precheck-dead')
    } finally {
      await freshCtx.cleanup()
    }
  })

  // S5 — FIFO write ENXIO reaps + returns ENXIO
  it('FIFO write with no reader (ENXIO) reaps(send-enxio) and returns reason=ENXIO', () => {
    const core = createDaemonCore(ctx.deps)
    // Use a path that doesn't exist — open(O_WRONLY|O_NONBLOCK) will throw
    // ENOENT, but we want ENXIO (readerless FIFO). Make a real FIFO with no
    // reader.
    const fifo = makeFifo()
    ctx.sessions.set('sid', makeTestSession({ pid: 300, pipePath: fifo }))

    const res = core.handleSendCommand('sid', 'hello')

    expect(res).toMatchObject({ ok: false, reason: 'ENXIO' })
    expect(ctx.sessions.get('sid')!.state).toBe('dead')
    expect(ctx.sessions.get('sid')!.exitReason).toBe('send-enxio')
  })

  // S6 — successful write when FIFO has a reader
  it('successful FIFO write returns {ok:true} and does NOT reap', () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()

    // Open reader in background so writer won't get ENXIO.
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)

    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 400, pipePath: fifo }))
      const res = core.handleSendCommand('sid', 'hello-world')
      expect(res).toEqual({ ok: true })
      expect(ctx.sessions.get('sid')!.state).toBe('running')
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // S7 — ENOENT (pipe file missing entirely) surfaces as {error:...}
  it('pipePath missing entirely → {error:...}, not ENXIO', () => {
    const core = createDaemonCore(ctx.deps)
    ctx.sessions.set('sid', makeTestSession({
      pid: 500,
      pipePath: path.join(ctx.tmpDir, 'does-not-exist.pipe'),
    }))
    const res = core.handleSendCommand('sid', 'hello')
    expect('error' in res).toBe(true)
    // Session NOT reaped (this is a bug signal, not a dead-process signal)
    expect(ctx.sessions.get('sid')!.state).toBe('running')
  })

  // S8a — payload larger than PIPE_BUF writes fully without truncation.
  //
  // Regression: PIPE_BUF on macOS is 512 bytes; the pre-fix code did a single
  // non-blocking writeSync and returned `partial_write` if the kernel didn't
  // accept all bytes, leaving the FIFO holding half a JSON line. The CLI's
  // stdin parser would then splice the truncated fragment with the next
  // write's bytes, JSON.parse would throw, and the CLI would exit with no
  // diagnostic to walnut. The fix loops in writeFifoFully(). This test sends
  // a payload well above PIPE_BUF (and small enough to fit in the kernel's
  // pipe buffer so the test's lazy reader doesn't deadlock) and verifies the
  // bytes round-trip intact.
  it('payload larger than PIPE_BUF writes fully (no truncation)', () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 650, pipePath: fifo }))
      const big = 'x'.repeat(4 * 1024) // 4KB ≫ PIPE_BUF (512B), well under pipe buffer
      const res = core.handleSendCommand('sid', big)
      expect(res).toEqual({ ok: true })

      // Drain the FIFO until we see a newline.
      const chunks: Buffer[] = []
      for (let i = 0; i < 100; i++) {
        const buf = Buffer.alloc(8192)
        let n = 0
        try { n = fs.readSync(readerFd, buf, 0, buf.length, null) } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) } catch {}
            continue
          }
          throw err
        }
        if (n === 0) break
        chunks.push(buf.slice(0, n))
        if (buf.slice(0, n).includes(0x0a)) break
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8').trim())
      expect(parsed.message.content).toBe(big)
    } finally {
      fs.closeSync(readerFd)
    }
  })

  // S8 — message payload is wrapped {type:'user', message:{role:'user',content}}
  it('written payload is JSON {type:user, message:{role:user, content:...}}', () => {
    const core = createDaemonCore(ctx.deps)
    const fifo = makeFifo()
    const readerFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    try {
      ctx.sessions.set('sid', makeTestSession({ pid: 600, pipePath: fifo }))
      core.handleSendCommand('sid', 'payload-shape-test')

      // Drain what was written
      const buf = Buffer.alloc(4096)
      const n = fs.readSync(readerFd, buf, 0, buf.length, null)
      const line = buf.slice(0, n).toString('utf-8').trim()
      const parsed = JSON.parse(line)
      expect(parsed).toEqual({
        type: 'user',
        message: { role: 'user', content: 'payload-shape-test' },
      })
    } finally {
      fs.closeSync(readerFd)
    }
  })
})

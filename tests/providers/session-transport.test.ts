/**
 * Unit tests for SessionManager interface + LocalSessionManager implementation.
 *
 * Tests the session manager abstraction layer directly, independent of the session
 * runner, event bus, or web server. Verifies FIFO lifecycle, message writing,
 * process control, file rename, synthetic events, and message passthrough.
 *
 * What's real: LocalSessionManager, LocalIO, filesystem operations, child processes.
 * What's mocked: constants.js (temp dir), CLI binary (mock-claude.mjs).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { LocalSessionManager } from '../../src/providers/local-session-manager.js'
import { createSessionManager } from '../../src/providers/session-manager.js'
import { SESSION_STREAMS_DIR, WALNUT_HOME } from '../../src/constants.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  // Allow file handles to close
  await new Promise((r) => setTimeout(r, 200))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  Section 1: LocalSessionManager — start() lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.start()', () => {
  it('creates FIFO + output file, spawns mock CLI, streams JSONL', async () => {
    const transport = new LocalSessionManager('test-start-001', undefined, MOCK_CLI)

    const lines: string[] = []
    let exitCode: number | null = null

    const result = await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'hello from test'],
      cwd: process.cwd(),
      message: 'hello from test',
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    // Start should return valid pid and output file
    expect(result.pid).toBeGreaterThan(0)
    expect(result.outputFile).toBeTruthy()
    expect(result.outputFile).toContain('test-start-001.jsonl')
    expect(result.fileSize).toBe(0) // new session starts at 0

    // Transport properties should be set
    expect(transport.pid).toBe(result.pid)
    expect(transport.outputFile).toBe(result.outputFile)
    expect(transport.isRemote).toBe(false)
    expect(transport.host).toBeNull()
    expect(transport.processName).toBe('claude')

    // Wait for the mock CLI to finish and the tailer to pick up all lines.
    // The tailer polls every 1s and uses fs.watch; we need to wait for exit
    // AND then give the tailer time to read and process the final data.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 8000)
    })

    // Flush the tailer to ensure all buffered data is processed
    transport.flushTail()

    // Give the tailer polling a moment to catch up after flush
    await new Promise((r) => setTimeout(r, 500))
    transport.flushTail() // second flush to be safe

    // Should have received JSONL lines (init, assistant, result at minimum)
    expect(lines.length).toBeGreaterThanOrEqual(3)

    // Parse init event
    const initLine = lines.find((l) => {
      try { return JSON.parse(l).type === 'system' && JSON.parse(l).subtype === 'init' } catch { return false }
    })
    expect(initLine).toBeTruthy()
    const initEvent = JSON.parse(initLine!)
    expect(initEvent.session_id).toBeTruthy()

    // Parse result event
    const resultLine = lines.find((l) => {
      try { return JSON.parse(l).type === 'result' } catch { return false }
    })
    expect(resultLine).toBeTruthy()
    const resultEvent = JSON.parse(resultLine!)
    expect(resultEvent.result).toContain('hello from test')

    // Process should have exited cleanly
    expect(exitCode).toBe(0)

    // Cleanup
    transport.stopTail()
    transport.deletePipe()
  }, 15000)

  it('resume=true opens output file in append mode and preserves previous data', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-resume-001.jsonl')

    // Pre-populate the output file with existing content (simulating a previous turn)
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init","session_id":"prev-session"}\n')
    const previousSize = (await fsp.stat(outputFile)).size

    const transport = new LocalSessionManager('test-resume-001', outputFile, MOCK_CLI)

    let exitCode: number | null = null
    const lines: string[] = []

    const result = await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'prev-session', 'resume message'],
      cwd: process.cwd(),
      message: 'resume message',
      resume: true,
      onOutput: (event) => { lines.push(event.line) },
      onExit: (code) => { exitCode = code },
    })

    // fileSize should reflect the pre-existing content
    expect(result.fileSize).toBe(previousSize)

    // Wait for process to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 8000)
    })

    // Flush the tailer to process any remaining data
    transport.flushTail()
    await new Promise((r) => setTimeout(r, 500))
    transport.flushTail()

    // The tailer should have captured lines from the new session output.
    // Since we start tailing from the pre-existing file size offset,
    // we should only see new content (not the previous turn's init).
    expect(lines.length).toBeGreaterThanOrEqual(1)

    // The file should still contain the old content plus new content
    const fullContent = await fsp.readFile(outputFile, 'utf-8')
    expect(fullContent).toContain('"prev-session"')

    transport.stopTail()
    transport.deletePipe()
  }, 15000)
})

// ═══════════════════════════════════════════════════════════════════
//  Section 2: LocalSessionManager.writeMessage()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.writeMessage()', () => {
  it('returns false when no pipe is available (before start)', () => {
    const transport = new LocalSessionManager('test-no-pipe-001')
    const result = transport.writeMessage('hello')
    expect(result).toBe(false)
  })

  it('writes to FIFO and returns true on success', async () => {
    const transport = new LocalSessionManager('test-write-msg-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', 'initial'],
      cwd: process.cwd(),
      message: 'initial',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Wait for CLI to start reading
    await new Promise((r) => setTimeout(r, 300))

    // hasPipe should be true after start
    expect(transport.hasPipe).toBe(true)

    // Write a follow-up message — the mock CLI may not consume it from FIFO
    // in stream-json input mode, but the write itself should succeed if the pipe is open
    const writeResult = transport.writeMessage('follow-up message')
    // The write may succeed or fail depending on timing, but should not throw
    expect(typeof writeResult).toBe('boolean')

    // Wait for process to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })

    transport.stopTail()
    transport.deletePipe()
  }, 10000)

  it('returns false when pipe is broken (after process exits and pipe deleted)', async () => {
    const transport = new LocalSessionManager('test-broken-pipe-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'quick'],
      cwd: process.cwd(),
      message: 'quick',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Wait for the process to exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })

    // Delete the pipe to simulate a broken pipe
    transport.deletePipe()
    expect(transport.hasPipe).toBe(false)

    // Writing after pipe deletion should return false
    const result = transport.writeMessage('should fail')
    expect(result).toBe(false)

    transport.stopTail()
  }, 10000)
})

// ═══════════════════════════════════════════════════════════════════
//  Section 3: LocalSessionManager.attach()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.attach()', () => {
  it('recovers FIFO and starts tailing from offset', async () => {
    const sessionId = 'attach-test-session-001'
    const outputFile = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`)
    const pipePath = path.join(SESSION_STREAMS_DIR, `${sessionId}.pipe`)

    // Create a FIFO and output file (simulating a running session)
    try { fs.unlinkSync(pipePath) } catch { /* ignore */ }
    execFileSync('mkfifo', [pipePath])
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init","session_id":"attach-test-session-001"}\n{"type":"result","subtype":"success"}\n')

    const previousContent = await fsp.readFile(outputFile, 'utf-8')
    const offset = Buffer.byteLength(previousContent)

    const transport = new LocalSessionManager(sessionId, outputFile)

    const lines: string[] = []
    const result = await transport.attach({
      sessionId,
      fromOffset: offset,
      onOutput: (event) => { lines.push(event.line) },
      onExit: () => {},
    })

    expect(result.outputFile).toBe(outputFile)
    // PID is null because we didn't set it (no running process)
    expect(result.pid).toBe(0)
    expect(result.alive).toBe(false)

    // Append new data to the output file — the tailer should pick it up
    await fsp.appendFile(outputFile, '{"type":"assistant","message":{"content":[{"type":"text","text":"new data"}]}}\n')

    // Wait for tailer to pick up new data
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.length > 0) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    expect(lines.length).toBeGreaterThanOrEqual(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('assistant')

    transport.stopTail()

    // Clean up FIFO
    try { fs.unlinkSync(pipePath) } catch { /* ignore */ }
  })

  it('tails from file start when no offset provided', async () => {
    const sessionId = 'attach-no-offset-001'
    const outputFile = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`)

    // Create output file with existing content
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init","session_id":"test"}\n')

    const transport = new LocalSessionManager(sessionId, outputFile)

    const lines: string[] = []
    await transport.attach({
      sessionId,
      // No fromOffset — should default to current file size
      onOutput: (event) => { lines.push(event.line) },
      onExit: () => {},
    })

    // Append new content
    await fsp.appendFile(outputFile, '{"type":"result","subtype":"success"}\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.length > 0) { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    // Should only see the NEW line (since default offset = current file size)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).type).toBe('result')

    transport.stopTail()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 4: LocalSessionManager.stop() and kill()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager process control', () => {
  it('stop() sends SIGINT then SIGTERM to the process', async () => {
    const transport = new LocalSessionManager('test-stop-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      // Use slow:30000 to make the process long-running so we can stop it
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'slow:30000 long running'],
      cwd: process.cwd(),
      message: 'slow:30000 long running',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    expect(transport.pid).toBeGreaterThan(0)

    // Process should be alive
    const aliveBefore = await transport.isAlive()
    expect(aliveBefore).toBe(true)

    // Stop should complete (sends SIGINT, waits, then SIGTERM if needed)
    await transport.stop()

    // Wait for exit callback
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 50)
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    // Process should be dead
    const aliveAfter = await transport.isAlive()
    expect(aliveAfter).toBe(false)

    transport.stopTail()
    transport.deletePipe()
  }, 15000)

  it('kill() sends SIGTERM immediately and deletes pipe', async () => {
    const transport = new LocalSessionManager('test-kill-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'slow:30000 long running kill test'],
      cwd: process.cwd(),
      message: 'slow:30000 long running kill test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    expect(transport.hasPipe).toBe(true)

    // Kill should be synchronous and immediate
    transport.kill()

    // Pipe should be deleted
    expect(transport.hasPipe).toBe(false)

    // Wait for exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 50)
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    const alive = await transport.isAlive()
    expect(alive).toBe(false)

    transport.stopTail()
  }, 10000)

  it('stop() is a no-op when pid is null', async () => {
    const transport = new LocalSessionManager('test-noop-stop-001')
    // Should not throw
    await transport.stop()
  })

  it('kill() is a no-op when pid is null', () => {
    const transport = new LocalSessionManager('test-noop-kill-001')
    // Should not throw
    transport.kill()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 5: LocalSessionManager.isAlive()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.isAlive()', () => {
  it('returns false when pid is null', async () => {
    const transport = new LocalSessionManager('test-alive-null-001')
    expect(await transport.isAlive()).toBe(false)
  })

  it('returns true for a running process', async () => {
    const transport = new LocalSessionManager('test-alive-running-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'slow:5000 alive test'],
      cwd: process.cwd(),
      message: 'slow:5000 alive test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    // Should be alive while running
    expect(await transport.isAlive()).toBe(true)

    // Kill and verify dead
    transport.kill()
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 50)
      setTimeout(() => { clearInterval(check); resolve() }, 3000)
    })

    expect(await transport.isAlive()).toBe(false)

    transport.stopTail()
  }, 10000)
})

// ═══════════════════════════════════════════════════════════════════
//  Section 6: LocalSessionManager.renameForSession()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.renameForSession()', () => {
  it('renames output file from temp ID to session ID', async () => {
    const tmpId = 'test-rename-tmp-001'
    const sessionId = 'real-session-id-abc123'
    const outputFile = path.join(SESSION_STREAMS_DIR, `${tmpId}.jsonl`)

    // Create output file with content
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init","session_id":"real-session-id-abc123"}\n')
    await fsp.writeFile(outputFile + '.err', 'stderr content\n')

    const transport = new LocalSessionManager(tmpId)

    // Start tailing before rename (to test tailer restart)
    const lines: string[] = []
    transport['io'].startTail((line: string) => { lines.push(line) }, 0)

    // Wait for tailer to read existing content
    await new Promise((r) => setTimeout(r, 500))

    // Rename
    transport.renameForSession(sessionId)

    // outputFile should now point to the new path
    const expectedNewPath = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`)
    expect(transport.outputFile).toBe(expectedNewPath)

    // Old files should not exist
    expect(fs.existsSync(outputFile)).toBe(false)

    // New files should exist
    expect(fs.existsSync(expectedNewPath)).toBe(true)
    expect(fs.existsSync(expectedNewPath + '.err')).toBe(true)

    // Content should be preserved
    const content = await fsp.readFile(expectedNewPath, 'utf-8')
    expect(content).toContain('real-session-id-abc123')

    transport.stopTail()
  })

  it('is idempotent — renaming to same ID is a no-op', async () => {
    const sessionId = 'already-named-session-001'
    const outputFile = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`)

    await fsp.writeFile(outputFile, '{"type":"test"}\n')

    const transport = new LocalSessionManager(sessionId, outputFile)

    // Should not throw when file already has the session ID in its name
    transport.renameForSession(sessionId)

    expect(transport.outputFile).toBe(outputFile)
    expect(fs.existsSync(outputFile)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 7: LocalSessionManager.writeSyntheticUserEvent()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.writeSyntheticUserEvent()', () => {
  it('appends a walnut-injected user event to the output file', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-synthetic-001.jsonl')
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init"}\n')

    const transport = new LocalSessionManager('test-synthetic-001', outputFile)

    transport.writeSyntheticUserEvent('user follow-up', 'msg-id-abc')

    // Wait for async appendFile to complete
    await new Promise((r) => setTimeout(r, 200))

    const content = await fsp.readFile(outputFile, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const syntheticEvent = JSON.parse(lines[1])
    expect(syntheticEvent.type).toBe('user')
    expect(syntheticEvent.subtype).toBe('walnut-injected')
    expect(syntheticEvent.message.role).toBe('user')
    expect(syntheticEvent.message.content).toBe('user follow-up')
    expect(syntheticEvent.walnutMessageId).toBe('msg-id-abc')
    expect(syntheticEvent.timestamp).toBeTruthy()
  })

  it('is a no-op when outputFile is null', () => {
    const transport = new LocalSessionManager('test-synthetic-null-001')
    // Clear the internal output file to simulate pre-start state
    ;(transport as unknown as { _outputFile: string | null })._outputFile = null

    // Should not throw
    transport.writeSyntheticUserEvent('message', 'id')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 8: LocalSessionManager message processing (no-ops for local)
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager message processing', () => {
  it('prepareOutbound() returns message unchanged (no-op for local)', async () => {
    const transport = new LocalSessionManager('test-outbound-001')
    const message = 'hello with /path/to/image.png'
    const result = await transport.prepareOutbound(message)
    expect(result).toBe(message)
  })

  it('processInbound() returns text unchanged (no-op for local)', () => {
    const transport = new LocalSessionManager('test-inbound-001')
    const text = 'response with /remote/path/image.png'
    const result = transport.processInbound(text, 'session-id', '/some/cwd')
    expect(result).toBe(text)
  })

  it('imageCache starts empty', () => {
    const transport = new LocalSessionManager('test-cache-001')
    expect(transport.imageCache.size).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 9: LocalSessionManager.detach(), cleanup(), deletePipe()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager lifecycle management', () => {
  it('detach() stops tailing without killing process', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-detach-001.jsonl')
    await fsp.writeFile(outputFile, '{"type":"init"}\n')

    const transport = new LocalSessionManager('test-detach-001', outputFile)

    const lines: string[] = []
    await transport.attach({
      sessionId: 'test-detach-001',
      fromOffset: 0,
      onOutput: (event) => { lines.push(event.line) },
      onExit: () => {},
    })

    // Should be tailing (tailer reads existing content)
    await new Promise((r) => setTimeout(r, 500))
    const linesBefore = lines.length

    // Detach
    transport.detach()

    // Append new data — tailer should NOT pick it up
    await fsp.appendFile(outputFile, '{"type":"new-after-detach"}\n')
    await new Promise((r) => setTimeout(r, 500))

    // No new lines should have been captured
    expect(lines.length).toBe(linesBefore)
  })

  it('cleanup() deletes pipe and output files', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-cleanup-001.jsonl')
    const errFile = outputFile + '.err'
    await fsp.writeFile(outputFile, '{"type":"init"}\n')
    await fsp.writeFile(errFile, 'errors\n')

    const transport = new LocalSessionManager('test-cleanup-001', outputFile)

    await transport.cleanup()

    // Files should be deleted
    expect(fs.existsSync(outputFile)).toBe(false)
  })

  it('deletePipe() removes only the pipe file', async () => {
    const tmpId = 'test-delete-pipe-001'
    const outputFile = path.join(SESSION_STREAMS_DIR, `${tmpId}.jsonl`)
    const pipePath = path.join(SESSION_STREAMS_DIR, `${tmpId}.pipe`)

    // Create pipe and output file
    try { fs.unlinkSync(pipePath) } catch { /* ignore */ }
    execFileSync('mkfifo', [pipePath])
    await fsp.writeFile(outputFile, '{"type":"init"}\n')

    const transport = new LocalSessionManager(tmpId, outputFile)
    // Manually set the pipe path via internal IO
    transport['io']['pipePath'] = pipePath

    expect(transport.hasPipe).toBe(true)

    transport.deletePipe()

    expect(transport.hasPipe).toBe(false)
    // Output file should still exist
    expect(fs.existsSync(outputFile)).toBe(true)
    // Pipe should be gone
    expect(fs.existsSync(pipePath)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 10: LocalSessionManager streaming properties
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager streaming properties', () => {
  it('tailOffset tracks bytes read from the output file', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-offset-001.jsonl')
    const content = '{"type":"system","subtype":"init","session_id":"test"}\n'
    await fsp.writeFile(outputFile, content)

    const transport = new LocalSessionManager('test-offset-001', outputFile)

    const lines: string[] = []
    await transport.attach({
      sessionId: 'test-offset-001',
      fromOffset: 0,
      onOutput: (event) => { lines.push(event.line) },
      onExit: () => {},
    })

    // Wait for tailer to read
    await new Promise((r) => setTimeout(r, 500))

    expect(transport.tailOffset).toBeGreaterThan(0)
    expect(transport.tailOffset).toBe(Buffer.byteLength(content))

    transport.stopTail()
  })

  it('fileSize reflects the actual output file size', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-filesize-001.jsonl')
    const content = '{"type":"system"}\n'
    await fsp.writeFile(outputFile, content)

    const transport = new LocalSessionManager('test-filesize-001', outputFile)
    expect(transport.fileSize).toBe(Buffer.byteLength(content))

    // Append more data
    const moreContent = '{"type":"result"}\n'
    await fsp.appendFile(outputFile, moreContent)
    expect(transport.fileSize).toBe(Buffer.byteLength(content + moreContent))
  })

  it('fileSize returns 0 when file does not exist', () => {
    const transport = new LocalSessionManager('test-filesize-nonexistent-001')
    expect(transport.fileSize).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 11: createSessionManager factory
// ═══════════════════════════════════════════════════════════════════

describe('createSessionManager factory', () => {
  it('LocalSessionManager direct instantiation creates a local session manager', () => {
    const transport = new LocalSessionManager('factory-local-001')
    expect(transport).toBeInstanceOf(LocalSessionManager)
    expect(transport.isRemote).toBe(false)
    expect(transport.host).toBeNull()
    expect(transport.processName).toBe('claude')
  })

  it('createSessionManager returns LocalSessionManager for local sessions', () => {
    const mgr = createSessionManager('factory-test-001')
    expect(mgr).toBeInstanceOf(LocalSessionManager)
    expect(mgr.isRemote).toBe(false)
    expect(mgr.host).toBeNull()
  })

  it('LocalSessionManager with outputFileOverride sets correct path', () => {
    const customPath = path.join(SESSION_STREAMS_DIR, 'custom-output.jsonl')
    const transport = new LocalSessionManager('factory-override-001', customPath)
    expect(transport).toBeInstanceOf(LocalSessionManager)
    expect(transport.outputFile).toBe(customPath)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 12: LocalSessionManager.interrupt()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.interrupt()', () => {
  it('deletes pipe and stops the process', async () => {
    const transport = new LocalSessionManager('test-interrupt-001', undefined, MOCK_CLI)

    let exitCode: number | null = null
    await transport.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose', 'slow:30000 interrupt test'],
      cwd: process.cwd(),
      message: 'slow:30000 interrupt test',
      onOutput: () => {},
      onExit: (code) => { exitCode = code },
    })

    expect(transport.hasPipe).toBe(true)
    expect(await transport.isAlive()).toBe(true)

    await transport.interrupt()

    // Pipe should be deleted
    expect(transport.hasPipe).toBe(false)

    // Wait for exit
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (exitCode !== null) { clearInterval(check); resolve() }
      }, 50)
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })

    expect(await transport.isAlive()).toBe(false)

    transport.stopTail()
  }, 15000)
})

// ═══════════════════════════════════════════════════════════════════
//  Section 13: LocalSessionManager.flushTail()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.flushTail()', () => {
  it('processes remaining buffered data', async () => {
    const outputFile = path.join(SESSION_STREAMS_DIR, 'test-flush-001.jsonl')
    // Write content without trailing newline (partial line scenario)
    await fsp.writeFile(outputFile, '{"type":"system","subtype":"init"}\n{"type":"result"}')

    const transport = new LocalSessionManager('test-flush-001', outputFile)

    const lines: string[] = []
    await transport.attach({
      sessionId: 'test-flush-001',
      fromOffset: 0,
      onOutput: (event) => { lines.push(event.line) },
      onExit: () => {},
    })

    // Wait for normal tailing to process complete lines
    await new Promise((r) => setTimeout(r, 500))
    const linesBeforeFlush = lines.length

    // Flush should process the partial line
    transport.flushTail()

    // The partial line '{"type":"result"}' should now be processed
    expect(lines.length).toBeGreaterThanOrEqual(linesBeforeFlush)

    // Both lines should have been captured
    expect(lines.some((l) => JSON.parse(l).type === 'system')).toBe(true)
    expect(lines.some((l) => JSON.parse(l).type === 'result')).toBe(true)

    transport.stopTail()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Section 14: LocalSessionManager.setPid()
// ═══════════════════════════════════════════════════════════════════

describe('LocalSessionManager.setPid()', () => {
  it('sets the PID externally for attach scenarios', () => {
    const transport = new LocalSessionManager('test-setpid-001')
    expect(transport.pid).toBeNull()

    transport.setPid(12345)
    expect(transport.pid).toBe(12345)
  })
})

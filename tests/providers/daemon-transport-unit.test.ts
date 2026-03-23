/**
 * Unit tests for RemoteSessionManager + DaemonConnection — no real daemon needed.
 *
 * Tests the session manager abstraction at the unit level:
 * - B1: createSessionManager factory dispatch (LocalSessionManager vs RemoteSessionManager)
 * - B2: RemoteSessionManager.writeMessage guard (before start)
 * - B3: DaemonConnection.disconnect cleanup
 * - B5: ClaudeCodeSession.transport getter
 *
 * What's real: RemoteSessionManager, DaemonConnection, LocalSessionManager, ClaudeCodeSession instances.
 * What's mocked: constants.js (temp dir) — no daemon, no SSH, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { LocalSessionManager } from '../../src/providers/local-session-manager.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { SessionManager } from '../../src/providers/session-manager.js'
import type { SshTarget } from '../../src/providers/session-io.js'

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 100))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// Helper: shared SshTarget for RemoteSessionManager tests
const testSshTarget: SshTarget = {
  hostname: 'myhost.example.com',
  user: 'testuser',
  use_daemon: true,
}

// ═══════════════════════════════════════════════════════════════════
//  B1: createSessionManager factory dispatch
// ═══════════════════════════════════════════════════════════════════

describe('B1: createSessionManager factory dispatch', () => {
  it('LocalSessionManager: isRemote === false, host === null, processName === claude', () => {
    const transport = new LocalSessionManager('local-b1-001')
    expect(transport.isRemote).toBe(false)
    expect(transport.host).toBeNull()
    expect(transport.processName).toBe('claude')
  })

  it('RemoteSessionManager: isRemote === true, host === myhost, processName === daemon', () => {
    const transport = new RemoteSessionManager('daemon-b1-001', 'myhost', testSshTarget)
    expect(transport.isRemote).toBe(true)
    expect(transport.host).toBe('myhost')
    expect(transport.processName).toBe('daemon')
  })

  it('LocalSessionManager has all SessionManager interface methods', () => {
    const transport: SessionManager = new LocalSessionManager('local-b1-002')

    // Startup / Attach
    expect(typeof transport.start).toBe('function')
    expect(typeof transport.attach).toBe('function')

    // Messaging
    expect(typeof transport.writeMessage).toBe('function')
    expect(typeof transport.writeSyntheticUserEvent).toBe('function')

    // Process Control
    expect(typeof transport.stop).toBe('function')
    expect(typeof transport.kill).toBe('function')
    expect(typeof transport.interrupt).toBe('function')
    expect(typeof transport.isAlive).toBe('function')

    // Session Management
    expect(typeof transport.renameForSession).toBe('function')
    expect(typeof transport.detach).toBe('function')
    expect(typeof transport.cleanup).toBe('function')
    expect(typeof transport.deletePipe).toBe('function')

    // Message Processing
    expect(typeof transport.prepareOutbound).toBe('function')
    expect(typeof transport.processInbound).toBe('function')

    // Streaming Control
    expect(typeof transport.flushTail).toBe('function')
    expect(typeof transport.stopTail).toBe('function')

    // Properties
    expect('pid' in transport).toBe(true)
    expect('outputFile' in transport).toBe(true)
    expect('hasPipe' in transport).toBe(true)
    expect('tailOffset' in transport).toBe(true)
    expect('fileSize' in transport).toBe(true)
    expect('processName' in transport).toBe(true)
    expect('host' in transport).toBe(true)
    expect('isRemote' in transport).toBe(true)
    expect('imageCache' in transport).toBe(true)
    expect('lastEventAt' in transport).toBe(true)
  })

  it('RemoteSessionManager has all SessionManager interface methods', () => {
    const transport: SessionManager = new RemoteSessionManager('daemon-b1-002', 'myhost', testSshTarget)

    // Startup / Attach
    expect(typeof transport.start).toBe('function')
    expect(typeof transport.attach).toBe('function')

    // Messaging
    expect(typeof transport.writeMessage).toBe('function')
    expect(typeof transport.writeSyntheticUserEvent).toBe('function')

    // Process Control
    expect(typeof transport.stop).toBe('function')
    expect(typeof transport.kill).toBe('function')
    expect(typeof transport.interrupt).toBe('function')
    expect(typeof transport.isAlive).toBe('function')

    // Session Management
    expect(typeof transport.renameForSession).toBe('function')
    expect(typeof transport.detach).toBe('function')
    expect(typeof transport.cleanup).toBe('function')
    expect(typeof transport.deletePipe).toBe('function')

    // Message Processing
    expect(typeof transport.prepareOutbound).toBe('function')
    expect(typeof transport.processInbound).toBe('function')

    // Streaming Control
    expect(typeof transport.flushTail).toBe('function')
    expect(typeof transport.stopTail).toBe('function')

    // Properties
    expect('pid' in transport).toBe(true)
    expect('outputFile' in transport).toBe(true)
    expect('hasPipe' in transport).toBe(true)
    expect('tailOffset' in transport).toBe(true)
    expect('fileSize' in transport).toBe(true)
    expect('processName' in transport).toBe(true)
    expect('host' in transport).toBe(true)
    expect('isRemote' in transport).toBe(true)
    expect('imageCache' in transport).toBe(true)
    expect('lastEventAt' in transport).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B2: RemoteSessionManager.writeMessage guard
// ═══════════════════════════════════════════════════════════════════

describe('B2: RemoteSessionManager.writeMessage guard (before start)', () => {
  it('writeMessage returns false without calling start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-001', 'testhost', testSshTarget)

    // No start() called — should return false, not throw
    const result = transport.writeMessage('hello')
    expect(result).toBe(false)
  })

  it('hasPipe is false before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-002', 'testhost', testSshTarget)
    expect(transport.hasPipe).toBe(false)
  })

  it('pid is null before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-003', 'testhost', testSshTarget)
    expect(transport.pid).toBeNull()
  })

  it('no exceptions thrown on writeMessage before start', () => {
    const transport = new RemoteSessionManager('daemon-b2-004', 'testhost', testSshTarget)

    // Should not throw
    expect(() => transport.writeMessage('hello')).not.toThrow()
    expect(() => transport.writeMessage('')).not.toThrow()
    expect(() => transport.writeMessage('a'.repeat(10000))).not.toThrow()
  })

  it('lastEventAt is 0 before start()', () => {
    const transport = new RemoteSessionManager('daemon-b2-005', 'testhost', testSshTarget)
    expect(transport.lastEventAt).toBe(0)
  })

  it('outputFile is null for remote sessions', () => {
    const transport = new RemoteSessionManager('daemon-b2-006', 'testhost', testSshTarget)
    expect(transport.outputFile).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B3: DaemonConnection.disconnect cleanup
// ═══════════════════════════════════════════════════════════════════

describe('B3: DaemonConnection.disconnect cleanup', () => {
  it('connected is false before connect()', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    expect(conn.connected).toBe(false)
  })

  it('disconnect is idempotent — calling twice does not throw', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)

    // First call
    expect(() => conn.disconnect()).not.toThrow()

    // Second call — should be safe
    expect(() => conn.disconnect()).not.toThrow()
  })

  it('send throws "not connected" after disconnect', async () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()

    // send() should throw because we never connected (and we're destroyed)
    await expect(conn.send('ping', {})).rejects.toThrow(/not connected/i)
  })

  it('internal state is clean after disconnect', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()

    // Access private fields via type cast for testing
    const internal = conn as unknown as {
      _destroyed: boolean
      pendingCommands: Map<number, unknown>
      reconnectTimer: ReturnType<typeof setTimeout> | null
      pingTimer: ReturnType<typeof setInterval> | null
    }

    expect(internal._destroyed).toBe(true)
    expect(internal.pendingCommands.size).toBe(0)
    expect(internal.reconnectTimer).toBeNull()
    expect(internal.pingTimer).toBeNull()
  })

  it('connected is false after disconnect', () => {
    const conn = new DaemonConnection('cleanup-host', testSshTarget)
    conn.disconnect()
    expect(conn.connected).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  B5: ClaudeCodeSession.transport getter
// ═══════════════════════════════════════════════════════════════════

describe('B5: ClaudeCodeSession.transport getter', () => {
  it('transport is null before send()', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    expect(session.transport).toBeNull()
  })

  it('hasPipe is false before send()', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    expect(session.hasPipe).toBe(false)
  })

  it('transport getter exists on ClaudeCodeSession', async () => {
    const { ClaudeCodeSession } = await import('../../src/providers/claude-code-session.js')
    const session = new ClaudeCodeSession('test-task', 'TestProject')

    // Verify the getter is defined on the prototype
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(session),
      'transport',
    )
    expect(descriptor).toBeDefined()
    expect(typeof descriptor!.get).toBe('function')
  })
})

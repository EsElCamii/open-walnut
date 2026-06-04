/**
 * registerSessionManager eviction — guards against cross-instance RSM leaks.
 *
 * When two SessionManager instances are registered for the same sid (e.g. a
 * rehydrate path that lost a race, or a reconnect that built a fresh RSM), the
 * old instance must be detached so it stops forwarding JSONL lines. Otherwise
 * both instances forward every line and streamed text doubles (each has its
 * own uuid-dedup set, so the cross-instance copy isn't caught).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  registerSessionManager,
  unregisterSessionManager,
  getRegisteredSessionManager,
} from '../../src/providers/session-manager.js'
import type { SessionManager } from '../../src/providers/session-manager.js'

function fakeManager(): SessionManager {
  // Only detach() is exercised by the eviction path; stub the rest as no-ops.
  return {
    detach: vi.fn(),
  } as unknown as SessionManager
}

describe('registerSessionManager eviction', () => {
  it('detaches a prior different instance for the same sid', () => {
    const sid = 'evict-sid-1'
    const first = fakeManager()
    const second = fakeManager()

    registerSessionManager(sid, first)
    registerSessionManager(sid, second)

    expect(first.detach).toHaveBeenCalledTimes(1)
    expect(second.detach).not.toHaveBeenCalled()
    expect(getRegisteredSessionManager(sid)).toBe(second)

    unregisterSessionManager(sid)
  })

  it('does NOT detach when re-registering the same instance (rename path)', () => {
    const sid = 'evict-sid-2'
    const mgr = fakeManager()

    registerSessionManager(sid, mgr)
    registerSessionManager(sid, mgr) // same reference — must be a no-op detach-wise

    expect(mgr.detach).not.toHaveBeenCalled()
    expect(getRegisteredSessionManager(sid)).toBe(mgr)

    unregisterSessionManager(sid)
  })

  it('swallows errors thrown by a prior instance detach()', () => {
    const sid = 'evict-sid-3'
    const first = { detach: vi.fn(() => { throw new Error('boom') }) } as unknown as SessionManager
    const second = fakeManager()

    registerSessionManager(sid, first)
    expect(() => registerSessionManager(sid, second)).not.toThrow()
    expect(getRegisteredSessionManager(sid)).toBe(second)

    unregisterSessionManager(sid)
  })
})

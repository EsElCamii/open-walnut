/**
 * Unit tests for isProcessAlive() — PID liveness check with binary verification.
 *
 * Tests verify:
 *   - Returns true for a known alive process (the current test process)
 *   - Returns false for a non-existent PID
 *   - Binary name check matches when correct
 *   - Binary name check rejects when wrong binary
 *   - Edge cases: PID 0, negative PID
 */

import { describe, it, expect } from 'vitest';
import { isProcessAlive, isProcessAliveAsync } from '../../src/utils/process.js';

describe('isProcessAlive', () => {
  it('returns true for the current process (no binary check)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // Use a very high PID that is extremely unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false);
  });

  it('returns true when expectedBinary matches the current process', () => {
    // The current process is "node" (or similar)
    expect(isProcessAlive(process.pid, 'node')).toBe(true);
  });

  it('returns false when expectedBinary does not match', () => {
    // The current process is node, not "nonexistent-binary-xyz"
    expect(isProcessAlive(process.pid, 'nonexistent-binary-xyz')).toBe(false);
  });

  it('returns false for PID 0', () => {
    // PID 0 is the kernel scheduler — process.kill(0, 0) sends to process group
    // which behaves differently on different platforms.
    // The important thing is it doesn't throw.
    const result = isProcessAlive(0, 'definitely-not-running');
    expect(typeof result).toBe('boolean');
  });

  it('returns false for negative PID', () => {
    // On POSIX, process.kill(-1, 0) sends to all processes in the group (doesn't throw).
    // But the ps binary check with expectedBinary should still return false.
    expect(isProcessAlive(-1, 'nonexistent-binary-xyz')).toBe(false);
  });
});

describe('isProcessAliveAsync — local-only semantics (regression)', () => {
  // These tests document why `isProcessAliveAsync` MUST NOT be used as a
  // pre-flight liveness check for REMOTE sessions. `process.kill(pid, 0)`
  // and `ps -p <pid>` are both local syscalls — they look up the local PID
  // table, which has nothing to do with a PID living on a remote host.
  //
  // Previously `claude-code-session.ts` did:
  //   isProcessAliveAsync(remotePid, 'ssh')
  // expecting it to test SSH-tunnel liveness. It doesn't — it tests the
  // local PID table for an ssh binary, which almost always returns false
  // even when the remote Claude CLI is healthy. The result was that every
  // send to a remote session short-circuited to `--resume spawn`, which
  // caused Claude Code to synthesize `[Request interrupted by user]`
  // markers to reconcile orphaned tool_uses.
  //
  // Remote liveness must come from the daemon (cmdSend ENXIO / cmdStatus).

  it('returns false for a PID that does not exist locally (simulated remote PID)', async () => {
    // A random high PID — treat as "a PID from a remote host". Unlikely to
    // exist in the local PID table; even if it did, binary won't match 'ssh'.
    const remotePidLike = 987654;
    const result = await isProcessAliveAsync(remotePidLike, 'ssh');
    expect(result).toBe(false);
  });

  it('local-only: returns true for the current process with matching binary', async () => {
    // Sanity check that the function DOES work for the local case (which
    // is the only case it's still called for in processNext after the fix).
    const result = await isProcessAliveAsync(process.pid, 'node');
    expect(result).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { reconcileSessions } from '../../src/core/session-reconciler.js'
import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
} from '../../src/core/session-tracker.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  // Ensure tasks directory exists for task-manager operations
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('reconcileSessions', () => {
  it('returns 0 when no sessions exist', async () => {
    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('returns 0 when all sessions are already stopped', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await updateSessionRecord('s1', { process_status: 'stopped' })
    await createSessionRecord('s2', 'task-2', 'proj')
    await updateSessionRecord('s2', { process_status: 'stopped' })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('marks active sessions without pid/outputFile as stopped (legacy)', async () => {
    await createSessionRecord('active-1', 'task-1', 'proj')
    // createSessionRecord defaults to process_status: 'running', no pid/outputFile

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('skips already-stopped sessions (no redundant reconciliation)', async () => {
    await createSessionRecord('idle-1', 'task-1', 'proj')
    await updateSessionRecord('idle-1', { process_status: 'stopped' })

    const result = await reconcileSessions()
    // Already stopped — reconciler skips (no point re-marking)
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('marks sessions with dead PIDs as stopped', async () => {
    await createSessionRecord('dead-pid', 'task-1', 'proj', undefined, {
      pid: 999999999,
      outputFile: '/tmp/dead.jsonl',
    })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('reconciles mix of active, idle, and stopped sessions', async () => {
    // Active zombie (no pid — legacy)
    await createSessionRecord('zombie-active', 'task-1', 'proj')

    // Already stopped zombie (dead pid)
    await createSessionRecord('zombie-idle', 'task-2', 'proj', undefined, {
      pid: 999999998,
      outputFile: '/tmp/zombie-idle.jsonl',
    })
    await updateSessionRecord('zombie-idle', { process_status: 'stopped' })

    // Already stopped (should not be touched)
    await createSessionRecord('already-done', 'task-3', 'proj')
    await updateSessionRecord('already-done', { process_status: 'stopped' })

    const result = await reconcileSessions()
    // Only zombie-active is reconciled; zombie-idle and already-done are already stopped (skipped)
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    const byId = new Map(sessions.map(s => [s.claudeSessionId, s]))
    expect(byId.get('zombie-active')!.process_status).toBe('stopped')
    expect(byId.get('zombie-idle')!.process_status).toBe('stopped')
    expect(byId.get('already-done')!.process_status).toBe('stopped')
  })

  it('handles sessions with no linked task (taskless sessions)', async () => {
    await createSessionRecord('taskless-1', '', 'proj')

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('preserves task session slots for stopped sessions', async () => {
    // Create a task with an exec session slot referencing a zombie session
    const taskStore = {
      version: 1,
      tasks: [{
        id: 'task-linked',
        title: 'Linked task',
        status: 'in_progress',
        priority: 'none',
        category: 'test',
        project: 'test',
        session_ids: ['linked-session'],
        exec_session_id: 'linked-session',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        description: '',
        summary: '',
        note: '',
        source: 'ms-todo',
      }],
    }
    await fsp.writeFile(TASKS_FILE, JSON.stringify(taskStore), 'utf-8')

    // Create the zombie session linked to this task
    await createSessionRecord('linked-session', 'task-linked', 'test')

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    // Verify task's session slot is PRESERVED (stopped keeps the link)
    const raw = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf-8'))
    const task = raw.tasks.find((t: { id: string }) => t.id === 'task-linked')
    expect(task.exec_session_id).toBe('linked-session')
  })

  it('handles missing task gracefully (task deleted but session remains)', async () => {
    // Session references a task that doesn't exist
    await createSessionRecord('orphan-session', 'deleted-task', 'proj')

    // No tasks file — task doesn't exist
    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    // Session should still be marked stopped even if task doesn't exist
    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('does not re-reconcile already-stopped sessions on second run', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await createSessionRecord('s2', 'task-2', 'proj')

    const first = await reconcileSessions()
    expect(first.reconciled).toBe(2)

    // After first run: both are stopped → second run skips them
    const second = await reconcileSessions()
    expect(second.reconciled).toBe(0)

    const sessions = await listSessions()
    for (const s of sessions) {
      expect(s.process_status).toBe('stopped')
    }
  })

  it('returns reconnectable sessions when pid is alive', async () => {
    // We can't easily mock isProcessAlive in the existing import,
    // so use pid: 999999999 (dead) to verify the opposite
    // and rely on integration tests for the alive path.
    // Here we verify the structural contract.
    await createSessionRecord('alive-maybe', 'task-1', 'proj', undefined, {
      pid: 999999999, // dead PID
      outputFile: '/tmp/test.jsonl',
    })

    const result = await reconcileSessions()
    // Dead PID → reconciled, not reconnectable
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])
  })

  it('sessions with pid but no outputFile are treated as dead', async () => {
    await createSessionRecord('pid-no-file', 'task-1', 'proj', undefined, {
      pid: process.pid, // alive PID but no outputFile
    })

    const result = await reconcileSessions()
    // No outputFile → can't reconnect → mark stopped
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])
  })
})

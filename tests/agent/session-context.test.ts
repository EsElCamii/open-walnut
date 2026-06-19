/**
 * Unit tests for buildSessionContext().
 *
 * buildSessionContext is intentionally a no-op as of 2026-06-18 — Walnut no
 * longer blanket-injects task metadata, project/repo memory, the vault guide,
 * or a server-safety warning into every session's system prompt. These tests
 * pin that contract: the builder returns an empty prompt and never throws,
 * regardless of inputs. If context injection is ever reintroduced, replace
 * these with assertions about the (relevant, gated) content it produces.
 */

import { describe, it, expect } from 'vitest'

import { buildSessionContext } from '../../src/agent/session-context.js'

describe('buildSessionContext (no-op)', () => {
  it('returns an empty system prompt for a normal taskId', async () => {
    const { systemPrompt } = await buildSessionContext('some-task-id')
    expect(systemPrompt).toBe('')
  })

  it('returns an empty system prompt with cwd and host supplied', async () => {
    const { systemPrompt } = await buildSessionContext('task-1', '/some/repo/path', 'remote-host')
    expect(systemPrompt).toBe('')
  })

  it('does not throw for a nonexistent task', async () => {
    const { systemPrompt } = await buildSessionContext('nonexistent-id')
    expect(systemPrompt).toBe('')
  })

  it('injects no vault / server-safety / task preamble', async () => {
    const { systemPrompt } = await buildSessionContext('task-2', '/x', 'h')
    expect(systemPrompt).not.toContain('<server_safety>')
    expect(systemPrompt).not.toContain('<notes_context>')
    expect(systemPrompt).not.toContain('<task>')
    expect(systemPrompt).not.toContain('Walnut')
  })
})

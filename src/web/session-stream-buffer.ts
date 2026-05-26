/**
 * In-memory per-session streaming buffer.
 *
 * Accumulates streaming blocks (text deltas, tool uses, tool results) for each
 * active session. When a frontend client subscribes to a session, it receives
 * a snapshot of the current buffer so it can catch up on missed output.
 *
 * Buffers are cleared shortly after session:result / session:error.
 */

import { log } from '../logging/index.js'

// ── Types (mirror the frontend StreamingBlock types) ──

export interface StreamingTextBlock {
  type: 'text'
  content: string
}

export interface StreamingToolCallBlock {
  type: 'tool_call'
  toolUseId: string
  name: string
  input?: Record<string, unknown>
  result?: string
  status: 'calling' | 'done'
  planContent?: string
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string
}

export interface StreamingSystemBlock {
  type: 'system'
  variant: 'compact' | 'error' | 'info'
  message: string
  detail?: string
}

export interface StreamingPermissionBlock {
  type: 'permission'
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  reason?: string
  status: 'pending' | 'allowed' | 'denied'
}

export interface StreamingThinkingBlock {
  type: 'thinking'
  content: string
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock | StreamingPermissionBlock | StreamingThinkingBlock

export interface StreamSnapshot {
  blocks: StreamingBlock[]
  isStreaming: boolean
}

// ── Buffer implementation ──

const PRUNE_INTERVAL_MS = 5 * 60_000  // check every 5 min
const STALE_THRESHOLD_MS = 10 * 60_000 // prune after 10 min idle

interface BufferEntry {
  blocks: StreamingBlock[]
  /** Full accumulated text for the current text run (used to reconstruct streamBuffer on snapshot) */
  textAccumulator: string
  /** Current thinking block's full accumulated text (mirrors textAccumulator's role). */
  thinkingAccumulator: string
  lastActivity: number
}

class SessionStreamBuffer {
  private buffers = new Map<string, BufferEntry>()
  private streaming = new Set<string>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS)
  }

  appendTextDelta(sessionId: string, delta: string): void {
    const entry = this.getOrCreate(sessionId)
    // ⚠️  DO NOT add `this.streaming.add(sessionId)` here. This is "Root Cause 5"
    // of the stuck-Streaming-badge bug: JSONL replay / late events re-populated the
    // streaming Set *after* markDone had cleared it, leaving the badge stuck forever.
    // Four prior attempts (resultEmitted guard, belt-and-suspenders cleanup, stale
    // subscribe backstop, daemon recovery) all fought the symptom — the architectural
    // fix is to keep data events out of the streaming flag entirely. The flag is
    // driven exclusively by lifecycle events via markStreaming/markDone.
    entry.textAccumulator += delta
    entry.lastActivity = Date.now()

    const last = entry.blocks[entry.blocks.length - 1]
    if (last && last.type === 'text') {
      last.content = entry.textAccumulator
    } else {
      entry.blocks.push({ type: 'text', content: entry.textAccumulator })
    }
  }

  appendToolUse(sessionId: string, toolUseId: string, name: string, input?: Record<string, unknown>, planContent?: string, parentToolUseId?: string): void {
    const entry = this.getOrCreate(sessionId)
    // ⚠️  DO NOT add `this.streaming.add(sessionId)` here — see appendTextDelta
    // for the Root Cause 5 explanation. Data events must never flip the lifecycle flag.
    // Tool call interrupts text flow — reset text accumulator
    entry.textAccumulator = ''
    entry.lastActivity = Date.now()
    entry.blocks.push({ type: 'tool_call', toolUseId, name, input, status: 'calling', ...(planContent ? { planContent } : {}), ...(parentToolUseId ? { parentToolUseId } : {}) })
  }

  appendToolResult(sessionId: string, toolUseId: string, result: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.lastActivity = Date.now()
    // Find matching tool_call and mark done
    for (let i = entry.blocks.length - 1; i >= 0; i--) {
      const b = entry.blocks[i]
      if (b.type === 'tool_call' && b.toolUseId === toolUseId && b.status === 'calling') {
        b.status = 'done'
        b.result = result
        break
      }
    }
  }

  /** Append a permission request block (idempotent — skips if requestId already exists). */
  appendPermission(sessionId: string, requestId: string, toolName: string, input?: Record<string, unknown>, reason?: string): void {
    const entry = this.getOrCreate(sessionId)
    // Idempotent: don't add duplicate permission blocks (re-emit timer may fire multiple times)
    const existing = entry.blocks.find(b => b.type === 'permission' && b.requestId === requestId) as StreamingPermissionBlock | undefined
    if (existing) return
    entry.textAccumulator = ''  // permission event breaks text flow
    entry.lastActivity = Date.now()
    entry.blocks.push({ type: 'permission', requestId, toolName, input, reason, status: 'pending' })
  }

  /** Update a permission block status after resolution. */
  resolvePermission(sessionId: string, requestId: string, status: 'allowed' | 'denied'): void {
    const entry = this.buffers.get(sessionId)
    if (!entry) return
    for (const b of entry.blocks) {
      if (b.type === 'permission' && (b as StreamingPermissionBlock).requestId === requestId) {
        (b as StreamingPermissionBlock).status = status
        entry.lastActivity = Date.now()
        break
      }
    }
  }

  appendSystem(sessionId: string, variant: 'compact' | 'error' | 'info', message: string, detail?: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.textAccumulator = ''  // system event breaks text flow
    entry.thinkingAccumulator = ''
    entry.lastActivity = Date.now()
    entry.blocks.push({ type: 'system', variant, message, ...(detail ? { detail } : {}) } as StreamingSystemBlock)
  }

  /** Accumulate thinking text deltas (model's reasoning, gated behind thinking mode). */
  appendThinkingDelta(sessionId: string, delta: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.thinkingAccumulator += delta
    entry.lastActivity = Date.now()
    const last = entry.blocks[entry.blocks.length - 1]
    if (last && last.type === 'thinking') {
      last.content = entry.thinkingAccumulator
    } else {
      entry.blocks.push({ type: 'thinking', content: entry.thinkingAccumulator })
    }
  }


  /**
   * SOLE "on"-path for the streaming flag. Must be called ONLY from lifecycle events
   * (currently just the `session:status-changed` handler in server.ts with
   * process_status='running'). If you are tempted to call this from a data handler
   * (appendTextDelta / appendToolUse / appendSystem), STOP — you are re-introducing
   * Root Cause 5 (stuck-badge bug where JSONL replay/late events re-populated the
   * streaming Set after markDone cleared it). The invariant that makes this fix
   * work is: data events append blocks only; lifecycle events flip the flag.
   *
   * Paired "off"-paths: markDone (result/error/idle/stopped/error status-changed)
   * and clear (session reaped / terminal status).
   */
  markStreaming(sessionId: string): void {
    const had = this.streaming.has(sessionId)
    this.streaming.add(sessionId)
    if (!had) log.ws.info('stream buffer markStreaming', { sessionId })
  }

  markDone(sessionId: string): void {
    const had = this.streaming.has(sessionId)
    this.streaming.delete(sessionId)
    const blocks = this.buffers.get(sessionId)?.blocks.length ?? 0
    log.ws.info('stream buffer markDone', { sessionId, wasStreaming: had, blocksRetained: blocks })
  }

  clear(sessionId: string): void {
    const entry = this.buffers.get(sessionId)
    log.ws.debug('stream buffer cleared', { sessionId, eventsDropped: entry?.blocks.length ?? 0 })
    this.buffers.delete(sessionId)
    this.streaming.delete(sessionId)
  }

  getSnapshot(sessionId: string): StreamSnapshot {
    const entry = this.buffers.get(sessionId)
    if (!entry) {
      const isStr = this.streaming.has(sessionId)
      log.ws.info('getSnapshot (no buffer)', { sessionId, isStreaming: isStr })
      return { blocks: [], isStreaming: isStr }
    }
    const isStr = this.streaming.has(sessionId)
    log.ws.info('getSnapshot', { sessionId, blocks: entry.blocks.length, isStreaming: isStr })
    // Return a deep-enough copy so mutations don't leak
    return {
      blocks: entry.blocks.map((b) => ({ ...b })),
      isStreaming: isStr,
    }
  }

  /** Prune buffers that haven't received events in a while. */
  private pruneStale(): void {
    const now = Date.now()
    for (const [id, entry] of this.buffers) {
      if (now - entry.lastActivity > STALE_THRESHOLD_MS && !this.streaming.has(id)) {
        log.ws.info('stale stream buffer pruned', { sessionId: id, ageMs: now - entry.lastActivity })
        this.buffers.delete(id)
      }
    }
  }

  private getOrCreate(sessionId: string): BufferEntry {
    let entry = this.buffers.get(sessionId)
    if (!entry) {
      entry = { blocks: [], textAccumulator: '', thinkingAccumulator: '', lastActivity: Date.now() }
      this.buffers.set(sessionId, entry)
      log.ws.debug('stream buffer created', { sessionId })
    }
    return entry
  }

  /** Stop the prune timer (for clean shutdown / tests). */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.buffers.clear()
    this.streaming.clear()
  }
}

export const sessionStreamBuffer = new SessionStreamBuffer()

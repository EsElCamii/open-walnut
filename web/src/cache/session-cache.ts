/**
 * Session cache — module-level singleton that tracks history + streaming state
 * for all visited sessions. Global WS listeners accumulate events for tracked
 * sessions in the background so switching back is instant (0ms from cache).
 *
 * Import this module to auto-register the listeners (runs once at import time).
 */

// WHY global listeners? React hooks unmount when user navigates away from a session.
// Without a global accumulator, WS events for background sessions are lost.
// The server already broadcasts ALL session events to all clients — we just
// stop discarding events for non-current sessions and accumulate them here.

import { wsClient } from '@/api/ws';
import { isToolResultError } from '@/api/chat';
import type {
  StreamingBlock,
  StreamingTextBlock,
  StreamingToolCallBlock,
  StreamingSystemBlock,
} from '@/hooks/useSessionStream';
import type { SessionHistoryMessage } from '@/types/session';
import { fetchSessionHistory } from '@/api/sessions';
import { log } from '@/utils/log';

const MAX_CACHED = 20;

// ── History cache (LRU via Map insertion order) ──────────────────────────────

export interface CachedHistory {
  messages: SessionHistoryMessage[];
  forkBoundaryIndex?: number;
  msgCount: number;
}

const historyCache = new Map<string, CachedHistory>();

function historyCacheSet(sid: string, data: CachedHistory): void {
  // Delete first so re-insert moves it to the end (most-recently-used)
  historyCache.delete(sid);
  historyCache.set(sid, data);
  if (historyCache.size > MAX_CACHED) {
    const oldest = historyCache.keys().next().value;
    if (oldest) historyCache.delete(oldest);
  }
}

export function getHistoryCache(sid: string): CachedHistory | undefined {
  return historyCache.get(sid);
}

export function setHistoryCache(sid: string, data: CachedHistory): void {
  historyCacheSet(sid, data);
}

// ── Streaming state cache ────────────────────────────────────────────────────

export interface StreamState {
  blocks: StreamingBlock[];
  textBuffer: string;
  isStreaming: boolean;
}

const streamStates = new Map<string, StreamState>();
const trackedSessions = new Set<string>();

/** Start tracking a session — global WS listeners will accumulate its events. */
export function trackSession(sid: string): void {
  trackedSessions.add(sid);
  // LRU eviction: if over limit, drop the oldest tracked session
  if (trackedSessions.size > MAX_CACHED) {
    const oldest = trackedSessions.values().next().value;
    if (oldest) {
      trackedSessions.delete(oldest);
      streamStates.delete(oldest);
      historyCache.delete(oldest);
    }
  }
}

export function getStreamState(sid: string): StreamState | undefined {
  return streamStates.get(sid);
}

export function clearStreamState(sid: string): void {
  streamStates.delete(sid);
}

/** Seed the streaming cache from a server snapshot (stream-subscribe RPC). */
export function initStreamState(
  sid: string,
  blocks: StreamingBlock[],
  isStreaming: boolean,
): void {
  // Reconstruct textBuffer from the last text block so future text-delta events
  // append correctly (textBuffer must equal lastTextBlock.content for continuity).
  const lastText = [...blocks]
    .reverse()
    .find((b): b is StreamingTextBlock => b.type === 'text');
  streamStates.set(sid, {
    blocks: blocks.map((b) => ({ ...b })),
    textBuffer: lastText ? lastText.content : '',
    isStreaming,
  });
}

// ── Global WS listeners (registered once at module load) ─────────────────────

/** Flush accumulated text into the last text block (or create one). */
function flushText(state: StreamState): void {
  if (!state.textBuffer) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.type === 'text') {
    state.blocks[state.blocks.length - 1] = {
      type: 'text',
      content: state.textBuffer,
    };
  } else {
    state.blocks.push({ type: 'text', content: state.textBuffer });
  }
}

function ensureState(sid: string): StreamState {
  let s = streamStates.get(sid);
  if (!s) {
    s = { blocks: [], textBuffer: '', isStreaming: false };
    streamStates.set(sid, s);
  }
  return s;
}

/** Tracks in-flight background fetches to avoid duplicate HTTP requests. */
const inflightBgFetches = new Set<string>();

function registerGlobalListeners(): void {
  // ── text-delta ──
  wsClient.onEvent('session:text-delta', (data: unknown) => {
    const { sessionId: sid, delta } = data as {
      sessionId: string;
      delta: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    state.textBuffer += delta;
    // Note: This intentionally duplicates flushText's logic. flushText is for
    // "flush-before-context-switch" (tool-use, result, etc.) where textBuffer is
    // reset afterward. Here we append delta first, then write the accumulated
    // buffer — calling flushText would lose the newly appended delta.
    // Update the last text block in-place (or push a new one)
    const last = state.blocks[state.blocks.length - 1];
    if (last && last.type === 'text') {
      state.blocks[state.blocks.length - 1] = {
        type: 'text',
        content: state.textBuffer,
      };
    } else {
      state.blocks.push({ type: 'text', content: state.textBuffer });
    }
  });

  // ── tool-use ──
  wsClient.onEvent('session:tool-use', (data: unknown) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId } =
      data as {
        sessionId: string;
        toolName: string;
        toolUseId: string;
        input?: Record<string, unknown>;
        planContent?: string;
        parentToolUseId?: string;
      };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    flushText(state);
    state.textBuffer = '';
    state.blocks.push({
      type: 'tool_call',
      toolUseId,
      name: toolName,
      input,
      status: 'calling',
      ...(planContent ? { planContent } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    } as StreamingToolCallBlock);
  });

  // ── tool-result ──
  wsClient.onEvent('session:tool-result', (data: unknown) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string;
      toolUseId: string;
      result: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      const b = state.blocks[i];
      if (
        b.type === 'tool_call' &&
        b.toolUseId === toolUseId &&
        b.status === 'calling'
      ) {
        state.blocks[i] = {
          ...b,
          status: isToolResultError(result) ? 'error' : 'done',
          result,
        };
        break;
      }
    }
  });

  // ── system-event ──
  wsClient.onEvent('session:system-event', (data: unknown) => {
    const { sessionId: sid, variant, message, detail } = data as {
      sessionId: string;
      variant: 'compact' | 'error' | 'info';
      message: string;
      detail?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    state.textBuffer = '';
    state.blocks.push({
      type: 'system',
      variant,
      message,
      detail,
    } as StreamingSystemBlock);
  });

  // ── thinking-delta ──
  wsClient.onEvent('session:thinking-delta', (data: unknown) => {
    const { sessionId: sid, delta } = data as { sessionId: string; delta: string };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.isStreaming = true;
    const last = state.blocks[state.blocks.length - 1];
    if (last && last.type === 'thinking') {
      state.blocks[state.blocks.length - 1] = {
        type: 'thinking',
        content: last.content + delta,
      };
    } else {
      state.blocks.push({ type: 'thinking', content: delta });
    }
  });

  // ── unknown-event (surface as info system block so no event is silently lost) ──
  wsClient.onEvent('session:unknown-event', (data: unknown) => {
    const { sessionId: sid, scope, eventType, snippet } = data as {
      sessionId: string; scope: string; eventType: string; snippet: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    state.blocks.push({
      type: 'system',
      variant: 'info',
      message: `Unknown Claude event: ${scope}:${eventType}`,
      detail: snippet,
    } as StreamingSystemBlock);
  });

  // ── result (streaming done, turn finished successfully) ──
  wsClient.onEvent('session:result', (data: unknown) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    // Mark streaming done but preserve blocks — they stay visible until
    // batch-completed fires (turn written to JSONL) and history replaces them.
    state.isStreaming = false;
    state.textBuffer = '';
  });

  // ── error (streaming done with error) ──
  wsClient.onEvent('session:error', (data: unknown) => {
    const { sessionId: sid, error } = data as {
      sessionId: string;
      error?: string;
    };
    if (!sid || !trackedSessions.has(sid)) return;
    const state = ensureState(sid);
    flushText(state);
    state.isStreaming = false;
    state.textBuffer = '';
    if (error) {
      const detail =
        error.length > 500 ? error.slice(0, 500) + '\u2026' : error;
      state.blocks.push({
        type: 'system',
        variant: 'error',
        message: 'Session error',
        detail,
      } as StreamingSystemBlock);
    }
  });

  // ── batch-completed (turn wrote to JSONL, streaming blocks are now history) ──
  wsClient.onEvent('session:batch-completed', (data: unknown) => {
    const sid = (data as { sessionId?: string })?.sessionId;
    if (!sid || !trackedSessions.has(sid)) return;
    log.info(
      'session-cache',
      `batch-completed for ${sid.substring(0, 8)}, clearing stream state`,
    );
    // Stream blocks are now persisted in JSONL — discard cached streaming state.
    // The bg fetch below will update historyCache with the completed turn.
    streamStates.delete(sid);

    // Background-fetch the updated history so cache is fresh when user switches back
    if (!inflightBgFetches.has(sid)) {
      inflightBgFetches.add(sid);
      fetchSessionHistory(sid)
        .then((r) => {
          historyCacheSet(sid, {
            messages: r.messages,
            forkBoundaryIndex: r.forkBoundaryIndex,
            msgCount: r.messages.length,
          });
          log.info('session-cache', `bg-updated history for ${sid.substring(0, 8)}`, {
            msgCount: r.messages.length,
          });
        })
        .catch((err) => log.warn('session-cache', 'bg history fetch failed', { sid, error: String(err) }))
        .finally(() => inflightBgFetches.delete(sid));
    }
  });

  // ── WS reconnect — refresh all tracked sessions ──
  wsClient.onEvent('_ws:reconnected', () => {
    log.info(
      'session-cache',
      `ws reconnected, refreshing ${trackedSessions.size} sessions`,
    );
    for (const sid of trackedSessions) {
      // Re-subscribe to get server snapshot for streaming sessions
      wsClient
        .sendRpc('session:stream-subscribe', { sessionId: sid })
        .then((snapshot: unknown) => {
          const snap = snapshot as {
            blocks: StreamingBlock[];
            isStreaming: boolean;
          } | null;
          if (snap) initStreamState(sid, snap.blocks, snap.isStreaming);
        })
        .catch(() => {});

      // Refresh history (may have missed batch-completed during disconnect)
      if (!inflightBgFetches.has(sid)) {
        inflightBgFetches.add(sid);
        fetchSessionHistory(sid)
          .then((r) =>
            historyCacheSet(sid, {
              messages: r.messages,
              forkBoundaryIndex: r.forkBoundaryIndex,
              msgCount: r.messages.length,
            }),
          )
          .catch((err) => log.warn('session-cache', 'bg history fetch failed', { sid, error: String(err) }))
          .finally(() => inflightBgFetches.delete(sid));
      }
    }
  });
}

// Auto-register on import
registerGlobalListeners();

// ── Subagent content cache (lazy-loaded on TaskGroup expand) ───────────────
// No invalidation on batch-completed: subagent content is expected to be complete
// by the time users expand a TaskGroup (active subagents render via StreamingTaskGroup).
// A page reload clears the cache if fresher data is needed.

const MAX_SUBAGENT_CACHED = 50;
const subagentCache = new Map<string, SessionHistoryMessage[]>();

function subagentKey(sid: string, agentId: string): string {
  return `${sid}:${agentId}`;
}

export function getSubagentCache(sid: string, agentId: string): SessionHistoryMessage[] | undefined {
  return subagentCache.get(subagentKey(sid, agentId));
}

export function setSubagentCache(sid: string, agentId: string, msgs: SessionHistoryMessage[]): void {
  const key = subagentKey(sid, agentId);
  subagentCache.delete(key); // re-insert for LRU ordering
  subagentCache.set(key, msgs);
  if (subagentCache.size > MAX_SUBAGENT_CACHED) {
    const oldest = subagentCache.keys().next().value;
    if (oldest) subagentCache.delete(oldest);
  }
}

/** Reset all internal state — for tests only. */
export function __resetForTesting(): void {
  historyCache.clear();
  streamStates.clear();
  trackedSessions.clear();
  inflightBgFetches.clear();
  subagentCache.clear();
}

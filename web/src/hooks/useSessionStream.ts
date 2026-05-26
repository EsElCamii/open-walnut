import { useState, useCallback, useRef, useEffect } from 'react';
import { useEvent } from './useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import { isToolResultError } from '@/api/chat';
import { log } from '@/utils/log';
import {
  trackSession,
  getStreamState,
  clearStreamState,
  initStreamState,
} from '@/cache/session-cache';

/** A streaming block — text, tool call, or tool result */
export interface StreamingTextBlock {
  type: 'text';
  content: string;
}

export interface StreamingToolCallBlock {
  type: 'tool_call';
  toolUseId: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  status: 'calling' | 'done' | 'error';
  planContent?: string;
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string;
}

export interface StreamingSystemBlock {
  type: 'system';
  variant: 'compact' | 'error' | 'info';
  message: string;
  detail?: string;
}

export interface StreamingPermissionBlock {
  type: 'permission';
  requestId: string;
  toolName: string;
  input?: Record<string, unknown>;
  reason?: string;
  /** Set when resolved (from snapshot or permission-resolved event). Absent = pending. */
  status?: 'pending' | 'allowed' | 'denied';
}

/** Model reasoning ("thinking" mode). Rendered gray/italic, collapsible. */
export interface StreamingThinkingBlock {
  type: 'thinking';
  content: string;
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock | StreamingPermissionBlock | StreamingThinkingBlock;

interface StreamSnapshot {
  blocks: StreamingBlock[];
  isStreaming: boolean;
}

interface UseSessionStreamReturn {
  /** Blocks accumulated during the current streaming session */
  blocks: StreamingBlock[];
  /** Whether there's an active stream running */
  isStreaming: boolean;
  /** Clear accumulated blocks (e.g., when batch completes) */
  clear: () => void;
}

/**
 * Subscribe to session streaming events for a specific session.
 *
 * On mount / sessionId change:
 *  1. Sends `session:stream-subscribe` RPC to the server
 *  2. Server returns a snapshot of the current buffer (catch-up)
 *  3. Incremental events arrive via broadcast; client filters by sessionId
 */
export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [blocks, setBlocks] = useState<StreamingBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamBuffer = useRef('');
  const activeSessionId = useRef<string | null>(null);
  const seenPermissionIds = useRef(new Set<string>());
  const resubscribePending = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track WS connection state to re-subscribe on reconnect
  const [wsConnected, setWsConnected] = useState(wsClient.state === 'connected');
  useEffect(() => {
    const onStateChange = (state: ConnectionState) => setWsConnected(state === 'connected');
    wsClient.onConnectionChange(onStateChange);
    return () => { wsClient.offConnectionChange(onStateChange); };
  }, []);

  // Subscribe to backend stream buffer when sessionId changes OR WS reconnects
  useEffect(() => {
    activeSessionId.current = sessionId;

    if (!sessionId || !wsConnected) {
      if (!sessionId) {
        setBlocks([]);
        setIsStreaming(false);
        streamBuffer.current = '';
      }
      return;
    }

    // Track session so global cache listeners accumulate its events in the background
    trackSession(sessionId);

    // Show cached state instantly (0ms), then correct from server snapshot below.
    // The cache may be stale (missed events during WS disconnect), so the RPC
    // subscribe always runs as authoritative correction.
    const cached = getStreamState(sessionId);
    if (cached) {
      log.info('stream', `cache hit: blocks=${cached.blocks.length} isStreaming=${cached.isStreaming}`, { sessionId });
      setBlocks([...cached.blocks]);
      setIsStreaming(cached.isStreaming);
      streamBuffer.current = cached.textBuffer;
    } else {
      setBlocks([]);
      setIsStreaming(false);
      streamBuffer.current = '';
    }

    // Always subscribe to get server snapshot for correction (background).
    //
    // Non-regressive merge: this useEffect re-runs on WS reconnect too, and the
    // server snapshot may lag behind live events that have already been applied
    // to blocks/isStreaming via the incremental WS handlers. Clobbering them
    // here caused the "1. 2. 3 → restart 1. 2. 3" replay bug: reattachWatcher
    // on reconnect made daemon catch-up push bytes through the delta pipeline
    // into blocks, then this snapshot fired a moment later with older/shorter
    // state and overwrote the in-progress turn.
    //
    // Rules (mirrored from doResubscribe below):
    //   - blocks:      only overwrite if we currently have none (initial load)
    //   - isStreaming: only promote false→true (never regress a live turn)
    wsClient.sendRpc<StreamSnapshot>('session:stream-subscribe', { sessionId })
      .then((snapshot) => {
        // Guard: session may have changed during the async RPC
        if (activeSessionId.current !== sessionId) return;
        if (!snapshot) return;
        log.info('stream', `subscribe snapshot: blocks=${snapshot.blocks.length} isStreaming=${snapshot.isStreaming}`, { sessionId });
        let appliedBlocks = false;
        setBlocks((prev) => {
          if (prev.length > 0) return prev;
          appliedBlocks = true;
          return snapshot.blocks;
        });
        setIsStreaming((prev) => (snapshot.isStreaming && !prev) ? true : prev);
        if (appliedBlocks) {
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
          streamBuffer.current = lastText ? lastText.content : '';
          // Seed global cache with server snapshot for correction
          initStreamState(sessionId, snapshot.blocks, snapshot.isStreaming);
          // Seed seenPermissionIds from snapshot (prevent duplicate blocks on re-emit)
          for (const b of snapshot.blocks) {
            if (b.type === 'permission') seenPermissionIds.current.add(b.requestId);
          }
        }
      })
      .catch(() => {
        // Subscription failed — stay with current state (cache or empty)
      });

    // Fallback: fetch pending permissions from REST (covers cases where buffer was pruned)
    fetch(`/api/sessions/${sessionId}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { pendingPermissions?: Array<{ requestId: string; toolName?: string; input?: Record<string, unknown>; reason?: string }> } | null) => {
        if (activeSessionId.current !== sessionId) return;
        const perms = data?.pendingPermissions;
        if (!perms?.length) return;
        setBlocks(prev => {
          const existingIds = new Set(prev.filter(b => b.type === 'permission').map(b => (b as StreamingPermissionBlock).requestId));
          const newBlocks = perms
            .filter(p => !existingIds.has(p.requestId))
            .map(p => ({ type: 'permission' as const, requestId: p.requestId, toolName: p.toolName ?? 'unknown', input: p.input, reason: p.reason }));
          if (newBlocks.length === 0) return prev;
          for (const b of newBlocks) seenPermissionIds.current.add(b.requestId);
          return [...prev, ...newBlocks];
        });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, wsConnected]);

  // ── Re-fetch snapshot on session:status-changed → in_progress ──
  // When a session transitions to in_progress (e.g., after WS reconnect or
  // timing edge case), re-fetch the snapshot to catch up on any missed events.

  const doResubscribe = useCallback((sid: string) => {
    if (resubscribePending.current) return; // avoid duplicate RPCs
    resubscribePending.current = true;

    wsClient.sendRpc<StreamSnapshot>('session:stream-subscribe', { sessionId: sid })
      .then((snapshot) => {
        resubscribePending.current = false;
        if (activeSessionId.current !== sid) return;
        if (snapshot) {
          // Only apply snapshot if we don't already have streaming data
          // (avoid clobbering blocks from incremental events that arrived in between)
          setBlocks((prev) => prev.length > 0 ? prev : snapshot.blocks);
          // Non-regressive sync: snapshot only allowed to promote isStreaming false→true.
          // Rationale: a stale server-side buffer (cleared 2s after previous session:result)
          // returns isStreaming=false even while a new turn is live; unconditional sync
          // would flip the active stream to 'done' and trigger the downstream defensive
          // clear, wiping live blocks.  Termination of a turn now relies solely on real
          // events: session:result / session:error / session:status-changed backstop.
          setIsStreaming((prev) => {
            if (snapshot.isStreaming && !prev) {
              log.info('stream', `resubscribe snapshot → isStreaming false→true`, { sessionId: sid });
              return true;
            }
            if (!snapshot.isStreaming && prev) {
              log.info('stream', `resubscribe snapshot stale (prev=true, snap=false) — ignoring`, { sessionId: sid });
            }
            return prev;
          });
          const lastText = [...snapshot.blocks].reverse().find((b): b is StreamingTextBlock => b.type === 'text');
          if (lastText) streamBuffer.current = lastText.content;
        }
      })
      .catch(() => {
        resubscribePending.current = false;
      });
  }, []);

  useEvent('session:status-changed', (data) => {
    const { sessionId: sid, phase, process_status } = data as {
      sessionId: string; phase?: string; process_status?: string;
    };
    if (!sessionId || sid !== sessionId) return;
    // Re-subscribe when session transitions to running (IN_PROGRESS phase or running process)
    const isActive = phase === 'IN_PROGRESS' || process_status === 'running';
    if (!isActive) {
      // Backstop: when the process reaches a non-active state (stopped/error/idle),
      // force-clear isStreaming. This covers cases where session:result was missed
      // (WS disconnect, sessionId mismatch, process crash). session:status-changed
      // is broadcast with ['*'] destinations so it's the most reliable termination signal.
      // 'idle' is terminal for streaming: FIFO sessions stay alive between turns in
      // 'idle', with no deltas until the next user send — so clearing here matches the
      // actual "not streaming" state. A new turn will flip isStreaming back to true via
      // the text-delta / tool-use handlers before any visible lag.
      if (process_status === 'stopped' || process_status === 'error' || process_status === 'idle') {
        // Ordering: flush BEFORE clearing isStreaming. A pending rAF text frame may
        // still be queued from the last delta; if we flipped isStreaming first, the UI
        // could render the "done" state before the final text chunk lands. flushPendingTextRaf
        // drains the buffer synchronously.
        flushPendingTextRaf();
        setIsStreaming((prev) => {
          if (prev) log.info('stream', `status-changed ps=${process_status} → isStreaming true→false`, { sessionId: sid });
          return false;
        });
      } else {
        log.info('stream', `status-changed → phase=${phase} ps=${process_status} (not active, skipping)`, { sessionId: sid });
      }
      return;
    }

    // Session just transitioned to in_progress — re-subscribe to ensure
    // the server-side subscription mapping is fresh and get any buffered data.
    doResubscribe(sid);

    // Safety-net: if isStreaming is still false after 3s, force one more re-subscribe.
    // Clear any existing timer first.
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      if (activeSessionId.current !== sid) return;
      // Check latest isStreaming via functional setState trick (read without extra ref)
      setIsStreaming((current) => {
        if (!current) {
          // Still not streaming — force one more re-subscribe
          resubscribePending.current = false; // reset so doResubscribe proceeds
          doResubscribe(sid);
        }
        return current;
      });
    }, 3000);
  });

  // Cancel safety timer when isStreaming becomes true or sessionId changes
  useEffect(() => {
    if (isStreaming && safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    return () => {
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
  }, [sessionId]);

  // ── Incremental updates (broadcast to all clients; filtered by sessionId client-side) ──

  // Handle text deltas — batch via rAF to coalesce rapid tokens into ~60 renders/sec
  const textDeltaRaf = useRef<number | null>(null);

  /** Flush any pending rAF text update synchronously, then cancel the frame.
   *  Called before streamBuffer is cleared (tool-use, result, error, session switch)
   *  to prevent data loss from the race: delta→rAF queued→buffer cleared→rAF fires with empty. */
  const flushPendingTextRaf = useCallback(() => {
    if (textDeltaRaf.current !== null) {
      cancelAnimationFrame(textDeltaRaf.current);
      textDeltaRaf.current = null;

      // Apply buffered text synchronously
      const accumulated = streamBuffer.current;
      if (accumulated) {
        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'text') {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated }];
          }
          return [...prev, { type: 'text', content: accumulated }];
        });
      }
    }
  }, []);

  // Cancel pending rAF on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => {
      if (textDeltaRaf.current !== null) {
        cancelAnimationFrame(textDeltaRaf.current);
        textDeltaRaf.current = null;
      }
    };
  }, []);

  useEvent('session:text-delta', (data) => {
    const { sessionId: sid, delta } = data as { sessionId: string; delta: string; taskId: string };
    if (!sessionId || sid !== sessionId) return; // defensive client-side check

    setIsStreaming((prev) => {
      if (!prev) log.info('stream', 'text-delta → isStreaming false→true', { sessionId: sid });
      return true;
    });
    streamBuffer.current += delta;

    if (textDeltaRaf.current === null) {
      textDeltaRaf.current = requestAnimationFrame(() => {
        textDeltaRaf.current = null;
        const accumulated = streamBuffer.current;

        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'text') {
            return [...prev.slice(0, -1), { type: 'text', content: accumulated }];
          }
          return [...prev, { type: 'text', content: accumulated }];
        });
      });
    }
  });

  // Handle tool use events
  useEvent('session:tool-use', (data) => {
    const { sessionId: sid, toolName, toolUseId, input, planContent, parentToolUseId } = data as {
      sessionId: string; toolName: string; toolUseId: string;
      input?: Record<string, unknown>; taskId: string; planContent?: string; parentToolUseId?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);
    // Flush any pending text before resetting the buffer
    flushPendingTextRaf();
    streamBuffer.current = '';

    setBlocks((prev) => [
      ...prev,
      { type: 'tool_call', toolUseId, name: toolName, input, status: 'calling', ...(planContent ? { planContent } : {}), ...(parentToolUseId ? { parentToolUseId } : {}) },
    ]);
  });

  // Handle tool result events
  useEvent('session:tool-result', (data) => {
    const { sessionId: sid, toolUseId, result } = data as {
      sessionId: string; toolUseId: string; result: string; taskId: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setBlocks((prev) => {
      const updated = [...prev];
      // Find the matching tool_call block and mark it done
      for (let i = updated.length - 1; i >= 0; i--) {
        const b = updated[i];
        if (b.type === 'tool_call' && b.toolUseId === toolUseId && b.status === 'calling') {
          updated[i] = { ...b, status: isToolResultError(result) ? 'error' : 'done', result };
          break;
        }
      }
      return updated;
    });
  });

  // ── Thinking delta: accumulate like text but in a separate block type ──
  const thinkingBuffer = useRef('');
  const thinkingDeltaRaf = useRef<number | null>(null);

  useEvent('session:thinking-delta', (data) => {
    const { sessionId: sid, delta } = data as { sessionId: string; delta: string };
    if (!sessionId || sid !== sessionId) return;

    setIsStreaming(true);
    thinkingBuffer.current += delta;

    if (thinkingDeltaRaf.current === null) {
      thinkingDeltaRaf.current = requestAnimationFrame(() => {
        thinkingDeltaRaf.current = null;
        const accumulated = thinkingBuffer.current;
        setBlocks((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.type === 'thinking') {
            return [...prev.slice(0, -1), { type: 'thinking', content: accumulated }];
          }
          return [...prev, { type: 'thinking', content: accumulated }];
        });
      });
    }
  });

  // Reset thinking buffer when anything else interrupts (text/tool/system)
  // — handled below by flushing on tool-use / system-event.

  // ── Unknown-event catch-all: surface as an info system block so new CLI
  //    event types never silently disappear from the UI. ──
  useEvent('session:unknown-event', (data) => {
    const { sessionId: sid, scope, eventType, snippet } = data as {
      sessionId: string; scope: string; eventType: string; snippet: string;
    };
    if (!sessionId || sid !== sessionId) return;

    setBlocks((prev) => [
      ...prev,
      { type: 'system', variant: 'info', message: `Unknown Claude event: ${scope}:${eventType}`, detail: snippet },
    ]);
  });

  // Handle system events (compact, error, info notifications)
  useEvent('session:system-event', (data) => {
    const { sessionId: sid, variant, message, detail } = data as {
      sessionId: string; variant: 'compact' | 'error' | 'info'; message: string; detail?: string;
    };
    if (!sessionId || sid !== sessionId) return;

    // Don't set isStreaming — system events are notifications, not active text streaming.
    flushPendingTextRaf();
    streamBuffer.current = '';  // system event breaks text accumulation

    setBlocks((prev) => [...prev, { type: 'system', variant, message, detail } as StreamingSystemBlock]);
  });

  // Handle permission request events (control_request from Claude Code)
  useEvent('session:permission-request', (data) => {
    const { sessionId: sid, requestId, toolName, input, reason } = data as {
      sessionId: string; requestId: string; toolName: string;
      input?: Record<string, unknown>; reason?: string;
    };
    if (!sessionId || sid !== sessionId) return;
    if (seenPermissionIds.current.has(requestId)) return; // dedup
    seenPermissionIds.current.add(requestId);

    flushPendingTextRaf();
    streamBuffer.current = '';
    setBlocks(prev => [...prev, { type: 'permission', requestId, toolName, input, reason }]);
  });

  // Handle permission resolved events (update block status from pending → allowed/denied)
  useEvent('session:permission-resolved', (data) => {
    const { sessionId: sid, requestId, allowed } = data as {
      sessionId: string; requestId: string; allowed: boolean;
    };
    if (!sessionId || sid !== sessionId) return;
    setBlocks(prev => prev.map(b =>
      b.type === 'permission' && b.requestId === requestId
        ? { ...b, status: allowed ? 'allowed' as const : 'denied' as const }
        : b,
    ));
  });

  // Handle session result (streaming done)
  useEvent('session:result', (data) => {
    const { sessionId: sid } = data as { sessionId: string };
    if (!sessionId || sid !== sessionId) return;

    // Flush any pending text before clearing — prevents last-frame data loss
    flushPendingTextRaf();
    setIsStreaming((prev) => {
      log.info('stream', `session:result → isStreaming ${prev}→false`, { sessionId: sid });
      return false;
    });
    setBlocks((prev) => {
      log.info('stream', `session:result blocks=${prev.length} (kept, cleared by batch-completed)`, { sessionId: sid });
      return prev;
    });
    streamBuffer.current = '';
  });

  // Handle session error (streaming done with error)
  useEvent('session:error', (data) => {
    const { sessionId: sid, error } = data as { sessionId: string; error?: string };
    if (!sessionId || sid !== sessionId) return;

    flushPendingTextRaf();
    setIsStreaming(false);
    streamBuffer.current = '';

    // Show the error inline in the session chat timeline
    if (error) {
      const detail = error.length > 500 ? error.slice(0, 500) + '…' : error;
      setBlocks((prev) => [...prev, { type: 'system', variant: 'error', message: 'Session error', detail } as StreamingSystemBlock]);
    }
  });

  const clear = useCallback(() => {
    flushPendingTextRaf();
    setBlocks((prev) => {
      if (prev.length > 0) log.info('stream', `clear() blocks=${prev.length}→0`, { sessionId: activeSessionId.current });
      return [];
    });
    setIsStreaming((prev) => {
      if (prev) log.info('stream', `clear() isStreaming true→false`, { sessionId: activeSessionId.current });
      return false;
    });
    streamBuffer.current = '';
    seenPermissionIds.current.clear();
    // Sync-clear global cache so switching away and back doesn't restore stale blocks
    if (activeSessionId.current) clearStreamState(activeSessionId.current);
  }, [flushPendingTextRaf]);

  return { blocks, isStreaming, clear };
}

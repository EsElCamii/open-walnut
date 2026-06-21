import { useState, useEffect } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import { perf } from '@/utils/perf-logger';
import type { SessionHistoryMessage } from '@/types/session';
import {
  trackSession,
  getHistoryCache,
  setHistoryCache,
  clearStreamState,
} from '@/cache/session-cache';

interface UseSessionHistoryReturn {
  messages: SessionHistoryMessage[];
  loading: boolean;
  /** Phase 2 (SSH/full fetch) still in progress — true between Phase 1 completion and Phase 2 completion */
  phase2Pending: boolean;
  error: string | null;
  /** Index in messages[] where the fork boundary is (source messages end, forked messages start) */
  forkBoundaryIndex?: number;
}

/** Diagnostic: count user text messages and check if they're interleaved or bunched */
function diagnoseOrdering(phase: string, sid: string, msgs: SessionHistoryMessage[]): void {
  const userIndices: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user' && msgs[i].text?.trim()) userIndices.push(i);
  }
  if (userIndices.length === 0) {
    console.debug(`[session-history] ${phase} ${sid}: ${msgs.length} msgs, 0 user text msgs`);
    return;
  }
  // Check: are user messages bunched at the end?
  const lastAsst = msgs.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1);
  const usersAfterLastAsst = userIndices.filter(i => i > lastAsst).length;
  const bunched = usersAfterLastAsst > userIndices.length / 2;
  console.debug(
    `[session-history] ${phase} ${sid}: ${msgs.length} msgs, ${userIndices.length} user text, ` +
    `lastAsst@${lastAsst}, usersAfterLast=${usersAfterLastAsst}${bunched ? ' ⚠️ BUNCHED' : ' ✓ interleaved'}`
  );
}

/**
 * Two-phase session history loading:
 * Phase 1: Read local streams file (~1ms) — instant display
 * Phase 2: Async fetch source of truth (may SSH, 3-5s) — silent update
 *
 * When version > 0 (re-fetch after batch-completed), skip Phase 1 — go directly to Phase 2.
 * Phase 1 reads local streams for fast initial display; on re-fetch the client
 * already has messages rendered, so the fast-path just adds latency for no benefit.
 *
 * `enabled` (default true) gates the EXPENSIVE Phase 2 SSH fetch only. Pass
 * false for offscreen/restored-but-not-visible session columns so they render
 * instantly from the local streams/cache (Phase 1) without each firing a 20-30s
 * remote SSH history pull that would saturate the browser's ~5 HTTP/1.1 lanes
 * during the home fan-out. Flip it true when the column becomes visible to
 * trigger the full fetch. Default true preserves existing callers unchanged.
 */
export function useSessionHistory(sessionId: string | null, version = 0, enabled = true): UseSessionHistoryReturn {
  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [phase2Pending, setPhase2Pending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkBoundaryIndex, setForkBoundaryIndex] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setLoading(false);
      setPhase2Pending(false);
      setError(null);
      setForkBoundaryIndex(undefined);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setError(null);
    setForkBoundaryIndex(undefined);
    const sid = sessionId.substring(0, 8);

    // Track session so global cache accumulates its events in background
    trackSession(sessionId);

    // Re-fetch (version > 0): skip Phase 1, go directly to Phase 2.
    // When disabled (offscreen column), there's nothing to do — Phase 2 is the
    // only work here and we don't want its SSH cost until visible.
    if (version > 0) {
      if (!enabled) return () => { cancelled = true; controller.abort(); };
      setLoading(true);
      setPhase2Pending(true);
      const endP2 = perf.start(`session:full:${sid}`);
      fetchSessionHistory(sessionId, { signal: controller.signal })
        .then((result) => {
          if (!cancelled) {
            endP2(`${result.messages.length} msgs`);
            diagnoseOrdering('refetch', sid, result.messages);
            setMessages(result.messages);
            setForkBoundaryIndex(result.forkBoundaryIndex);
            // Update cache
            setHistoryCache(sessionId, {
              messages: result.messages,
              forkBoundaryIndex: result.forkBoundaryIndex,
              msgCount: result.messages.length,
            });
            // version > 0 IS the authoritative signal that the turn completed — always clear
            clearStreamState(sessionId);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) { endP2('error'); setError(e.message); }
        })
        .finally(() => {
          if (!cancelled) { setLoading(false); setPhase2Pending(false); }
        });
      return () => { cancelled = true; controller.abort(); };
    }

    // Initial load (version === 0): check cache first
    const cached = getHistoryCache(sessionId);
    if (cached) {
      // Cache hit → 0ms instant display, then background Phase 2 verification.
      setMessages(cached.messages);
      setForkBoundaryIndex(cached.forkBoundaryIndex);
      setLoading(false);
      // Offscreen column: show cache, skip the background SSH re-verify until visible.
      if (!enabled) return () => { cancelled = true; controller.abort(); };
      setPhase2Pending(true);

      const endP2 = perf.start(`session:full:${sid}`);
      fetchSessionHistory(sessionId, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          endP2(`${result.messages.length} msgs`);
          diagnoseOrdering('cache-verify', sid, result.messages);
          // Detect if a new turn completed while we were away: if message count grew,
          // clear stale streaming blocks so they don't display alongside the new history.
          const turnCompleted = result.messages.length > cached.msgCount;
          setHistoryCache(sessionId, {
            messages: result.messages,
            forkBoundaryIndex: result.forkBoundaryIndex,
            msgCount: result.messages.length,
          });
          if (turnCompleted) clearStreamState(sessionId);
          setMessages(result.messages);
          setForkBoundaryIndex(result.forkBoundaryIndex);
        })
        .catch((e: Error) => {
          if (!cancelled) { endP2('error'); setError(e.message); }
        })
        .finally(() => {
          if (!cancelled) setPhase2Pending(false);
        });

      return () => { cancelled = true; controller.abort(); };
    }

    // Cache miss → normal Phase 1 (streams) → Phase 2 (full)
    setLoading(true);
    setPhase2Pending(true);

    // Phase 1: Fast local read (streams file, ~1ms)
    const endP1 = perf.start(`session:streams:${sid}`);
    fetchSessionHistory(sessionId, { source: 'streams', signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        endP1(`${result.messages.length} msgs`);
        diagnoseOrdering('P1:streams', sid, result.messages);
        if (result.messages.length > 0) {
          setMessages(result.messages);
        }
        if (result.forkBoundaryIndex != null) setForkBoundaryIndex(result.forkBoundaryIndex);
        setLoading(false); // Always clear loading — even if empty, don't block on Phase 2
      })
      .catch(() => {
        endP1('error');
      })
      .finally(() => {
        if (cancelled) return;
        // Offscreen column: Phase 1 (local streams) already gave instant
        // content; skip the expensive Phase 2 SSH fetch until visible.
        if (!enabled) { setPhase2Pending(false); return; }
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions)
        const endP2 = perf.start(`session:full:${sid}`);
        fetchSessionHistory(sessionId, { signal: controller.signal })
          .then((result) => {
            if (!cancelled) {
              endP2(`${result.messages.length} msgs`);
              diagnoseOrdering('P2:full', sid, result.messages);
              setMessages(result.messages);
              setForkBoundaryIndex(result.forkBoundaryIndex);
              // Write to cache for next visit
              setHistoryCache(sessionId, {
                messages: result.messages,
                forkBoundaryIndex: result.forkBoundaryIndex,
                msgCount: result.messages.length,
              });
            }
          })
          .catch((e: Error) => {
            if (!cancelled) { endP2('error'); setError(e.message); }
          })
          .finally(() => {
            if (!cancelled) { setLoading(false); setPhase2Pending(false); }
          });
      });

    return () => { cancelled = true; controller.abort(); };
  }, [sessionId, version, enabled]);

  return { messages, loading, phase2Pending, error, forkBoundaryIndex };
}

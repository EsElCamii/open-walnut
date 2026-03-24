import { useState, useEffect } from 'react';
import { fetchSessionHistory } from '@/api/sessions';
import { perf } from '@/utils/perf-logger';
import type { SessionHistoryMessage } from '@/types/session';

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
 */
export function useSessionHistory(sessionId: string | null, version = 0): UseSessionHistoryReturn {
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
    setLoading(true);
    setError(null);
    setForkBoundaryIndex(undefined);
    const sid = sessionId.substring(0, 8);

    // Re-fetch (version > 0): skip Phase 1, go directly to Phase 2
    if (version > 0) {
      setPhase2Pending(true);
      const endP2 = perf.start(`session:full:${sid}`);
      fetchSessionHistory(sessionId)
        .then((result) => {
          if (!cancelled) {
            endP2(`${result.messages.length} msgs`);
            diagnoseOrdering('refetch', sid, result.messages);
            setMessages(result.messages);
            setForkBoundaryIndex(result.forkBoundaryIndex);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) { endP2('error'); setError(e.message); }
        })
        .finally(() => {
          if (!cancelled) { setLoading(false); setPhase2Pending(false); }
        });
      return () => { cancelled = true; };
    }

    // Initial load (version === 0): Phase 1 (streams) → Phase 2 (full)
    setPhase2Pending(true);

    // Phase 1: Fast local read (streams file, ~1ms)
    const endP1 = perf.start(`session:streams:${sid}`);
    fetchSessionHistory(sessionId, { source: 'streams' })
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
        // Phase 2: Full fetch (source of truth, may SSH for remote sessions)
        const endP2 = perf.start(`session:full:${sid}`);
        fetchSessionHistory(sessionId)
          .then((result) => {
            if (!cancelled) {
              endP2(`${result.messages.length} msgs`);
              diagnoseOrdering('P2:full', sid, result.messages);
              setMessages(result.messages);
              setForkBoundaryIndex(result.forkBoundaryIndex);
            }
          })
          .catch((e: Error) => {
            if (!cancelled) { endP2('error'); setError(e.message); }
          })
          .finally(() => {
            if (!cancelled) { setLoading(false); setPhase2Pending(false); }
          });
      });

    return () => { cancelled = true; };
  }, [sessionId, version]);

  return { messages, loading, phase2Pending, error, forkBoundaryIndex };
}

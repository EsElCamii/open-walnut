/**
 * WorkflowTranscriptModal — full-screen reader for one dynamic-workflow subagent's
 * complete transcript.
 *
 * The inline accordion in WorkflowProgress shows only the prompt + result preview;
 * the full per-agent conversation (subagents/workflows/<run>/agent-<id>.jsonl) is too
 * long for that cramped box. This opens it in a large overlay (≈90vw×90vh) so it's
 * actually readable — reusing the app's modal infra (useModalOverlay = Escape +
 * ref-counted scroll lock) and portal-to-body, the same pattern as ConfirmDialog /
 * the session fullscreen.
 *
 * Lazy-fetches on mount via the workflow subagent history endpoint and caches per
 * agentId (namespaced `wf:` so it can't collide with a flat Task/Team subagent id).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { fetchSubagentHistory } from '@/api/sessions';
import { getSubagentCache, setSubagentCache } from '@/cache/session-cache';
import { SessionMessage } from './SessionMessage';
import { ICON_CLOSE } from '../common/Icons';
import type { SessionHistoryMessage } from '@/types/session';
import { log } from '@/utils/log';

export interface TranscriptTarget {
  agentId: string;
  label?: string;
  model?: string;
  meta?: string; // pre-formatted "model · tokens · duration"
}

export function WorkflowTranscriptModal({
  target, sessionId, onClose,
}: { target: TranscriptTarget; sessionId: string; onClose: () => void }) {
  useModalOverlay(onClose);
  const [messages, setMessages] = useState<SessionHistoryMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `wf:${target.agentId}`;
    const cached = getSubagentCache(sessionId, cacheKey);
    if (cached) { setMessages(cached); return; }
    setLoading(true);
    fetchSubagentHistory(sessionId, target.agentId, { workflow: true })
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        setSubagentCache(sessionId, cacheKey, res.messages);
        log.info('workflow', `loaded subagent transcript ${target.agentId}: ${res.messages.length} msgs`, { sessionId });
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn('workflow', 'failed to load subagent transcript', { agentId: target.agentId, error: String(err) });
        setMessages([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, target.agentId]);

  return createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <span className="wf-modal-title">{target.label || target.agentId}</span>
          {target.meta && <span className="wf-modal-meta">{target.meta}</span>}
          <button className="wf-modal-close" onClick={onClose} aria-label="Close transcript" title="Close (Esc)">
            {ICON_CLOSE}
          </button>
        </div>
        <div className="wf-modal-body">
          {loading ? (
            <div className="wf-modal-loading">Loading transcript…</div>
          ) : messages && messages.length > 0 ? (
            messages.map((m, i) => <SessionMessage key={i} message={m} sessionId={sessionId} />)
          ) : (
            <div className="wf-modal-loading">No transcript available</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

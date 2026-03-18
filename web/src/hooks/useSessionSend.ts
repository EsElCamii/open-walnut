import { useState, useCallback, useEffect } from 'react';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { ImageAttachment } from '@/api/chat';

interface UseSessionSendReturn {
  optimisticMsgs: OptimisticMessage[];
  sendError: string | null;
  send: (sessionId: string, message: string, images?: ImageAttachment[]) => void;
  interruptSend: (sessionId: string, message: string, images?: ImageAttachment[]) => void;
  handleMessagesDelivered: (count: number) => void;
  handleBatchCompleted: (count: number) => void;
  handleEditQueued: (sessionId: string, queueId: string, newText: string) => void;
  handleDeleteQueued: (sessionId: string, queueId: string) => void;
  addExternalQueued: (msg: { queueId: string; text: string }) => void;
  clearOptimistic: () => void;
  clearCommitted: () => void;
}

/**
 * Shared hook for sending messages to Claude Code sessions with optimistic UI.
 * Used by both SessionsPage and TaskDetailPage.
 *
 * ## State machine: optimisticMsgs[]
 *
 *   pending → received → delivered → (removed by handleBatchCompleted)
 *
 *   - send()                   → appends as 'pending', then RPC resolves → 'received'
 *   - handleMessagesDelivered  → first N pending/received → 'delivered'
 *   - handleBatchCompleted     → removes first N messages (count-based, authoritative)
 *
 * ## handleBatchCompleted — count-based removal
 *
 * The backend's batch count is authoritative. When a turn completes, the first
 * `count` optimistic messages are removed outright — the re-fetched persisted
 * history already contains them (possibly combined with \n\n when multiple
 * messages are delivered together; see claude-code-session.ts processNext).
 *
 * See SessionChatHistory.tsx top-of-file doc block for the full lifecycle.
 */
export function useSessionSend(activeSessionId: string | null): UseSessionSendReturn {
  const [optimisticMsgs, setOptimisticMsgs] = useState<OptimisticMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  // Clear optimistic messages on session switch
  useEffect(() => {
    setOptimisticMsgs([]);
    setSendError(null);
  }, [activeSessionId]);

  const send = useCallback((sessionId: string, message: string, images?: ImageAttachment[]) => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    const rpcPayload: Record<string, unknown> = { sessionId, message };
    if (images && images.length > 0) {
      rpcPayload.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
    }
    wsClient.sendRpc<{ messageId: string }>('session:send', rpcPayload)
      .then((res) => {
        if (res?.messageId) {
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === tempId ? { ...m, queueId: res.messageId, status: 'received' as const } : m
          ));
        }
      })
      .catch((e: Error) => {
        log.error('send', 'RPC failed', { sessionId, error: e.message });
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
      });
  }, []);

  const interruptSend = useCallback((sessionId: string, message: string, images?: ImageAttachment[]) => {
    setSendError(null);

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('send', 'dispatching (interrupt)', { sessionId, queueId: tempId });
    const optimistic: OptimisticMessage = {
      role: 'user',
      text: message,
      timestamp: new Date().toISOString(),
      queueId: tempId,
      status: 'pending',
      images,
    };
    setOptimisticMsgs((prev) => [...prev, optimistic]);

    const rpcPayload: Record<string, unknown> = { sessionId, message, interrupt: true };
    if (images && images.length > 0) {
      rpcPayload.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
    }
    wsClient.sendRpc<{ messageId: string }>('session:send', rpcPayload)
      .then((res) => {
        if (res?.messageId) {
          setOptimisticMsgs((prev) => prev.map((m) =>
            m.queueId === tempId ? { ...m, queueId: res.messageId, status: 'received' as const } : m
          ));
        }
      })
      .catch((e: Error) => {
        log.error('send', 'RPC failed (interrupt)', { sessionId, error: e.message });
        setSendError(e.message);
        setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== tempId));
      });
  }, []);

  const handleMessagesDelivered = useCallback((count: number) => {
    log.info('send', 'delivered', { count });
    setOptimisticMsgs((prev) => {
      let remaining = count;
      return prev.map((m) => {
        if (remaining > 0 && (m.status === 'pending' || m.status === 'received')) {
          remaining--;
          return { ...m, status: 'delivered' as const };
        }
        return m;
      });
    });
  }, []);

  const handleBatchCompleted = useCallback((count: number) => {
    log.info('send', 'batch completed', { count });
    setOptimisticMsgs((prev) => {
      // Remove the first `count` messages outright — the backend's batch count is
      // authoritative and the re-fetched persisted history already contains them
      // (possibly combined with \n\n when multiple messages are delivered together —
      // see claude-code-session.ts handleSend / processNext).
      let remaining = count;
      return prev.filter(m => {
        if (remaining > 0) {
          remaining--;
          return false; // remove this message
        }
        return true; // keep
      });
    });
  }, []);

  const handleEditQueued = useCallback((sessionId: string, queueId: string, newText: string) => {
    setOptimisticMsgs((prev) => prev.map((m) =>
      m.queueId === queueId ? { ...m, text: newText } : m
    ));
    wsClient.sendRpc('session:edit-queued', {
      sessionId, messageId: queueId, text: newText,
    }).catch((e: Error) => { log.warn('send', 'edit-queued failed', { sessionId, queueId, error: e.message }); });
  }, []);

  const handleDeleteQueued = useCallback((sessionId: string, queueId: string) => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.queueId !== queueId));
    wsClient.sendRpc('session:delete-queued', {
      sessionId, messageId: queueId,
    }).catch((e: Error) => { log.warn('send', 'delete-queued failed', { sessionId, queueId, error: e.message }); });
  }, []);

  // Handle messages queued externally (e.g. by the agent via send_to_session)
  // These arrive via bus event after the server has already enqueued the message,
  // so we go straight to 'received' (shows "Queued" badge immediately).
  const addExternalQueued = useCallback((msg: { queueId: string; text: string }) => {
    setOptimisticMsgs(prev => {
      // Dedup: skip if this queueId already exists (guard against double-delivery)
      if (prev.some(m => m.queueId === msg.queueId)) return prev;
      return [...prev, {
        queueId: msg.queueId,
        text: msg.text,
        role: 'user' as const,
        timestamp: new Date().toISOString(),
        status: 'received' as const,
      }];
    });
  }, []);

  const clearOptimistic = useCallback(() => {
    setOptimisticMsgs([]);
    setSendError(null);
  }, []);

  // No-op: 'committed' status is no longer assigned (handleBatchCompleted removes
  // messages directly). Kept for interface compatibility with prop-threaded callers.
  const clearCommitted = useCallback(() => {
    setOptimisticMsgs((prev) => prev.filter((m) => m.status !== 'committed'));
  }, []);

  return {
    optimisticMsgs,
    sendError,
    send,
    interruptSend,
    handleMessagesDelivered,
    handleBatchCompleted,
    handleEditQueued,
    handleDeleteQueued,
    addExternalQueued,
    clearOptimistic,
    clearCommitted,
  };
}

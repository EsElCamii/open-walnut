/**
 * SessionRetryButton — inline retry button for failed sessions.
 * Resume path: sends message to existing session (triggers --resume, preserves history).
 * Fallback path: archives old session and starts new one on same task (no claudeSessionId).
 */

import { useState, useCallback } from 'react';
import { retrySession } from '@/api/sessions';

interface SessionRetryButtonProps {
  sessionId: string;
  onRetried?: (taskId: string) => void;   // fallback path (new session created)
  onResuming?: () => void;                 // resume path (same session resumes)
}

export function SessionRetryButton({ sessionId, onRetried, onResuming }: SessionRetryButtonProps) {
  const [state, setState] = useState<'idle' | 'retrying' | 'error'>('idle');

  const handleRetry = useCallback(async () => {
    setState('retrying');
    try {
      const result = await retrySession(sessionId);
      if (result.status === 'resuming') {
        // Same session — processNext() emits status events, UI auto-updates
        onResuming?.();
      } else {
        // Fallback: new session on same task
        onRetried?.(result.taskId);
      }
    } catch {
      setState('error');
    }
  }, [sessionId, onRetried, onResuming]);

  if (state === 'retrying') {
    return (
      <button className="session-retry-btn" disabled>
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5, display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
        Retrying...
      </button>
    );
  }

  return (
    <button className="session-retry-btn" onClick={handleRetry}>
      {state === 'error' ? 'Retry failed — try again' : 'Retry'}
    </button>
  );
}

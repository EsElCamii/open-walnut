/**
 * SessionRetryButton — inline retry button for failed sessions.
 * Calls POST /api/sessions/:sessionId/retry to archive the failed session
 * and start a new one on the same task.
 */

import { useState, useCallback } from 'react';
import { retrySession } from '@/api/sessions';

interface SessionRetryButtonProps {
  sessionId: string;
  onRetried?: (taskId: string) => void;
}

export function SessionRetryButton({ sessionId, onRetried }: SessionRetryButtonProps) {
  const [state, setState] = useState<'idle' | 'retrying' | 'error'>('idle');

  const handleRetry = useCallback(async () => {
    setState('retrying');
    try {
      const result = await retrySession(sessionId);
      onRetried?.(result.taskId);
    } catch {
      setState('error');
    }
  }, [sessionId, onRetried]);

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

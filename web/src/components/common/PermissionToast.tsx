import { useState, useCallback, useRef } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { useNavigate } from 'react-router-dom';

interface PermissionNotification {
  id: number;
  sessionId: string;
  requestId: string;
  toolName: string;
  timestamp: number;
}

let nextId = 0;

const TOAST_LIFETIME_MS = 15000;

/**
 * Global toast for permission requests from sessions the user isn't currently viewing.
 * Shows a dismissible notification with a "Go to session" action.
 */
export function PermissionToast() {
  const [toasts, setToasts] = useState<PermissionNotification[]>([]);
  const seenRequestIds = useRef(new Set<string>());
  const navigate = useNavigate();

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEvent('session:permission-request', (data) => {
    const { sessionId, requestId, toolName } = data as {
      sessionId: string; requestId: string; toolName: string;
    };
    if (!sessionId || !requestId) return;
    // Dedup: don't show the same permission twice (re-emit timer fires every 60s)
    if (seenRequestIds.current.has(requestId)) return;
    seenRequestIds.current.add(requestId);

    const id = ++nextId;
    setToasts((prev) => [...prev, { id, sessionId, requestId, toolName, timestamp: Date.now() }]);
    setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);

    // Browser notification if tab is not focused
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Permission Required', {
        body: `Session needs approval: ${toolName}`,
        tag: `perm-${requestId}`,
      });
    }
  });

  // Dismiss when a permission is resolved
  useEvent('session:permission-resolved', (data) => {
    const { requestId } = data as { requestId: string };
    if (!requestId) return;
    setToasts(prev => prev.filter(t => t.requestId !== requestId));
  });

  if (toasts.length === 0) return null;

  return (
    <div className="permission-toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className="permission-toast">
          <div className="permission-toast-header">
            <span className="permission-toast-icon">&#x26A0;&#xFE0F;</span>
            <span className="permission-toast-tool">{toast.toolName}</span>
            <button
              className="permission-toast-close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
          <div className="permission-toast-body">
            Session needs permission approval
          </div>
          <button
            className="permission-toast-action"
            onClick={() => {
              navigate(`/sessions?id=${toast.sessionId}`);
              dismiss(toast.id);
            }}
          >
            Go to Session
          </button>
        </div>
      ))}
    </div>
  );
}

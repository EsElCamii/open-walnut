import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotes } from './SessionNotes';
import { FileViewer } from '../common/FileViewer';
import { ICON_ROBOT, ICON_EXPAND, ICON_COLLAPSE, ICON_PIN, ICON_PIN_FILLED, ICON_CLOSE } from '../common/Icons';
import { UserMessagesSummary } from './UserMessagesSummary';
import { PlanPreviewSection } from './PlanPreviewSection';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSessionStream } from '@/hooks/useSessionStream';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, executePlanContinue, executePlanSession } from '@/api/sessions';
import { fetchTask } from '@/api/tasks';
import { fetchPinnedTasks, pinTask, unpinTask } from '@/api/focus';
import { timeAgo } from '@/utils/time';
import { PhasePicker } from './WorkStatusPicker';
import { SessionCopyButtons } from './SessionCopyButtons';
import { ModelPicker } from './ModelPicker';
import { TaskQuickActions } from './TaskQuickActions';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { SessionRetryButton } from './SessionRetryButton';
import { wsClient } from '@/api/ws';
import type { SessionRecord, TaskPhase } from '@/types/session';

interface SessionPanelErrorBoundaryProps {
  sessionId: string;
  onClose: (sessionId: string) => void;
  children: ReactNode;
}

interface SessionPanelErrorBoundaryState {
  hasError: boolean;
}

class SessionPanelErrorBoundary extends Component<SessionPanelErrorBoundaryProps, SessionPanelErrorBoundaryState> {
  constructor(props: SessionPanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): SessionPanelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SessionPanel crashed:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: SessionPanelErrorBoundaryProps) {
    if (this.state.hasError && prevProps.sessionId !== this.props.sessionId) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="session-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px' }}>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>Something went wrong loading this session.</p>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              sessionStorage.removeItem('open-walnut-home-session-columns');
              this.props.onClose(this.props.sessionId);
            }}
          >
            Close panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface SessionPanelProps {
  sessionId: string;
  /** Stable close handler — receives the sessionId so parent can identify which panel to close. */
  onClose: (sessionId: string) => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  /** Called when "Clear Context & Execute" creates a new session — receives (oldId, newId). */
  onSessionReplaced?: (oldSessionId: string, newSessionId: string) => void;
  /** Called immediately when Fork is clicked — parent can show a pending panel. */
  onForkPending?: (cwd: string, host?: string) => void;
  /** Called when fork API returns — parent stores taskId for WS-based session resolution. */
  onForkResolved?: (taskId: string) => void;
  /** Called when fork API fails — parent should remove the pending panel. */
  onForkFailed?: () => void;
}

export const SessionPanel = memo(function SessionPanel({ sessionId, onClose, onTaskClick, onSessionClick, onSessionReplaced, onForkPending, onForkResolved, onForkFailed }: SessionPanelProps) {
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const { optimisticMsgs, sendError, send, interruptSend, retryFailed, dismissFailed, handleMessagesDelivered, handleBatchCompleted, handleEditQueued, handleDeleteQueued, addExternalQueued, clearCommitted } = useSessionSend(sessionId);
  const { isStreaming } = useSessionStream(sessionId);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Slash command autocomplete for session input
  const { items: slashCommands, search: searchSlashCommands } = useSlashCommands(session?.cwd);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // CSS-promotion fullscreen (same instance, no remount)
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      setModelPickerOpen(true);
    }
  }, []);

  const handleModelSwitch = useCallback((model: string, immediate: boolean) => {
    setModelPickerOpen(false);
    // Send RPC with model switch (empty message is fine -- backend handles it via pendingModel)
    wsClient.sendRpc('session:send', {
      sessionId,
      message: '',
      model,
      interrupt: immediate || undefined,
    }).catch((err) => {
      console.error('Model switch failed:', err);
    });
  }, [sessionId]);

  // Fetch messages for the UserMessagesSummary
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId);

  // Plan content for PlanPreviewSection
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  const shouldFetchPlan = hasPlan || isFromPlan;
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId || undefined, shouldFetchPlan);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId);
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;
  const rawModel = liveUsage.model || session?.model || lastAssistant?.model;
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      const ctxSize = getContextWindowSize(rawModel, totalInput);
      contextPercent = Math.round(totalInput / ctxSize * 100);
    }
  }

  // FileViewer state
  const [fileViewerState, setFileViewerState] = useState<{ path: string; line?: number } | null>(null);
  const handleFileOpen = useCallback((path: string, line?: number) => {
    setFileViewerState({ path, line });
  }, []);
  const handleFileViewerClose = useCallback(() => setFileViewerState(null), []);

  // Scroll-to-message handler for UserMessagesSummary
  const handleMessageClick = useCallback((messageIndex: number) => {
    const container = bodyRef.current?.querySelector('.session-history');
    if (!container) return;
    const target = container.querySelector(`[data-msg-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('user-messages-highlight');
      setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
    } else {
      // Message is truncated — ask SessionChatHistory to expand and scroll to it
      container.dispatchEvent(new CustomEvent('expand-to-message', {
        detail: { messageIndex }, bubbles: false,
      }));
    }
  }, []);

  // Task title for the breadcrumb link
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  // Full task object — passed to TaskQuickActions to avoid a duplicate fetch
  const [sessionTask, setSessionTask] = useState<import('@open-walnut/core').Task | null>(null);

  // Pin state — self-contained (calls focus API directly)
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);

  // Check if this session's task is pinned (on mount + config changes)
  const refreshPinState = useCallback((taskId: string | undefined) => {
    if (!taskId) return;
    fetchPinnedTasks()
      .then((data) => setPinned(data.pinned_tasks.includes(taskId)))
      .catch(() => {});
  }, []);

  useEvent('config:changed', () => { refreshPinState(session?.taskId); });

  const handleTogglePin = useCallback(async () => {
    if (!session?.taskId || pinBusy) return;
    setPinBusy(true);
    try {
      if (pinned) {
        await unpinTask(session.taskId);
        setPinned(false);
      } else {
        await pinTask(session.taskId);
        setPinned(true);
      }
    } catch (err) {
      console.error('Pin toggle failed:', err);
    } finally {
      setPinBusy(false);
    }
  }, [session?.taskId, pinned, pinBusy]);

  // Fetch session metadata
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setLoading(true);
    setTaskTitle(null);
    setSessionTask(null);
    setPinned(false);
    fetchSession(sessionId).then((s) => {
      if (!cancelled) {
        setSession(s);
        setLoading(false);
        // Fetch associated task title + pin state
        if (s?.taskId) {
          fetchTask(s.taskId).then((t) => {
            if (!cancelled) {
              setTaskTitle(t.title);
              setSessionTask(t);
            }
          }).catch(() => {});
          refreshPinState(s.taskId);
        }
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Merge event data directly on status changes (avoids stale DB reads)
  useEvent('session:status-changed', (data) => {
    const d = data as { sessionId?: string; process_status?: string; phase?: string; activity?: string; mode?: string; planCompleted?: boolean };
    if (d.sessionId === sessionId) {
      setSession(prev => prev ? {
        ...prev,
        process_status: (d.process_status ?? prev.process_status) as SessionRecord['process_status'],
        activity: d.activity ?? prev.activity,
        mode: (d.mode ?? prev.mode) as SessionRecord['mode'],
        ...(d.planCompleted ? { planCompleted: true } : {}),
        // Clear stale error when session recovers from error state
        ...(d.process_status && d.process_status !== 'error' ? { errorMessage: undefined } : {}),
        lastActiveAt: new Date().toISOString(),
      } : prev);
      // Update phase on sessionTask if present
      if (d.phase) {
        setSessionTask(prev => prev ? { ...prev, phase: d.phase as import('@open-walnut/core').Task['phase'] } : prev);
      }
    }
  });

  // Keep sessionTask in sync with real-time task events (phase changes, completions)
  useEvent('task:updated', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) {
      setSessionTask(d.task);
      setTaskTitle(d.task.title);
    }
  });
  useEvent('task:completed', (data) => {
    const d = data as { task?: import('@open-walnut/core').Task };
    if (d.task && session?.taskId && d.task.id === session.taskId) {
      setSessionTask(d.task);
      setTaskTitle(d.task.title);
    }
  });

  useEvent('session:result', (data) => {
    const d = data as { sessionId?: string };
    if (d.sessionId === sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  useEvent('session:error', (data) => {
    const d = data as { sessionId?: string; error?: string };
    if (d.sessionId === sessionId) {
      // Immediately show error message from event (before refetch completes)
      if (d.error) {
        setSession(prev => prev ? { ...prev, process_status: 'error' as const, errorMessage: d.error!.slice(0, 500) } : prev);
      }
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  // Re-fetch session state on WebSocket reconnect.
  // Events during disconnect (e.g. session:status-changed, session:result) are lost;
  // without this, the UI can show stale "Resuming session..." indefinitely.
  // Typical trigger: a `dev:prod` server restart drops the WS connection briefly.
  useEvent('_ws:reconnected', () => {
    if (sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  // Execute plan buttons state
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);

  // Reset execute + fullscreen state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    exitFullscreen();
  }, [sessionId, exitFullscreen]);

  const showExecuteButtons =
    session?.planCompleted === true
    && session?.process_status !== 'error'
    && !executeStarted;

  const handleExecuteContinue = useCallback(async () => {
    setExecuting(true);
    setExecuteError(null);
    try {
      await executePlanContinue(sessionId);
      setExecuteStarted(true);
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId]);

  const handleClearContextExecute = useCallback(async () => {
    const clickedSessionId = sessionIdRef.current; // snapshot at click time
    setExecuting(true);
    setExecuteError(null);
    try {
      const result = await executePlanSession(sessionId);
      setExecuteStarted(true);
      // Only navigate if user is still viewing the same session
      if (result.sessionId && sessionIdRef.current === clickedSessionId) {
        onSessionReplaced?.(sessionId, result.sessionId);
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId, onSessionReplaced]);

  // Retry — resume path: session auto-recovers via WS status events, nothing to do.
  // Retry — fallback path: listen for task:updated to detect new session linked after retry.
  const retryTaskIdRef = useRef<string | null>(null);
  const handleResuming = useCallback(() => {
    // processNext() emits SESSION_STATUS_CHANGED which updates session state.
    // Error banner clears automatically when errorMessage is cleared.
  }, []);
  const handleRetried = useCallback((taskId: string) => {
    retryTaskIdRef.current = taskId;
  }, []);
  useEvent('task:updated', (data: unknown) => {
    const d = data as { task?: { id?: string; exec_session_id?: string; plan_session_id?: string } };
    const t = d.task;
    if (!t?.id || !retryTaskIdRef.current || t.id !== retryTaskIdRef.current) return;
    const newSessionId = t.exec_session_id ?? t.plan_session_id;
    if (newSessionId) {
      retryTaskIdRef.current = null;
      onSessionReplaced?.(sessionId, newSessionId);
    }
  });

  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    send(sessionId, message, images);
  }, [sessionId, send]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    interruptSend(sessionId, message, images);
  }, [sessionId, interruptSend]);

  const handleEdit = useCallback((queueId: string, newText: string) => {
    handleEditQueued(sessionId, queueId, newText);
  }, [sessionId, handleEditQueued]);

  const handleDelete = useCallback((queueId: string) => {
    handleDeleteQueued(sessionId, queueId);
  }, [sessionId, handleDeleteQueued]);

  const handleRetry = useCallback((queueId: string) => {
    retryFailed(queueId, sessionId);
  }, [sessionId, retryFailed]);

  const ps = session?.process_status;
  const taskPhase = (sessionTask?.phase ?? 'TODO') as TaskPhase;

  // Header content
  const title = session?.title || session?.description || session?.slug || null;
  const sessionsPageUrl = `/sessions?id=${sessionId}`;

  return (
    <SessionPanelErrorBoundary sessionId={sessionId} onClose={onClose}>
      {FullscreenBackdrop}
      <div className={`session-panel${fullscreenClass}`}>
        <div className="session-panel-header">
          <div className="session-panel-header-top">
            <div className="session-panel-title-area">
              {title
                ? <span className="session-panel-title" title={title}>{title}</span>
                : <span className="session-panel-title text-muted">Untitled session</span>
              }
              {!loading && session?.provider === 'embedded' && (
                <span
                  className="session-panel-badge"
                  style={{
                    color: 'var(--accent)',
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    fontSize: '10px',
                    fontWeight: 600,
                  }}
                >
                  {ICON_ROBOT} Embedded
                </span>
              )}
              {!loading && ps && session?.taskId && (
                <PhasePicker
                  taskId={session.taskId}
                  processStatus={ps}
                  phase={taskPhase}
                  size="sm"
                  errorMessage={session?.errorMessage}
                />
              )}
              {loading && <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Loading...</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
              <button
                className="task-action-btn session-panel-expand"
                onClick={isFullscreen ? exitFullscreen : enterFullscreen}
                title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
                aria-label={isFullscreen ? 'Collapse session' : 'Expand session to full screen'}
              >
                {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
              </button>
              {session?.taskId && (
                <button
                  className={`task-action-btn session-panel-pin${pinned ? ' pinned' : ''}`}
                  onClick={handleTogglePin}
                  disabled={pinBusy}
                  title={pinned ? 'Unpin from Focus Bar' : 'Pin to Focus Bar'}
                  aria-label={pinned ? 'Unpin from Focus Bar' : 'Pin to Focus Bar'}
                >
                  {pinned ? ICON_PIN_FILLED : ICON_PIN}
                </button>
              )}
              <button className="task-action-btn session-panel-close" onClick={() => onClose(sessionId)} title="Close session panel">
                {ICON_CLOSE}
              </button>
            </div>
          </div>
          {session?.taskId && (
            <div className="session-panel-task-row">
              <div
                className="session-panel-task-link"
                role="button"
                tabIndex={0}
                onClick={() => onTaskClick?.(session.taskId!)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTaskClick?.(session.taskId!); }}
                title={taskTitle ? `Go to task: ${taskTitle}` : `Go to task ${session.taskId}`}
              >
                <span className="session-panel-task-icon">&#x1F4CB;</span>
                <span className="session-panel-task-title">{taskTitle || session.taskId}</span>
                <span className="session-panel-task-arrow">&#x2197;</span>
              </div>
              <TaskQuickActions taskId={session.taskId} task={sessionTask} />
            </div>
          )}
          <div className="session-panel-meta">
            <span
              className="session-panel-id session-panel-id-link"
              role="button"
              tabIndex={0}
              onClick={() => navigate(sessionsPageUrl)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(sessionsPageUrl); }}
              title={`Open in Sessions page\n${sessionId}`}
            >
              {sessionId} &#x2197;
            </span>
            <SessionCopyButtons
              sessionId={sessionId}
              cwd={session?.cwd}
              project={session?.project}
              taskId={session?.taskId}
              taskTitle={taskTitle ?? undefined}
              onForkStarted={(cwd, host) => {
                onForkPending?.(cwd, host);
              }}
              onForkComplete={(newTaskId) => {
                onForkResolved?.(newTaskId);
                // Select the new child task (session will be opened via WS event)
                onTaskClick?.(newTaskId);
              }}
              onForkFailed={onForkFailed}
            />
            {session?.host && (
              <span
                className="session-panel-host"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--fg-muted)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  fontWeight: 600,
                }}
                title={session.hostname || session.host}
              >
                SSH: {session.host}
              </span>
            )}
            {displayModel && (
              <span className="session-detail-model-pill" title={rawModel || ''}>
                {displayModel}
                {contextPercent != null && (
                  <span
                    className="session-detail-context-pct"
                    style={{
                      color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                        : contextPercent > 50 ? 'var(--warning, #ff9500)'
                        : 'var(--fg-muted)',
                    }}
                    title={`Context: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K)` : ''}`}
                  >
                    {' '}{contextPercent}%
                  </span>
                )}
              </span>
            )}
            {session?.lastActiveAt && <span className="session-panel-time">{timeAgo(session.lastActiveAt)}</span>}
          </div>
        </div>

        {showExecuteButtons && (
          <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="execute-plan-btn"
              onClick={handleExecuteContinue}
              disabled={executing}
              style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px' }}
            >
              {executing ? 'Starting\u2026' : '\u25B6 Execute'}
            </button>
            <button
              className="execute-plan-btn-secondary"
              onClick={handleClearContextExecute}
              disabled={executing}
              style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '6px' }}
            >
              Clear Context & Execute
            </button>
            {executeError && (
              <span className="text-xs" style={{ color: 'var(--error)' }}>{executeError}</span>
            )}
          </div>
        )}
        {executeStarted && (
          <p className="text-xs text-muted" style={{ padding: '4px 12px', margin: 0 }}>
            Execution started.
          </p>
        )}
        {session && <PlanPreviewSection session={session} plan={plan} loading={planLoading} refresh={planRefresh} />}
        <UserMessagesSummary
          messages={historyMessages}
          loading={historyLoading}
          onMessageClick={handleMessageClick}
        />
        <SessionNotes
          sessionId={sessionId}
          initialNote={session?.human_note}
        />
        {ps === 'error' && session?.errorMessage && (
          <div className="session-error-banner">
            <span className="session-error-banner-icon">&#x26A0;&#xFE0F;</span>
            <span className="session-error-banner-text">{session.errorMessage}</span>
            <SessionRetryButton sessionId={sessionId} onRetried={handleRetried} onResuming={handleResuming} />
          </div>
        )}
        <div className="session-panel-body" ref={bodyRef}>
          <SessionChatHistory
            key={sessionId}
            sessionId={sessionId}
            phase={taskPhase}
            initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
            sessionCwd={session?.cwd}
            sessionHost={session?.host}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onEditQueued={handleEdit}
            onDeleteQueued={handleDelete}
            onAgentQueued={addExternalQueued}
            onClearCommitted={clearCommitted}
            onRetryFailed={handleRetry}
            onDismissFailed={dismissFailed}
            onTaskClick={onTaskClick}
            onSessionClick={onSessionClick}
            onFileOpen={handleFileOpen}
          />
        </div>

        <div className="session-panel-input">
          {sendError && (
            <div className="text-xs" style={{ color: 'var(--error)', padding: '4px 12px' }}>
              {sendError}
            </div>
          )}
          <ChatInput
            onSend={handleSend}
            onInterruptSend={handleInterruptSend}
            isStreaming={isStreaming}
            placeholder="Send a message to this session... (/ for commands)"
            showCommands={false}
            sessionCommands={slashCommands}
            searchSessionCommands={searchSlashCommands}
            onControlCommand={handleControlCommand}
            draftKey={`draft:session:${sessionId}`}
          />
          {modelPickerOpen && (
            <ModelPicker
              currentModel={rawModel}
              onSwitch={handleModelSwitch}
              onClose={() => setModelPickerOpen(false)}
            />
          )}
        </div>
        {fileViewerState && (
          <FileViewer
            path={fileViewerState.path}
            line={fileViewerState.line}
            host={session?.host}
            onClose={handleFileViewerClose}
          />
        )}
      </div>
    </SessionPanelErrorBoundary>
  );
});

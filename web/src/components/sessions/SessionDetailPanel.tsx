import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotes } from './SessionNotes';
import { FileViewer } from '../common/FileViewer';
import { UserMessagesSummary } from './UserMessagesSummary';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { PhasePicker } from './WorkStatusPicker';
import { SessionCopyButtons } from './SessionCopyButtons';
import { TaskQuickActions } from './TaskQuickActions';
import { updateSession, executePlanSession, executePlanContinue } from '@/api/sessions';
import { SessionRetryButton } from './SessionRetryButton';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
import { useEvent } from '@/hooks/useWebSocket';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import type { SessionRecord, TaskPhase } from '@/types/session';
import { timeAgo } from '@/utils/time';
import { ICON_CLIPBOARD, ICON_LIGHTNING, ICON_WARNING } from '@/components/common/Icons';

interface SessionDetailPanelProps {
  session: SessionRecord | null;
  taskTitle?: string;
  summary?: string;
  /** Task phase — used for phase display (replaces old work_status). */
  phase?: TaskPhase;
  /** @deprecated No longer used — kept for backward compat. */
  taskHasExecSession?: boolean;
  onTitleChanged?: () => void;
  /** Called when "Clear Context & Execute" creates a new session — parent should update selectedId. */
  onSessionReplaced?: (newSessionId: string) => void;
  optimisticMessages?: import('./SessionChatHistory').OptimisticMessage[];
  onMessagesDelivered?: (count: number) => void;
  onBatchCompleted?: (count: number) => void;
  onEditQueued?: (queueId: string, newText: string) => void;
  onDeleteQueued?: (queueId: string) => void;
  onAgentQueued?: (msg: { queueId: string; text: string }) => void;
  onClearCommitted?: () => void;
  onRetryFailed?: (queueId: string) => void;
  onDismissFailed?: (queueId: string) => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function CopyableId({ value, truncate }: { value: string; truncate?: number }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  };
  const display = truncate ? value.slice(0, truncate) + '\u2026' : value;
  return (
    <span className="session-detail-copyable" onClick={copy} title={`Click to copy: ${value}`}>
      <code>{display}</code>
      <span className="session-detail-copy-icon">{copied ? 'Copied' : 'Copy'}</span>
    </span>
  );
}

function EditableTitle({ sessionId, title, onSaved }: { sessionId: string; title: string; onSaved?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }
    setSaving(true);
    updateSession(sessionId, { title: trimmed })
      .then(() => {
        setEditing(false);
        onSaved?.();
      })
      .catch(() => {
        setValue(title);
        setEditing(false);
      })
      .finally(() => setSaving(false));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { setValue(title); setEditing(false); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="session-detail-title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        disabled={saving}
        maxLength={500}
      />
    );
  }

  return (
    <h2
      className="session-detail-title session-detail-title-editable"
      onClick={() => setEditing(true)}
      title="Click to rename"
    >
      {title}
    </h2>
  );
}

export function SessionDetailPanel({ session, taskTitle, summary, phase: propPhase, onTitleChanged, onSessionReplaced, optimisticMessages, onMessagesDelivered, onBatchCompleted, onEditQueued, onDeleteQueued, onAgentQueued, onClearCommitted, onRetryFailed, onDismissFailed }: SessionDetailPanelProps) {
  const navigate = useNavigate();
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fileViewerState, setFileViewerState] = useState<{ path: string; line?: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(session?.claudeSessionId);
  sessionIdRef.current = session?.claudeSessionId;

  // Action chip toggle state
  const [planPopoverOpen, setPlanPopoverOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const planPopoverRef = useRef<HTMLDivElement>(null);

  // Close plan popover on outside click
  useEffect(() => {
    if (!planPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (planPopoverRef.current && !planPopoverRef.current.contains(e.target as Node)) {
        setPlanPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [planPopoverOpen]);

  // Fetch messages for the UserMessagesSummary
  const sessionId_ = session?.claudeSessionId || '';
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId_ || null);

  // Lift plan hook here so we can provide plan content via context to all PlanCards
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  // mode === 'plan' covers sessions still actively planning — planCompleted is only set after the plan tool call finishes,
  // so without this the Plan chip would be hidden during active planning.
  const shouldFetchPlan = hasPlan || isFromPlan || session?.mode === 'plan';
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId_ || undefined, shouldFetchPlan);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId_ || null);
  // Fallback: derive model + context % from last assistant message in history
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;
  // Priority: live WebSocket > SessionRecord > history-derived
  const rawModel = liveUsage.model || session?.model || lastAssistant?.model;
  const displayModel = formatModelName(rawModel);
  // Context %: live WS first, then compute from history usage
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      const ctxSize = getContextWindowSize(rawModel, totalInput);
      contextPercent = Math.round(totalInput / ctxSize * 100);
    }
  }

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
    if (newSessionId && session?.claudeSessionId) {
      retryTaskIdRef.current = null;
      onSessionReplaced?.(newSessionId);
    }
  });

  const handleFileOpen = useCallback((path: string, line?: number) => {
    setFileViewerState({ path, line });
  }, []);
  const handleFileViewerClose = useCallback(() => setFileViewerState(null), []);

  // Scroll-to-message: find the message element in SessionChatHistory by data-msg-index
  const handleMessageClick = useCallback((messageIndex: number) => {
    const container = panelRef.current?.querySelector('.session-history');
    if (!container) return;
    const target = container.querySelector(`[data-msg-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight
      target.classList.add('user-messages-highlight');
      setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
    } else {
      // Message is truncated — ask SessionChatHistory to expand and scroll to it
      container.dispatchEvent(new CustomEvent('expand-to-message', {
        detail: { messageIndex }, bubbles: false,
      }));
    }
  }, []);

  // Reset state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setDetailsOpen(false);
    setPlanPopoverOpen(false);
    setNotesOpen(false);
    setMessagesOpen(false);
  }, [session?.claudeSessionId]);

  if (!session) {
    return (
      <div className="session-detail-panel">
        <div className="session-detail-empty">
          <p className="text-muted">Select a session to view its conversation</p>
        </div>
      </div>
    );
  }

  const sessionId = session.claudeSessionId || '';
  const title = session.title || session.description || session.slug || sessionId || 'Untitled session';
  const ps = session.process_status ?? 'stopped';
  const taskPhase: TaskPhase = propPhase ?? 'TODO';
  const isEmbedded = session.provider === 'embedded';
  // planCompleted=true means the plan is definitively done — show Execute even if session is still running
  // (SSH FIFO sessions stay alive after plan completion; execution creates a new session anyway).
  // For exec sessions without planCompleted, require the session to be stopped.
  const showExecuteButtons =
    (session.planCompleted === true || (plan && !planLoading && ps !== 'running'))
    && ps !== 'error'
    && !executeStarted;

  /** "Execute" — resumes the same session with bypass permissions. */
  const handleExecuteContinue = async () => {
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
  };

  /** "Clear Context & Execute" — creates a fresh session, old one is archived (reason: plan_executed). */
  const handleClearContextExecute = async () => {
    const clickedSessionId = sessionIdRef.current; // snapshot at click time
    setExecuting(true);
    setExecuteError(null);
    try {
      const result = await executePlanSession(sessionId);
      setExecuteStarted(true);
      // Only navigate if user is still viewing the same session
      if (result.sessionId && sessionIdRef.current === clickedSessionId) {
        onSessionReplaced?.(result.sessionId);
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  };

  // Build compact meta bar items
  const taskLabel = taskTitle || session.taskId;
  const hasDetails = !!(session.project || session.startedAt || session.cwd || session.host || session.activity || session.description);

  const planContentValue = plan?.content ?? null;

  return (
    <PlanContentContext.Provider value={planContentValue}>
      <div className="session-detail-panel" ref={panelRef}>
        <div className="session-detail-header">
          {/* Title row with badges */}
          <div className="session-detail-title-row">
            <EditableTitle sessionId={sessionId} title={title} onSaved={onTitleChanged} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {session.mode && session.mode !== 'default' && (
                <span
                  className="session-detail-badge"
                  style={{ color: 'var(--fg-muted)', background: 'var(--bg-tertiary)', fontWeight: 600, fontSize: '11px' }}
                >
                  {session.mode === 'plan' ? <>{ICON_CLIPBOARD}{' Plan'}</> : <>{ICON_LIGHTNING}{' Bypass'}</>}
                </span>
              )}
              {session.archived && (
                <span
                  className="session-detail-badge"
                  style={{ color: '#f59e0b', background: '#f59e0b20', fontWeight: 600, fontSize: '11px' }}
                >
                  Archived{session.archive_reason ? ` · ${session.archive_reason === 'plan_executed' ? 'plan executed' : session.archive_reason}` : ''}
                </span>
              )}
              {isEmbedded && (
                <span className="session-detail-badge session-detail-badge-embedded">
                  Embedded
                </span>
              )}
              {session.host && (
                <span
                  className="session-detail-badge"
                  style={{ color: 'var(--fg-muted)', background: 'var(--bg-tertiary)', fontSize: '11px', fontWeight: 600 }}
                  title={session.hostname || session.host}
                >
                  SSH: {session.host}
                </span>
              )}
              {session.taskId && (
                <PhasePicker
                  taskId={session.taskId}
                  processStatus={ps}
                  phase={taskPhase}
                  size="md"
                  errorMessage={session.errorMessage}
                />
              )}
            </div>
          </div>

          {/* Compact meta bar */}
          <div className="session-detail-meta-bar">
            {session.taskId && (
              <>
                <a href={`/tasks/${session.taskId}`} className="session-detail-link" title={`Task: ${session.taskId}`}>
                  {taskLabel}
                </a>
                <TaskQuickActions taskId={session.taskId} />
              </>
            )}
            {displayModel && (
              <span className="session-detail-model-pill" title={liveUsage.model || session?.model || ''}>
                {displayModel}
                {contextPercent != null && (
                  <span
                    className="session-detail-context-pct"
                    style={{
                      color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                        : contextPercent > 50 ? 'var(--warning, #ff9500)'
                        : 'var(--fg-muted)',
                    }}
                    title={`Context window: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K tokens)` : ''}`}
                  >
                    {' '}{contextPercent}%
                  </span>
                )}
              </span>
            )}
            {session.messageCount != null && session.messageCount > 0 && (
              <span>{session.messageCount} msgs</span>
            )}
            {session.lastActiveAt && (
              <span title={new Date(session.lastActiveAt).toLocaleString()}>{timeAgo(session.lastActiveAt)}</span>
            )}
            {/* onForkComplete omitted: fork resolves asynchronously, new session appears via list refresh */}
            {sessionId && (
              <SessionCopyButtons
                sessionId={sessionId}
                cwd={session.cwd}
                project={session.project}
                taskId={session.taskId}
                taskTitle={taskTitle}
              />
            )}
            {ps === 'stopped' && !session.archived && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.7rem', padding: '1px 6px', opacity: 0.7 }}
                onClick={() => updateSession(sessionId, { archived: true })}
                title="Archive this session"
              >
                Archive
              </button>
            )}
            {session.archived && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.7rem', padding: '1px 6px' }}
                onClick={() => updateSession(sessionId, { archived: false })}
                title="Unarchive this session"
              >
                Unarchive
              </button>
            )}
          </div>

          {/* Action chips row: Plan / Notes / Messages */}
          <div className="session-meta-row-2">
            {(shouldFetchPlan || showExecuteButtons) && (
              <div className="session-plan-popover-wrapper" ref={planPopoverRef}>
                <button
                  className={`session-action-chip${planPopoverOpen ? ' session-action-chip-active' : ''}`}
                  onClick={() => setPlanPopoverOpen(o => !o)}
                  title="Plan & Execute"
                >
                  Plan {planPopoverOpen ? '\u25B4' : '\u25BE'}
                </button>
                {planPopoverOpen && (
                  <div className="session-plan-popover">
                    {plan && (
                      <>
                        <div className="session-plan-popover-file">
                          <code title={plan.planFile || ''}>{plan.planFile?.split('/').pop() ?? 'plan.md'}</code>
                          <button
                            className="task-action-btn plan-preview-refresh"
                            onClick={async (e) => { e.stopPropagation(); await planRefresh(); }}
                            title="Refresh plan content"
                            style={{ marginLeft: 'auto' }}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M1.5 8a6.5 6.5 0 0111.3-4.4"/><polyline points="13 1 13 4.5 9.5 4.5"/>
                              <path d="M14.5 8a6.5 6.5 0 01-11.3 4.4"/><polyline points="3 15 3 11.5 6.5 11.5"/>
                            </svg>
                          </button>
                        </div>
                        {isFromPlan && plan.sourceSessionId && (
                          <div className="session-plan-popover-source">
                            from session{' '}
                            <a
                              href={`/sessions?id=${plan.sourceSessionId}`}
                              onClick={(e) => { e.preventDefault(); navigate(`/sessions?id=${plan.sourceSessionId}`); setPlanPopoverOpen(false); }}
                            >
                              {plan.sourceSessionId.slice(0, 12)}...
                            </a>
                          </div>
                        )}
                      </>
                    )}
                    {planLoading && !plan && (
                      <div style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>Loading plan...</div>
                    )}
                    {showExecuteButtons && (
                      <div className="session-plan-popover-actions">
                        <button
                          className="execute-plan-btn"
                          onClick={handleExecuteContinue}
                          disabled={executing}
                        >
                          {executing ? 'Starting\u2026' : '\u25B6 Execute'}
                          <span className="execute-plan-btn-desc">Resume with full permissions</span>
                        </button>
                        <button
                          className="execute-plan-btn-secondary"
                          onClick={handleClearContextExecute}
                          disabled={executing}
                        >
                          Clear Context & Execute
                          <span className="execute-plan-btn-desc">Fresh session with plan injected</span>
                        </button>
                      </div>
                    )}
                    {executeStarted && (
                      <div style={{ fontSize: '11px', color: '#0d9488' }}>Execution started.</div>
                    )}
                    {executeError && (
                      <div style={{ fontSize: '11px', color: 'var(--error)' }}>{executeError}</div>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              className={`session-action-chip${notesOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setNotesOpen(o => !o)}
              title="Session notes"
            >
              Notes
            </button>
            <button
              className={`session-action-chip${messagesOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setMessagesOpen(o => !o)}
              title="My messages in this session"
            >
              Msgs
              {!historyLoading && (() => {
                const count = historyMessages.filter(m => m.role === 'user' && m.text.trim()).length;
                return count > 0 ? <span className="session-action-chip-count">{count}</span> : null;
              })()}
            </button>
          </div>

          {/* Collapsible details */}
          {hasDetails && (
            <div className="session-detail-collapse">
              <button
                className="session-detail-collapse-toggle"
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <span className="session-detail-collapse-arrow">{detailsOpen ? '\u25BE' : '\u25B8'}</span>
                Details
              </button>
              {detailsOpen && (
                <div className="session-detail-collapse-body">
                  <div className="session-detail-info-grid">
                    {session.project && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Project</span>
                        <span className="session-detail-info-value">{session.project}</span>
                      </div>
                    )}
                    {session.startedAt && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Started</span>
                        <span className="session-detail-info-value">{formatDate(session.startedAt)}</span>
                      </div>
                    )}
                    {session.cwd && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Working Dir</span>
                        <span className="session-detail-info-value"><code className="session-detail-code">{session.cwd}</code></span>
                      </div>
                    )}
                    {session.host && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Host</span>
                        <span className="session-detail-info-value">
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <span
                              style={{
                                background: 'var(--bg-tertiary)',
                                color: 'var(--fg-muted)',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}
                            >
                              SSH
                            </span>
                            {session.host}
                          </span>
                        </span>
                      </div>
                    )}
                    {session.activity && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Activity</span>
                        <span className="session-detail-info-value" style={{ fontStyle: 'italic' }}>{session.activity}</span>
                      </div>
                    )}
                    {session.description && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Description</span>
                        <span className="session-detail-info-value">{session.description}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {summary && (
            <p className="session-detail-summary text-sm">{summary}</p>
          )}
        </div>
        {messagesOpen && (
          <div className="session-action-panel">
            <UserMessagesSummary
              messages={historyMessages}
              loading={historyLoading}
              onMessageClick={handleMessageClick}
            />
          </div>
        )}
        {notesOpen && (
          <div className="session-action-panel">
            <SessionNotes
              sessionId={sessionId}
              initialNote={session.human_note}
            />
          </div>
        )}
        {ps === 'error' && session.errorMessage && (() => {
          // Coupling: 'Connection lost' is set by session-health-monitor when daemon unreachable.
          // 'Reconnecting' activity is set by the same monitor's recoverConnectionLostSessions().
          const isReconnecting = session.errorMessage.includes('Connection lost')
            && session.activity?.includes('Reconnecting');
          return (
            <div className={`session-error-banner${isReconnecting ? ' session-error-banner--reconnecting' : ''}`}>
              <span className="session-error-banner-icon">{isReconnecting ? '\u21BB' : ICON_WARNING}</span>
              <span className="session-error-banner-text">
                {isReconnecting ? 'Reconnecting to remote host...' : session.errorMessage}
              </span>
              <SessionRetryButton sessionId={session.claudeSessionId} onRetried={handleRetried} onResuming={handleResuming} />
            </div>
          );
        })()}
        <SessionChatHistory
          key={sessionId}
          sessionId={sessionId}
          phase={taskPhase}
          initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
          sessionCwd={session.cwd}
          sessionHost={session.host}
          optimisticMessages={optimisticMessages}
          onMessagesDelivered={onMessagesDelivered}
          onBatchCompleted={onBatchCompleted}
          onEditQueued={onEditQueued}
          onDeleteQueued={onDeleteQueued}
          onAgentQueued={onAgentQueued}
          onClearCommitted={onClearCommitted}
          onRetryFailed={onRetryFailed}
          onDismissFailed={onDismissFailed}
          onFileOpen={handleFileOpen}
        />
        {fileViewerState && (
          <FileViewer
            path={fileViewerState.path}
            line={fileViewerState.line}
            host={session.host}
            onClose={handleFileViewerClose}
          />
        )}
      </div>
    </PlanContentContext.Provider>
  );
}

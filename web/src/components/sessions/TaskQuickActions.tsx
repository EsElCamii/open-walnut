import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { Task, TaskPhase, TaskPriority } from '@open-walnut/core';
import { fetchTask, updateTask, starTask } from '@/api/tasks';
import { ApiError } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import { PriorityPicker } from '@/components/common/PriorityPicker';
import { usePhaseHooks } from '@/hooks/usePhaseHooks';

/* ── Phase constants (shared with TodoPanel) ─────────────────────── */

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: '○',
  IN_PROGRESS: '◐',
  AGENT_COMPLETE: '✓',
  AWAIT_HUMAN_ACTION: '👤',
  HUMAN_VERIFIED: '✅',
  POST_WORK_COMPLETED: '📦',
  PEER_CODE_REVIEW: '⋈',
  RELEASE_IN_PIPELINE: '▷',
  COMPLETE: '✓✓',
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  HUMAN_VERIFIED: 'Human Verified',
  POST_WORK_COMPLETED: 'Post-Work Done',
  PEER_CODE_REVIEW: 'Peer Code Review',
  RELEASE_IN_PIPELINE: 'Release in Pipeline',
  COMPLETE: 'Complete',
};

const PHASE_ORDER: string[] = [
  'TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION',
  'HUMAN_VERIFIED', 'POST_WORK_COMPLETED',
  'PEER_CODE_REVIEW', 'RELEASE_IN_PIPELINE', 'COMPLETE',
];

/* ── Component ───────────────────────────────────────────────────── */

interface TaskQuickActionsProps {
  taskId: string;
  /** If parent already has the task, pass it to avoid an extra fetch. */
  task?: Task | null;
}

export function TaskQuickActions({ taskId, task: externalTask }: TaskQuickActionsProps) {
  const [task, setTask] = useState<Task | null>(externalTask ?? null);
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const hookPhases = usePhaseHooks();
  const phaseRef = useRef<HTMLDivElement>(null);
  const phaseBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch task if not provided externally
  useEffect(() => {
    if (externalTask !== undefined) { setTask(externalTask ?? null); return; }
    // Reset to avoid showing stale task while the new one loads
    setTask(null);
    fetchTask(taskId).then(setTask).catch((err) => {
      console.error('[TaskQuickActions] Failed to fetch task:', err);
    });
  }, [taskId, externalTask]);

  // Keep in sync via WS events
  useEvent('task:updated', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });
  useEvent('task:completed', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });
  useEvent('task:starred', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });

  // Close phase dropdown on outside click or scroll
  useEffect(() => {
    if (!phaseMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      // Check if click is inside the button wrapper or the fixed menu
      const target = e.target as Node;
      if (phaseRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setPhaseMenuOpen(false);
    };
    const handleScroll = () => setPhaseMenuOpen(false);
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [phaseMenuOpen]);

  const handlePhaseChange = useCallback((phase: string) => {
    if (!task || task.phase === phase) { setPhaseMenuOpen(false); return; }
    const now = new Date().toISOString();
    const completing = phase === 'COMPLETE';
    // Full optimistic update — match server-side applyPhase behavior
    setTask(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        phase: phase as TaskPhase,
        status: completing ? 'done' as const : phase === 'TODO' ? 'todo' as const : 'in_progress' as const,
        ...(completing ? { completed_at: now, session_id: undefined, plan_session_id: undefined, exec_session_id: undefined, session_status: undefined, plan_session_status: undefined, exec_session_status: undefined, needs_attention: undefined } : {}),
        updated_at: now,
      };
    });
    setPhaseMenuOpen(false);
    // Local-first: retry on network errors, only revert on 4xx client errors
    const attempt = (retries: number) => {
      updateTask(taskId, { phase }).catch((err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          // Client error (validation, conflict) — revert to server truth
          fetchTask(taskId).then(setTask).catch(() => {});
          return;
        }
        // Network or server error — keep optimistic state and retry
        if (retries > 0) {
          setTimeout(() => attempt(retries - 1), 2000);
        } else {
          // All retries exhausted — fetch server truth as last resort
          fetchTask(taskId).then(setTask).catch(() => {});
        }
      });
    };
    attempt(5);
  }, [task, taskId]);

  const handleSetPriority = useCallback((priority: TaskPriority) => {
    if (!task) return;
    setTask(prev => prev ? { ...prev, priority } : prev);
    updateTask(taskId, { priority }).catch(() => {
      fetchTask(taskId).then(setTask).catch(() => {});
    });
  }, [task, taskId]);

  const handleToggleStar = useCallback(() => {
    if (!task) return;
    // Compute next value inside updater to use latest state (guards against rapid clicks)
    setTask(prev => prev ? { ...prev, starred: !prev.starred } : prev);
    starTask(taskId).catch(() => {
      fetchTask(taskId).then(setTask).catch(() => {});
    });
  }, [task, taskId]);

  const handleToggleAttention = useCallback(() => {
    if (!task) return;
    let nextAttention = false;
    setTask(prev => {
      if (!prev) return prev;
      nextAttention = !prev.needs_attention;
      return { ...prev, needs_attention: nextAttention };
    });
    // nextAttention is set synchronously by the updater above before the async call
    updateTask(taskId, { needs_attention: nextAttention }).catch(() => {
      fetchTask(taskId).then(setTask).catch(() => {});
    });
  }, [task, taskId]);

  if (!task) return null;

  const isDone = task.status === 'done' || task.phase === 'COMPLETE';

  return (
    <div className="task-quick-actions">
      {/* Phase picker */}
      <div className="task-quick-phase" ref={phaseRef}>
        <button
          ref={phaseBtnRef}
          className={`task-quick-phase-btn${task.phase ? ` task-phase-${task.phase.toLowerCase()}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!phaseMenuOpen && phaseBtnRef.current) {
              const rect = phaseBtnRef.current.getBoundingClientRect();
              setMenuPos({ top: rect.bottom + 2, left: rect.left });
            }
            setPhaseMenuOpen(!phaseMenuOpen);
          }}
          title={PHASE_LABEL[task.phase] ?? 'Change phase'}
        >
          <span className="task-quick-phase-icon">{PHASE_ICON[task.phase] ?? '○'}</span>
          <span className="task-quick-phase-label">{PHASE_LABEL[task.phase] ?? task.phase}</span>
        </button>
        {phaseMenuOpen && menuPos && (
          <div
            ref={menuRef}
            className="phase-picker-menu task-quick-phase-menu"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {PHASE_ORDER.map((phase) => (
              <button
                key={phase}
                className={`phase-picker-item${task.phase === phase ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handlePhaseChange(phase); }}
              >
                <span className={`phase-picker-icon task-phase-${phase.toLowerCase()}`}>
                  {PHASE_ICON[phase]}
                </span>
                <span>{PHASE_LABEL[phase]}</span>
                {hookPhases.has(phase) && (
                  <span className="phase-hook-indicator" title={hookPhases.get(phase)}>⚡</span>
                )}
                {task.phase === phase && <span className="phase-picker-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Priority */}
      <PriorityPicker
        priority={task.priority}
        onChange={handleSetPriority}
        fixed
      />

      {/* Star */}
      <button
        className={`task-quick-star${task.starred ? ' starred' : ''}`}
        onClick={(e) => { e.stopPropagation(); handleToggleStar(); }}
        title={task.starred ? 'Unstar' : 'Star'}
      >
        {task.starred ? '★' : '☆'}
      </button>

      {/* Needs attention */}
      {!isDone && (
        <button
          className={`task-quick-attention${task.needs_attention ? ' active' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleToggleAttention(); }}
          title={task.needs_attention ? 'Clear attention flag' : 'Flag as needs attention'}
        >
          <span className="task-quick-attention-dot" />
        </button>
      )}
    </div>
  );
}

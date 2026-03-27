/**
 * TaskStatusDot — pill badge "S" indicating AI session status.
 *
 * Same size as the source badge (20px pill). Shows:
 *   🟢 green bg + "S" = AI is running
 *   🔴 red bg + "S"   = needs attention (AGENT_COMPLETE / AWAIT_HUMAN_ACTION / error)
 *   hidden             = idle / stopped / no session / completed
 */

import type { Task } from '@walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';

interface TaskStatusDotProps {
  task: Task;
  /** Click handler — typically opens the session panel. */
  onClick?: () => void;
}

type DotColor = 'green' | 'red' | 'none';

/** Determine dot color from task + session state. */
function getDotColor(task: Task): DotColor {
  const ss = task.session_status;
  const sessionId = resolveTaskSessionId(task);

  // No session at all → hidden
  if (!sessionId && !ss) return 'none';

  // Error state → red
  if (ss?.process_status === 'error') return 'red';

  // Running → green
  if (ss?.process_status === 'running') return 'green';

  // Task phase signals needing attention → red
  if (task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION') return 'red';

  // Everything else (idle, stopped, no active session) → hidden
  return 'none';
}

/** Tooltip text for the dot. */
function getDotTitle(task: Task, color: DotColor): string {
  if (color === 'green') return 'AI is working...';
  if (color === 'red') {
    if (task.session_status?.process_status === 'error') return 'Session error';
    if (task.phase === 'AGENT_COMPLETE') return 'AI finished — review needed';
    if (task.phase === 'AWAIT_HUMAN_ACTION') return 'Waiting for you';
    return 'Needs attention';
  }
  return '';
}

const BADGE_COLORS: Record<DotColor, string> = {
  green: 'var(--success)',
  red: 'var(--error)',
  none: 'transparent',
};

export function TaskStatusDot({ task, onClick }: TaskStatusDotProps) {
  const color = getDotColor(task);

  if (color === 'none') return null;

  return (
    <span
      className="task-session-badge"
      title={getDotTitle(task, color) + (onClick ? ' (click to open)' : '')}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClick(); } } : undefined}
      style={{
        background: BADGE_COLORS[color],
        animation: color === 'green' ? 'task-dot-pulse 2s ease-in-out infinite' : undefined,
      }}
    >
      S
    </span>
  );
}

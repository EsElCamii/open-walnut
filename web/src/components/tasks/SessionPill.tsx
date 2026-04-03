/**
 * SessionPill — renders session status for a task.
 *
 * Prefers the new single-slot model (sessionId + sessionStatus).
 * Falls back to legacy 2-slot props (planSessionId/execSessionId + statuses) for backward compat.
 *
 * Three-layer badge format: "Session · {Mode} · {PhaseLabel} / {ProcessLabel}"
 * Examples:
 *   Session · Plan · In Progress / Running
 *   Session · Bypass · Agent Complete / Stopped
 *   Session · Plan · Awaiting Human / Stopped
 */
import { PHASE_LABELS, PROCESS_LABELS, pillPhaseClassSuffix } from '@/utils/session-status';
import type { TaskPhase, ProcessStatus } from '@/types/session';
import { ICON_ROBOT } from '@/components/common/Icons';

interface SessionStatus {
  process_status: string;
  activity?: string;
  provider?: string;
  planCompleted?: boolean;
  mode?: string;
}

interface SessionPillProps {
  /** New single-slot session ID. */
  sessionId?: string;
  /** New single-slot session status (enriched from backend). */
  sessionStatus?: SessionStatus;
  /** Task phase — used for display label and CSS class. */
  phase?: TaskPhase;
  /** @deprecated Legacy 2-slot prop. */
  planSessionId?: string;
  /** @deprecated Legacy 2-slot prop. */
  execSessionId?: string;
  /** @deprecated Legacy 2-slot prop. */
  planStatus?: SessionStatus;
  /** @deprecated Legacy 2-slot prop. */
  execStatus?: SessionStatus;
  /** Historical session IDs for "N sessions" fallback. */
  sessionIds?: string[];
  /** Session mode — used to show "Plan" label. */
  mode?: string;
  /** Click handler — when provided, pill becomes clickable (one-click to open session). */
  onClick?: (e: React.MouseEvent) => void;
  /** Whether this session is currently open in a session column. */
  isActive?: boolean;
}

/** Human-readable phase label from central constants. */
function phaseLabel(phase: TaskPhase | undefined): string {
  if (!phase) return '?';
  return PHASE_LABELS[phase] || phase || '?';
}

/** Human-readable process_status label from central constants. */
function processLabel(status: SessionStatus | undefined): string {
  if (!status) return '?';
  return PROCESS_LABELS[status.process_status as ProcessStatus] || status.process_status || '?';
}

/** CSS class suffix from phase via central utility. */
function stateClassFromPhase(phase: TaskPhase | undefined): string {
  return pillPhaseClassSuffix(phase);
}

/** CSS class suffix from two legacy statuses — picks the most important. */
function stateClassLegacy(plan: SessionStatus | undefined, exec: SessionStatus | undefined, phase: TaskPhase | undefined): string {
  const ps = (s: SessionStatus | undefined) => s?.process_status;
  if (ps(plan) === 'running' || ps(exec) === 'running') return 'running';
  if (ps(plan) === 'error' || ps(exec) === 'error') return 'error';
  return pillPhaseClassSuffix(phase);
}

export function SessionPill({ sessionId, sessionStatus, phase, planSessionId, execSessionId, planStatus, execStatus, sessionIds, mode, onClick, isActive }: SessionPillProps) {
  const clickable = !!onClick;
  const clickClass = clickable ? ' task-session-pill-clickable' : '';
  const activeClass = isActive ? ' task-session-pill-active' : '';
  const handleClick = clickable ? (e: React.MouseEvent) => { e.stopPropagation(); onClick!(e); } : undefined;

  // Resolve mode label: Plan or Bypass (only these two matter to the user)
  // planCompleted on the session_status indicates a plan was produced even if mode !== 'plan'
  const isPlanSession = mode === 'plan' || !!sessionStatus?.planCompleted || !!planStatus?.planCompleted;
  const modeLabel = isPlanSession ? 'Plan' : 'Bypass';

  // New single-slot model: prefer sessionId + sessionStatus
  if (sessionId || sessionStatus) {
    const status = sessionStatus;
    const cls = stateClassFromPhase(phase);
    const wl = phaseLabel(phase);
    const pl = processLabel(status);
    const isEmbedded = status?.provider === 'embedded';
    const title = status
      ? `Session · ${modeLabel}: ${phase ?? 'unknown'} / ${status.process_status}${isEmbedded ? ' (embedded)' : ''}`
      : 'Session';

    return (
      <span className={`task-session-pill task-session-pill-${cls}${clickClass}${activeClass}`} title={title} onClick={handleClick}>
        <span className={`task-session-dot task-session-dot-${cls}`} />
        {isEmbedded ? <>{ICON_ROBOT}{' '}</> : ''}Session · {modeLabel} · {wl} / {pl}
      </span>
    );
  }

  // Legacy 2-slot fallback
  const hasPlan = !!(planSessionId || planStatus);
  const hasExec = !!(execSessionId || execStatus);

  // No active slots — fall back to historical session count
  if (!hasPlan && !hasExec) {
    if (sessionIds && sessionIds.length > 0) {
      return (
        <span className={`task-session-pill task-session-pill-history${clickClass}${activeClass}`} title={`${sessionIds.length} past session(s)`} onClick={handleClick}>
          {sessionIds.length} session{sessionIds.length !== 1 ? 's' : ''}
        </span>
      );
    }
    return null;
  }

  const cls = stateClassLegacy(planStatus, execStatus, phase);

  // Pick the primary session for the process label (prefer exec over plan)
  const primary = hasExec ? execStatus : planStatus;
  const wl = phaseLabel(phase);
  const pl = processLabel(primary);

  // Detect embedded provider
  const isEmbedded = primary?.provider === 'embedded';

  // Resolve legacy mode label from slot presence
  const legacyMode = hasPlan ? 'plan' : mode;
  const legacyModeLabel = legacyMode === 'plan' ? 'Plan' : 'Bypass';

  // Build title with full details for both slots
  const titleParts: string[] = [];
  if (hasPlan && planStatus) titleParts.push(`plan: ${phase ?? 'unknown'} / ${planStatus.process_status}${planStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  if (hasExec && execStatus) titleParts.push(`exec: ${phase ?? 'unknown'} / ${execStatus.process_status}${execStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  const title = titleParts.join('  |  ') || 'Session';

  return (
    <span className={`task-session-pill task-session-pill-${cls}${clickClass}`} title={title} onClick={handleClick}>
      <span className={`task-session-dot task-session-dot-${cls}`} />
      {isEmbedded ? <>{ICON_ROBOT}{' '}</> : ''}Session · {legacyModeLabel} · {wl} / {pl}
    </span>
  );
}

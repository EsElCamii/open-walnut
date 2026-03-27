import { timeAgo } from '@/utils/time';
import type { SessionRecord } from '@/types/session';
import { PROCESS_COLORS, PHASE_COLORS, PHASE_LABELS } from '@/utils/session-status';
import type { TaskPhase } from '@/types/session';

interface SessionRowProps {
  session: SessionRecord;
  selected: boolean;
  onClick: () => void;
  /** Task phase for display (replaces old work_status). */
  phase?: TaskPhase;
}


export function SessionRow({ session, selected, onClick, phase }: SessionRowProps) {
  const sessionId = session.claudeSessionId || '';
  const title = session.title || session.description || session.slug || sessionId || 'Untitled session';
  const processStatus = session.process_status || 'stopped';
  const taskPhase = phase ?? 'TODO';
  const ago = timeAgo(session.lastActiveAt || session.startedAt);

  const statusLabel = PHASE_LABELS[taskPhase] ?? taskPhase;
  const modeIcon = session.mode === 'plan' ? '\uD83D\uDCCB Plan' : session.mode && session.mode !== 'default' ? '\u26A1 Bypass' : null;

  return (
    <div
      className={`session-row${selected ? ' session-row-selected' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="session-row-top">
        <span
          className="session-status-dot"
          style={{ background: PROCESS_COLORS[processStatus] ?? 'var(--fg-muted)' }}
        />
        {modeIcon && (
          <span
            className="text-xs"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--fg-muted)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {modeIcon}
          </span>
        )}
        {session.provider === 'embedded' && (
          <span
            className="text-xs"
            style={{
              color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            🤖
          </span>
        )}
        {session.host && (
          <span
            className="text-xs"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--fg-muted)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
            title={`Running on ${session.host}`}
          >
            SSH: {session.host}
          </span>
        )}
        <span className="session-row-title truncate">{title}</span>
        <span className="session-row-time text-xs text-muted">{ago}</span>
      </div>
      <div className="session-row-bottom" style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '18px' }}>
        <span
          className="text-xs"
          style={{ color: PHASE_COLORS[taskPhase] ?? 'var(--fg-muted)' }}
        >
          {statusLabel}
        </span>
        {session.activity && processStatus === 'running' && (
          <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
            — {session.activity}
          </span>
        )}
      </div>
    </div>
  );
}

import type { ProcessStatus } from '@/types/session';
import { PROCESS_LABELS, PROCESS_COLORS } from '@/utils/session-status';

interface ProcessStatusBadgeProps {
  processStatus: ProcessStatus;
  /** Badge size variant. */
  size?: 'sm' | 'md';
  /** Error detail shown on hover when process_status is 'error'. */
  errorMessage?: string;
}

export function ProcessStatusBadge({ processStatus, size = 'md', errorMessage }: ProcessStatusBadgeProps) {
  const psColor = PROCESS_COLORS[processStatus];
  const badgeBase = size === 'sm' ? 'session-panel-badge' : 'session-detail-badge';

  return (
    <span
      className={badgeBase}
      style={{
        color: psColor,
        background: `color-mix(in srgb, ${psColor} 8%, transparent)`,
      }}
      title={processStatus === 'error' && errorMessage ? errorMessage : PROCESS_LABELS[processStatus]}
    >
      {processStatus === 'running' && (
        <span
          className={size === 'sm' ? 'session-panel-badge-dot' : 'session-detail-badge-dot'}
          style={{ background: psColor }}
        />
      )}
      {PROCESS_LABELS[processStatus]}
    </span>
  );
}

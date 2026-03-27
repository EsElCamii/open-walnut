import { useState, useRef, useEffect, useCallback } from 'react';
import { apiPatch } from '@/api/client';
import type { ProcessStatus, TaskPhase } from '@/types/session';
import { PHASE_LABELS, PHASE_COLORS, PROCESS_LABELS, PROCESS_COLORS } from '@/utils/session-status';

/** Phases the user can manually set via the picker. */
const SETTABLE_PHASES: TaskPhase[] = ['AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION', 'HUMAN_VERIFIED', 'COMPLETE'];

interface PhasePickerProps {
  taskId: string;
  processStatus: ProcessStatus;
  phase: TaskPhase;
  /** Badge size variant. */
  size?: 'sm' | 'md';
  /** Error detail shown on hover when process_status is 'error'. */
  errorMessage?: string;
  /** Called after a successful phase change so parent can update local state. */
  onChanged?: (newPhase: TaskPhase) => void;
}

export function PhasePicker({ taskId, processStatus, phase, size = 'md', errorMessage, onChanged }: PhasePickerProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const ps = processStatus;
  const isError = ps === 'error';
  const phaseColor = isError ? PROCESS_COLORS.error : PHASE_COLORS[phase] ?? '#6b7280';
  const phaseLabel = isError ? PROCESS_LABELS.error : PHASE_LABELS[phase] ?? phase;
  const psColor = PROCESS_COLORS[ps];

  // Can only change phase when process is stopped (not error)
  const canChange = ps === 'stopped' && !saving;

  // Options: all settable phases except current
  const options = SETTABLE_PHASES.filter(p => p !== phase);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = useCallback(async (newPhase: TaskPhase) => {
    setOpen(false);
    setSaving(true);
    try {
      await apiPatch(`/api/tasks/${taskId}`, { phase: newPhase });
      onChanged?.(newPhase);
    } catch (err) {
      console.error('Failed to update phase:', err);
    } finally {
      setSaving(false);
    }
  }, [taskId, onChanged]);

  const badgeBase = size === 'sm' ? 'session-panel-badge' : 'session-detail-badge';

  return (
    <div ref={containerRef} className="work-status-picker" style={{ position: 'relative', display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
      {/* Process status badge — always read-only */}
      <span
        className={badgeBase}
        style={{
          color: psColor,
          background: size === 'sm'
            ? `color-mix(in srgb, ${psColor} 8%, transparent)`
            : `${psColor}14`,
        }}
      >
        {ps === 'running' && (
          <span
            className={size === 'sm' ? 'session-panel-badge-dot' : 'session-detail-badge-dot'}
            style={{ background: psColor }}
          />
        )}
        {PROCESS_LABELS[ps]}
      </span>

      {/* Phase badge — clickable dropdown when process is stopped; shows Error when process_status is 'error' */}
      <span
        className={badgeBase}
        style={{
          color: phaseColor,
          background: size === 'sm'
            ? `color-mix(in srgb, ${phaseColor} 8%, transparent)`
            : `${phaseColor}14`,
          cursor: canChange ? 'pointer' : 'default',
        }}
        onClick={canChange ? () => setOpen(!open) : undefined}
        title={isError && errorMessage ? errorMessage : (canChange ? 'Click to change phase' : phaseLabel)}
        role={canChange ? 'button' : undefined}
        tabIndex={canChange ? 0 : undefined}
        onKeyDown={canChange ? (e) => { if (e.key === 'Enter' || e.key === ' ') setOpen(!open); } : undefined}
      >
        {saving ? 'Saving\u2026' : phaseLabel}
        {canChange && <span style={{ fontSize: '8px', marginLeft: '2px', opacity: 0.6 }}>{open ? '\u25B4' : '\u25BE'}</span>}
      </span>

      {open && (
        <div className="work-status-picker-dropdown">
          {options.map(p => (
            <button
              key={p}
              className="work-status-picker-option"
              onClick={() => handleSelect(p)}
            >
              <span className="work-status-picker-dot" style={{ background: PHASE_COLORS[p] }} />
              {PHASE_LABELS[p]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

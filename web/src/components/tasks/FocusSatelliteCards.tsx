/**
 * Tier card components and drop zone for Focus / Next / Satellite.
 * Each tier gets a SortableTierCard with tier-appropriate action buttons.
 */
import type { CSSProperties } from 'react';
import type { Task } from '@walnut/core';
import type { FocusTier } from '@/api/focus';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

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

// ── SortableTierCard — unified draggable card for any tier ──

interface SortableTierCardProps {
  task: Task;
  tier: FocusTier;
  isFocused: boolean;
  onClick?: (task: Task) => void;
  onSetTier?: (taskId: string, tier: FocusTier) => void;
  onUnpinTask?: (taskId: string) => void;
}

// Tier action config: what buttons to show per tier
const TIER_ACTIONS: Record<FocusTier, { up?: { tier: FocusTier; label: string }; down?: { tier: FocusTier; label: string } }> = {
  focus:    { down: { tier: 'next', label: 'Move to Next' } },
  next:     { up: { tier: 'focus', label: 'Move to Focus' }, down: { tier: 'satellite', label: 'Move to Satellite' } },
  satellite: { up: { tier: 'next', label: 'Move to Next' } },
};

export function SortableTierCard({ task, tier, isFocused, onClick, onSetTier, onUnpinTask }: SortableTierCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  const phaseLabel = PHASE_LABEL[task.phase] ?? task.phase;
  const actions = TIER_ACTIONS[tier];
  const cardClass = tier === 'focus' ? 'todo-focus-card' : tier === 'next' ? 'todo-next-card' : 'todo-pinned-card';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${cardClass}${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}`}
      onClick={() => onClick?.(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(task); } }}
    >
      <span className="todo-pinned-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        &#x2630;
      </span>
      <span className="todo-pinned-title" title={task.title}>{task.title}</span>
      <span className={`todo-pinned-phase${needsAttention ? ' todo-pinned-phase-attention' : ''}`} title={phaseLabel} />
      {actions.up && (
        <button
          className="todo-tier-btn"
          onClick={(e) => { e.stopPropagation(); onSetTier?.(task.id, actions.up!.tier); }}
          title={actions.up.label}
          aria-label={actions.up.label}
        >
          &#x2191;
        </button>
      )}
      {actions.down && (
        <button
          className="todo-tier-btn"
          onClick={(e) => { e.stopPropagation(); onSetTier?.(task.id, actions.down!.tier); }}
          title={actions.down.label}
          aria-label={actions.down.label}
        >
          &#x2193;
        </button>
      )}
      <button
        className="todo-pinned-unpin"
        onClick={(e) => { e.stopPropagation(); onUnpinTask?.(task.id); }}
        title="Unpin"
        aria-label="Unpin task"
      >
        &times;
      </button>
    </div>
  );
}

// ── TierDropZone — droppable target for any tier section ──

export function TierDropZone({ id, isEmpty, children }: { id: string; isEmpty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`todo-pinned-list todo-focus-drop-zone${isEmpty ? ' todo-focus-drop-zone-empty' : ''}${isOver ? ' todo-focus-drop-zone-over' : ''}`}
    >
      {children}
      {isEmpty && (
        <div className="todo-focus-placeholder">Drag tasks here</div>
      )}
    </div>
  );
}

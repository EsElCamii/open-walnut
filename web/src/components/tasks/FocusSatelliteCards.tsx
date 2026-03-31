/**
 * Focus + Satellite card components and drop zone, extracted from TodoPanel.
 * Used in the Focus/Satellite split of the pinned tasks section.
 */
import type { CSSProperties } from 'react';
import type { Task } from '@walnut/core';
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

// ── SortableFocusCard — draggable focus task card with accent border ──

interface SortableFocusCardProps {
  task: Task;
  isFocused: boolean;
  onClick?: (task: Task) => void;
  onDemoteTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
}

export function SortableFocusCard({ task, isFocused, onClick, onDemoteTask, onUnpinTask }: SortableFocusCardProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`todo-focus-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}`}
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
      <button
        className="todo-tier-btn"
        onClick={(e) => { e.stopPropagation(); onDemoteTask?.(task.id); }}
        title="Move to Satellite"
        aria-label="Demote to Satellite"
      >
        &#x2193;
      </button>
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

// ── SortableSatelliteCard — draggable satellite task card with promote button ──

interface SortableSatelliteCardProps {
  task: Task;
  isFocused: boolean;
  onClick?: (task: Task) => void;
  onPromoteTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  focusFull?: boolean;
}

export function SortableSatelliteCard({ task, isFocused, onClick, onPromoteTask, onUnpinTask, focusFull }: SortableSatelliteCardProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`todo-pinned-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}`}
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
      <button
        className={`todo-tier-btn${focusFull ? ' todo-tier-btn-disabled' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (!focusFull) onPromoteTask?.(task.id); }}
        title={focusFull ? 'Focus full (max 3)' : 'Move to Focus'}
        aria-label="Promote to Focus"
        disabled={focusFull}
      >
        &#x2191;
      </button>
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

// ── FocusDropZone — droppable target for the Focus section ──

export function FocusDropZone({ id, isEmpty, isFull, children }: { id: string; isEmpty: boolean; isFull: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`todo-pinned-list todo-focus-drop-zone${isEmpty ? ' todo-focus-drop-zone-empty' : ''}${isOver && !isFull ? ' todo-focus-drop-zone-over' : ''}${isOver && isFull ? ' todo-focus-drop-full' : ''}`}
    >
      {children}
      {isEmpty && (
        <div className="todo-focus-placeholder">Drag a task here to focus</div>
      )}
    </div>
  );
}

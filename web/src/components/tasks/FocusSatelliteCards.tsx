/**
 * Tier card components and drop zone for Focus / Next / Satellite.
 * Each tier gets a SortableTierCard with a kebab menu (same as regular task items).
 */
import type { CSSProperties } from 'react';
import type { Task } from '@walnut/core';
import type { FocusTier } from '@/api/focus';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { TaskKebabMenu } from './TaskKebabMenu';

// ── SortableTierCard — unified draggable card for any tier ──

interface SortableTierCardProps {
  task: Task;
  tier: FocusTier;
  isFocused: boolean;
  onClick?: (task: Task) => void;
  onSetTier?: (taskId: string, tier: FocusTier) => void;
  onUnpinTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onStar?: (id: string) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

export function SortableTierCard({ task, tier, isFocused, onClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, onStar, onExpandDetail, onClearFocus, onOpenSession }: SortableTierCardProps) {
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
      <span className={`todo-pinned-phase${needsAttention ? ' todo-pinned-phase-attention' : ''}`} />
      <TaskKebabMenu
        task={task}
        isFocused={isFocused}
        isPinned={true}
        pinnedTier={tier}
        isDone={task.status === 'done'}
        onExpandDetail={onExpandDetail}
        onClearFocus={onClearFocus}
        onSetPriority={onSetPriority}
        onSetDate={onSetDate}
        onStar={onStar}
        onPinTask={onPinTask}
        onUnpinTask={onUnpinTask}
        onSetTier={onSetTier}
        onOpenSession={onOpenSession}
      />
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

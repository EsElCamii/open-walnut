/**
 * Tier card components and drop zone for Focus / Next / Satellite.
 * Each tier gets a SortableTierCard with a kebab menu (same as regular task items).
 */
import { useState, useRef, useCallback, useEffect, memo, type CSSProperties, type ReactNode } from 'react';
import type { Task } from '@walnut/core';
import type { FocusTier } from '@/api/focus';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { TaskKebabMenu } from './TaskKebabMenu';
import { PersonIcon } from '../common/PersonIcon';
import * as ICONS from '../common/Icons';

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: ICONS.ICON_PHASE_TODO,
  IN_PROGRESS: ICONS.ICON_PHASE_IN_PROGRESS,
  AGENT_COMPLETE: ICONS.ICON_PHASE_AGENT_COMPLETE,
  AWAIT_HUMAN_ACTION: <PersonIcon />,
  HUMAN_VERIFIED: ICONS.ICON_PHASE_HUMAN_VERIFIED,
  POST_WORK_COMPLETED: ICONS.ICON_PHASE_POST_WORK,
  COMPLETE: ICONS.ICON_PHASE_COMPLETE,
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  HUMAN_VERIFIED: 'Human Verified',
  POST_WORK_COMPLETED: 'Post-Work Done',
  COMPLETE: 'Complete',
};

const PHASE_ORDER: string[] = [
  'TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION',
  'HUMAN_VERIFIED', 'POST_WORK_COMPLETED', 'COMPLETE',
];

// ── SortableTierCard — unified draggable card for any tier ──
// Wrapped in React.memo (invariant #4) to prevent re-render cascades during drag.
// Without memo, every RAF tick from bumpDragTick would re-render all cards in all tiers,
// compounding into the React #185 maximum update depth error.

interface SortableTierCardProps {
  task: Task;
  tier: FocusTier;
  isFocused: boolean;
  isSessionOpen?: boolean;
  isDetailOpen?: boolean;
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
  onSetPhase?: (id: string, phase: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onDelete?: (id: string) => void;
}

export const SortableTierCard = memo(function SortableTierCard({ task, tier, isFocused, isSessionOpen, isDetailOpen, onClick, onSetTier, onUnpinTask, onPinTask, onSetPriority, onSetDate, onStar, onExpandDetail, onClearFocus, onOpenSession, onSetPhase, onUpdateTitle, onDelete }: SortableTierCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  // Phase picker state — uses fixed positioning to escape overflow:hidden scroll containers
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false);
  const [phaseMenuPos, setPhaseMenuPos] = useState<{ top: number; left: number } | null>(null);
  const phaseWrapperRef = useRef<HTMLDivElement>(null);

  // Editable title state
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const isCommittingRef = useRef(false);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const titleClickedRef = useRef(false);

  // Close phase menu on outside click or scroll
  useEffect(() => {
    if (!phaseMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (phaseWrapperRef.current?.contains(e.target as Node)) return;
      setPhaseMenuOpen(false);
    };
    const handleScroll = () => setPhaseMenuOpen(false);
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [phaseMenuOpen]);

  // Sync title text when task.title changes externally while not editing
  useEffect(() => {
    if (!isEditing && titleRef.current && titleRef.current.textContent !== task.title) {
      titleRef.current.textContent = task.title;
    }
  }, [task.title, isEditing]);

  // Focus + cursor placement when entering edit mode
  useEffect(() => {
    if (isEditing && titleRef.current) {
      titleRef.current.focus();
      if (clickPosRef.current) {
        const { x, y } = clickPosRef.current;
        clickPosRef.current = null;
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        }
      }
      const range = document.createRange();
      range.selectNodeContents(titleRef.current);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const commitEdit = useCallback(() => {
    if (!isEditing || isCommittingRef.current) return;
    isCommittingRef.current = true;
    setIsEditing(false);
    const trimmed = (titleRef.current?.textContent ?? '').trim();
    if (trimmed && trimmed !== task.title && onUpdateTitle) {
      onUpdateTitle(task.id, trimmed);
    } else if (titleRef.current) {
      titleRef.current.textContent = task.title;
    }
    isCommittingRef.current = false;
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    if (!onUpdateTitle) return;
    // Don't stop propagation — let card onClick fire too (opens session)
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [onUpdateTitle]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  const cardClass = tier === 'focus' ? 'todo-focus-card' : 'todo-pinned-card';

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      className={`${cardClass}${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}${isSessionOpen ? ' todo-pinned-card-session-open' : ''}`}
      onClick={(e) => {
        if (isEditing) return;
        if ((e.target as HTMLElement).closest('.pinned-phase-picker')) return;
        onClick?.(task);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) { e.preventDefault(); onClick?.(task); } }}
    >
      <span className="todo-pinned-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        &#x2630;
      </span>
      {/* Phase icon with picker */}
      <div className="phase-picker-wrapper phase-picker-inline pinned-phase-picker" ref={phaseWrapperRef}>
        <button
          className={`task-phase-icon-btn task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!phaseMenuOpen && phaseWrapperRef.current) {
              const rect = phaseWrapperRef.current.getBoundingClientRect();
              const menuWidth = 300;
              const menuHeight = 170;
              let top = rect.bottom + 2;
              let left = rect.left;
              if (window.innerHeight - rect.bottom < menuHeight) top = rect.top - menuHeight - 2;
              if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 8;
              if (left < 8) left = 8;
              setPhaseMenuPos({ top, left });
            }
            setPhaseMenuOpen(!phaseMenuOpen);
          }}
          aria-label={PHASE_LABEL[task.phase] ?? 'Change phase'}
          title={PHASE_LABEL[task.phase] ?? 'Change phase'}
        >
          {PHASE_ICON[task.phase] ?? ICONS.ICON_PHASE_TODO}
        </button>
        {phaseMenuOpen && (
          <div
            className="phase-picker-menu"
            style={phaseMenuPos ? { position: 'fixed', top: phaseMenuPos.top, left: phaseMenuPos.left, zIndex: 9999 } : undefined}
          >
            {PHASE_ORDER.map((phase, i) => (
              <button
                key={phase}
                className={`phase-picker-item${task.phase === phase ? ' active' : ''}`}
                style={i === PHASE_ORDER.length - 1 && PHASE_ORDER.length % 2 === 1 ? { gridColumn: '1 / -1' } : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (task.phase !== phase) onSetPhase?.(task.id, phase);
                  setPhaseMenuOpen(false);
                }}
              >
                <span className={`phase-picker-icon task-phase-${phase.toLowerCase()}`}>
                  {PHASE_ICON[phase]}
                </span>
                <span>{PHASE_LABEL[phase]}</span>
                {task.phase === phase && <span className="phase-picker-check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Editable title */}
      <span
        ref={titleRef}
        className={`todo-pinned-title${isEditing ? ' editing' : ''}`}
        contentEditable={isEditing}
        suppressContentEditableWarning
        title={task.title}
        onClick={isEditing ? (e) => e.stopPropagation() : handleTitleClick}
        onBlur={isEditing ? commitEdit : undefined}
        onKeyDown={isEditing ? (e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        } : undefined}
      >
        {task.title}
      </span>
      <TaskKebabMenu
        task={task}
        isFocused={isFocused}
        isDetailOpen={isDetailOpen}
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
        onDelete={onDelete}
      />
    </div>
  );
});

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

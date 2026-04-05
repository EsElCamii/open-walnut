import { useState, useMemo, useCallback, useEffect, useRef, memo, Fragment, type FormEvent, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@walnut/core';
import type { SessionRecord } from '@walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask, updateTask as apiUpdateTask } from '@/api/tasks';
import { SprintPicker } from '@/components/tasks/SprintPicker';
import { fetchTriageHistory } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { timeAgo } from '@/utils/time';
import { scrollLog } from '@/utils/scroll-debug';
import type { ProcessStatus } from '@walnut/core';
import type { TaskPhase } from '@/types/session';
import { PHASE_LABELS, PHASE_COLORS, PROCESS_COLORS, PROCESS_LABELS, resolveTaskSessionId } from '@/utils/session-status';
import type { UseFavoritesReturn } from '@/hooks/useFavorites';
import type { UseOrderingReturn } from '@/hooks/useOrdering';
import * as ICONS from '../common/Icons';
import type { TaskPriority } from '@walnut/core';
import { TodoSearchBar } from './TodoSearchBar';
import { useTaskSearch } from '@/hooks/useTaskSearch';
import { usePhaseHooks } from '@/hooks/usePhaseHooks';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type CollisionDetection,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  defaultAnimateLayoutChanges,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskStatusDot } from './TaskStatusDot';
import { TaskKebabMenu } from './TaskKebabMenu';
import { ViewDropdown, type SortBy, type GroupBy } from './ViewDropdown';
import { PersonIcon } from '../common/PersonIcon';
import { useVerticalSplitter } from '@/hooks/useVerticalSplitter';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { ProjectDetailPane } from './ProjectDetailPane';
import { CategoryDetailPane } from './CategoryDetailPane';
import { GlobalNotesSection } from '../notes/GlobalNotesSection';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
import { SortableTierCard, TierDropZone } from './FocusSatelliteCards';
import type { FocusTier } from '@/api/focus';

type DetailTarget =
  | { type: 'project'; category: string; project: string }
  | { type: 'category'; category: string }
  | null;

interface TodoPanelProps {
  tasks: Task[];
  loading: boolean;
  onComplete: (id: string) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onCreate: (input: { title: string; priority: string; category?: string; project?: string }) => Promise<Task | unknown>;
  onUpdate?: (id: string, updates: { title?: string }) => void;
  onStar?: (id: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onFocusTask?: (task: Task, opts?: { openDetail?: boolean }) => void;
  onClearFocus?: () => void;
  focusedTaskId?: string;
  /** Increments on every focus action — forces re-scroll even for same task */
  focusNonce?: number;
  favorites?: UseFavoritesReturn;
  ordering?: UseOrderingReturn;
  onReorder?: (category: string, project: string, taskIds: string[]) => void;
  onMoveTask?: (taskId: string, category: string, project: string, insertNearTaskId?: string) => void;
  onReparentTask?: (taskId: string, newParentId: string | null) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  onReorderPinned?: (newIds: string[]) => void;
  onSetTier?: (taskId: string, tier: FocusTier) => void;
  pinnedTaskIds?: Set<string>;
  focusTaskIds?: Set<string>;
  nextTaskIds?: Set<string>;
  /** When true, suppress opening the detail panel for the focused task (e.g. chat task-ref clicks). */
  suppressDetail?: boolean;
  /** Set of session IDs currently displayed in session columns. */
  openSessionIds?: Set<string>;
  operationError?: string | null;
  onClearOperationError?: () => void;
  onOperationError?: (msg: string) => void;
  /** Externally-set category (e.g. from URL deep link). When it changes from undefined to a value, the tab switches. */
  externalCategory?: string;
  /** Fires whenever the active category tab changes (for URL sync). */
  onCategoryChange?: (cat: string) => void;
}

const STARRED_TAB = '\u2605';

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: ICONS.ICON_PHASE_TODO,
  IN_PROGRESS: ICONS.ICON_PHASE_IN_PROGRESS,
  AGENT_COMPLETE: ICONS.ICON_PHASE_AGENT_COMPLETE,
  AWAIT_HUMAN_ACTION: <PersonIcon />,
  HUMAN_VERIFIED: ICONS.ICON_PHASE_HUMAN_VERIFIED,
  POST_WORK_COMPLETED: ICONS.ICON_PHASE_POST_WORK,
  PEER_CODE_REVIEW: ICONS.ICON_PHASE_CODE_REVIEW,
  RELEASE_IN_PIPELINE: ICONS.ICON_PHASE_PIPELINE,
  COMPLETE: ICONS.ICON_PHASE_COMPLETE,
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

const PRIORITY_ICON: Record<string, string> = {
  immediate: '!!',
  important: '!',
  backlog: '~',
  none: '--',
};

const PRIORITY_LABEL: Record<string, string> = {
  immediate: 'Immediate',
  important: 'Important',
  backlog: 'Backlog',
  none: 'None',
};

const CHEVRON_ICON = '\u25B6'; // ▶ — used by all collapse-chevron buttons (CSS rotation handles expanded state)

// Action icons: imported from shared Icons.tsx via ICONS.*

/** Normalize legacy priority values to current 4-tier system. */
function effectivePriority(p: string): string {
  if (p === 'high') return 'immediate';
  if (p === 'medium') return 'important';
  if (p === 'low') return 'backlog';
  return p;
}

// ── Due date formatter ──

function formatDueDate(iso: string): { label: string; overdue: boolean } {
  const now = new Date();
  const due = new Date(iso);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.floor((dueDay.getTime() - todayStart.getTime()) / 86400000);
  if (diffDays < 0) return { label: 'Overdue', overdue: true };
  if (diffDays === 0) return { label: 'Today', overdue: false };
  if (diffDays === 1) return { label: 'Tomorrow', overdue: false };
  return { label: `${due.getMonth() + 1}/${due.getDate()}/${String(due.getFullYear()).slice(2)}`, overdue: false };
}

// ── LocalStorage persistence helpers ──

const LS_TAB_KEY = 'walnut-todo-active-tab';
const LS_COLLAPSED_CATS_KEY = 'walnut-todo-collapsed-cats';
const LS_COLLAPSED_PROJS_KEY = 'walnut-todo-collapsed-projs';
const LS_EXPANDED_PARENTS_KEY = 'walnut-todo-expanded-parents';
// LS_FILTERS_COLLAPSED_KEY removed — filters now inside ViewDropdown
const LS_SORT_KEY = 'walnut-todo-sortBy';
const LS_GROUP_KEY = 'walnut-todo-groupBy';

function readSetFromStorage(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

function persistSet(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

function readTab(): string {
  try { return localStorage.getItem(LS_TAB_KEY) ?? STARRED_TAB; } catch { return STARRED_TAB; }
}

function persistTab(tab: string) {
  try { localStorage.setItem(LS_TAB_KEY, tab); } catch { /* ignore */ }
}

// Disable layout animation for items that were just dragged to prevent
// the "flash" where both old and new position are briefly visible.
const noAnimateAfterDrag: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args;
  if (isSorting || wasDragging) return false;
  return defaultAnimateLayoutChanges(args);
};

// ── SortableTaskItem ──

interface SortableTaskItemProps {
  task: Task;
  isFocused: boolean;
  isRecentlyDone?: boolean;
  depth?: number;               // Nesting depth (0 = top-level, 1 = child, 2 = grandchild, etc.)
  childCount?: number;
  isExpanded?: boolean;           // Whether children are visible (only for parents)
  onToggleExpand?: () => void;    // Toggle children visibility
  onClick: () => void;
  onSetPhase: (id: string, phase: string) => void;
  onStar?: (id: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onUpdateTitle?: (id: string, title: string) => void;
  onOpenSession?: (sessionId: string) => void;
  openSessionIds?: Set<string>;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onPinTask?: (taskId: string) => void;
  onUnpinTask?: (taskId: string) => void;
  isPinned?: boolean;
  searchContext?: string; // Category/Project context pill shown in search mode
  searchMatchField?: string;  // Best keyword field ('title','note',etc.) or 'semantic'
  searchScore?: number;       // Combined normalized score [0,1]
  searchKeywordScore?: number;  // Normalized keyword contribution [0,1]
  searchSemanticScore?: number; // Normalized semantic contribution [0,1]
}

function SortableTaskItem({ task, isFocused, isRecentlyDone, depth = 0, childCount, isExpanded, onToggleExpand, onClick, onSetPhase, onStar, onSetPriority, onUpdateTitle, onOpenSession, openSessionIds, onExpandDetail, onClearFocus, onPinTask, onUnpinTask, isPinned, searchContext, searchMatchField, searchScore, searchKeywordScore, searchSemanticScore }: SortableTaskItemProps) {
  const hookPhases = usePhaseHooks();
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: 'task' }, animateLayoutChanges: noAnimateAfterDrag });

  // Combined ref for sortable
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    setSortableRef(node);
  }, [setSortableRef]);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
    // Subtasks indent: 22px = phase-icon(18px) + gap(4px), aligns with parent's first letter
    ...(depth > 0 ? { marginLeft: `${depth * 22}px` } : {}),
  };

  const isDone = task.phase === 'COMPLETE';

  // Phase picker dropdown state
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false);
  const phaseWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!phaseMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (phaseWrapperRef.current && !phaseWrapperRef.current.contains(e.target as Node)) {
        setPhaseMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [phaseMenuOpen]);

  const className = [
    'todo-panel-item',
    isDone ? 'todo-panel-item-done' : '',
    isRecentlyDone ? 'todo-panel-item-recently-done' : '',
    isFocused ? 'task-focused' : '',
  ].filter(Boolean).join(' ');

  const dueDateInfo = task.due_date ? formatDueDate(task.due_date) : null;

  // Inline title editing via contentEditable (preserves wrapping/layout)
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const isCommittingRef = useRef(false); // one-shot guard against double-fire (pointerdown + blur)

  // Sync DOM text when task.title changes externally (e.g. WS push) while not editing
  useEffect(() => {
    if (!isEditing && titleRef.current && titleRef.current.textContent !== task.title) {
      titleRef.current.textContent = task.title;
    }
  }, [task.title, isEditing]);

  useEffect(() => {
    if (isEditing && titleRef.current) {
      titleRef.current.focus();
      // Place cursor at click position (not select-all)
      if (clickPosRef.current) {
        const { x, y } = clickPosRef.current;
        clickPosRef.current = null;
        // Use caretRangeFromPoint (WebKit/Blink) or caretPositionFromPoint (Firefox)
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        } else if ((document as unknown as { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint) {
          const pos = (document as unknown as { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(x, y);
          if (pos) {
            const range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            return;
          }
        }
      }
      // Fallback: place cursor at end
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
      // Revert to original if title is empty or unchanged
      titleRef.current.textContent = task.title;
    }
    isCommittingRef.current = false;
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // First click on an unfocused task → focus it (open detail panel).
    // Only enter editing mode when task is already focused.
    if (!isFocused) {
      onClick();
      return;
    }
    if (!onUpdateTitle) return;
    clickPosRef.current = { x: e.clientX, y: e.clientY };
    setIsEditing(true);
  }, [isFocused, onClick, onUpdateTitle]);

  // Click-outside handler: exits editing when clicking outside the title span.
  // Also serves as a fallback when blur doesn't fire (e.g. click on non-focusable element).
  useEffect(() => {
    if (!isEditing) return;
    const handleOutsidePointerDown = (e: PointerEvent) => {
      if (titleRef.current && !titleRef.current.contains(e.target as Node)) {
        commitEdit();
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [isEditing, commitEdit]);

  // Disable DnD listeners & sortable attributes while editing to prevent
  // drag from hijacking text selection and focus inside the contentEditable
  const activeAttributes = isEditing ? {} : attributes;
  const activeListeners = isEditing ? {} : listeners;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      data-task-id={task.id}
      onClick={(e) => {
        if (isEditing) return;
        // Title has its own click handler (focus first, edit on second click)
        if ((e.target as HTMLElement).closest('.todo-item-title')) return;
        onClick();
      }}
      onKeyDown={(e) => { if (e.key === 'Enter' && !isEditing) onClick(); }}
      {...activeAttributes}
      {...activeListeners}
    >
      {/* ── Layout: [chevron if children] [content ...flex-1...] ── */}

      {/* — chevron: only shown when task has children (no spacer for leaf tasks) — */}
      {childCount > 0 && (
        <button
          className={`collapse-chevron${isExpanded ? ' expanded' : ''}`}
          title={isExpanded ? 'Collapse child tasks' : `Expand ${childCount} child task(s)`}
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
        >
          {CHEVRON_ICON}
        </button>
      )}

      {/* — content area: single-line [phase] [session] [title] [badges] [⋮] — */}
      <div className="todo-item-content">
        <div className="todo-item-title-row">
          {/* Phase icon — always first */}
          <div className="phase-picker-wrapper phase-picker-inline" ref={phaseWrapperRef}>
            <button
              className={`task-phase-icon-btn task-status-${task.status} task-phase-${task.phase?.toLowerCase()}`}
              onClick={(e) => {
                e.stopPropagation();
                setPhaseMenuOpen(!phaseMenuOpen);
              }}
              aria-label={PHASE_LABEL[task.phase] ?? 'Change phase'}
              title={PHASE_LABEL[task.phase] ?? 'Change phase'}
            >
              {PHASE_ICON[task.phase] ?? ICONS.ICON_PHASE_TODO}
            </button>
            {phaseMenuOpen && (
              <div className="phase-picker-menu">
                {PHASE_ORDER.map((phase) => (
                  <button
                    key={phase}
                    className={`phase-picker-item${task.phase === phase ? ' active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (task.phase !== phase) onSetPhase(task.id, phase);
                      setPhaseMenuOpen(false);
                    }}
                  >
                    <span className={`phase-picker-icon task-phase-${phase.toLowerCase()}`}>
                      {PHASE_ICON[phase]}
                    </span>
                    <span>{PHASE_LABEL[phase]}</span>
                    {hookPhases.has(phase) && (
                      <span className="phase-hook-indicator" title={hookPhases.get(phase)}>{ICONS.ICON_LIGHTNING}</span>
                    )}
                    {task.phase === phase && <span className="phase-picker-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Session status — between phase icon and title */}
          <TaskStatusDot task={task} onClick={onOpenSession ? () => {
            const sid = resolveTaskSessionId(task);
            if (sid) onOpenSession(sid);
          } : undefined} />
          <span
            ref={titleRef}
            className={`todo-item-title${isEditing ? ' editing' : ''}`}
            contentEditable={isEditing}
            suppressContentEditableWarning
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
          {/* Inline info badges (read-only, compact) */}
          {dueDateInfo && (
            <span className={`todo-item-due-pill${dueDateInfo.overdue ? ' todo-item-due-overdue' : ''}`}>
              {dueDateInfo.label}
            </span>
          )}
          {!!(task as Record<string, unknown>).is_blocked && !isDone && (
            <span className="task-blocked-badge" title="Blocked by dependencies">
              blocked
            </span>
          )}
          {!!childCount && (
            <span className="task-children-badge">{childCount} sub</span>
          )}
          {isDone && task.completed_at && (
            <span className="task-completed-time">{timeAgo(task.completed_at)}</span>
          )}
          {/* Kebab menu — all actions consolidated */}
          <TaskKebabMenu
            task={task}
            isFocused={isFocused}
            isPinned={!!isPinned}
            isDone={isDone}
            onExpandDetail={onExpandDetail}
            onClearFocus={onClearFocus}
            onSetPriority={onSetPriority}
            onStar={onStar}
            onPinTask={onPinTask}
            onUnpinTask={onUnpinTask}
          />
        </div>
        {/* Search result scores (only visible during search) */}
        {(searchScore != null || searchContext) && (
          <div className="todo-item-meta-row">
            {searchScore != null && (() => {
              const kwW = (searchKeywordScore ?? 0) * 0.4;
              const semW = (searchSemanticScore ?? 0) * 0.6;
              const kwDominant = kwW >= semW;
              return (
                <span className={`todo-search-score-pill todo-search-score-${kwDominant ? 'keyword' : 'semantic'}`}>
                  {searchScore.toFixed(2)}
                  <span className="todo-search-score-tooltip">
                    <span className={`todo-search-score-row${kwDominant ? ' is-dominant' : ''}`}>
                      <span className="todo-search-score-label keyword-label">Keyword</span>
                      {kwW > 0
                        ? <><span className="todo-search-score-val">{kwW.toFixed(2)}</span><span className="todo-search-score-field">{searchMatchField && searchMatchField !== 'semantic' ? searchMatchField : ''}</span></>
                        : <span className="todo-search-score-none">—</span>
                      }
                    </span>
                    <span className={`todo-search-score-row${!kwDominant ? ' is-dominant' : ''}`}>
                      <span className="todo-search-score-label semantic-label">Semantic</span>
                      {semW > 0
                        ? <span className="todo-search-score-val">{semW.toFixed(2)}</span>
                        : <span className="todo-search-score-none">—</span>
                      }
                    </span>
                  </span>
                </span>
              );
            })()}
            {searchContext && (
              <span className="todo-search-context-pill" title={searchContext}>
                {searchContext}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Static task item for DragOverlay ──

function TaskItemOverlay({ task }: { task: Task }) {
  return (
    <div className="todo-panel-item drag-overlay-item">
      <div className="todo-item-content">
        <span className="todo-item-title">{task.title}</span>
      </div>
      <span className={`badge badge-${task.priority}`}>{task.priority === 'immediate' ? '!!' : task.priority === 'important' ? '!' : task.priority === 'backlog' ? '~' : '--'}</span>
    </div>
  );
}

// ── SortableGroupItem (for category/project group drag) ──
// Dragged item: collapsed (height 0). Other items: shift via transform to show a gap.

interface SortableGroupItemProps {
  id: string;
  children: (props: { dragHandleProps: Record<string, unknown> }) => React.ReactNode;
}

function SortableGroupItem({ id, children }: SortableGroupItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { type: id.startsWith('cat:') ? 'category-group' : 'project-group' } });

  const style: CSSProperties = isDragging
    ? { opacity: 0, pointerEvents: 'none' }
    : { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style}>
      {children({ dragHandleProps: { ...attributes, ...listeners } })}
    </div>
  );
}

// ── DroppableHeader (drop zone for cross-group task moves) ──

interface DroppableHeaderProps {
  id: string;
  category: string;
  project: string;
  disabled: boolean;
  children: (props: { isOver: boolean; setNodeRef: (node: HTMLElement | null) => void }) => React.ReactNode;
}

function DroppableHeader({ id, category, project, disabled, children }: DroppableHeaderProps) {
  const { isOver, setNodeRef } = useDroppable({
    id,
    data: { type: 'header-drop', category, project },
    disabled,
  });
  return <>{children({ isOver, setNodeRef })}</>;
}

// ── Order-aware sort comparator ──

function orderedSort(items: string[], orderList: string[]): string[] {
  const indexMap = new Map(orderList.map((name, i) => [name, i]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a);
    const bi = indexMap.get(b);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
  });
}

// ── Sort comparators ──

// SortBy and GroupBy types imported from ViewDropdown

const PRIORITY_RANK: Record<string, number> = { immediate: 0, important: 1, backlog: 2, none: 3 };

function readSortBy(): SortBy {
  try {
    const v = localStorage.getItem(LS_SORT_KEY);
    if (v === 'priority' || v === 'date' || v === 'updated') return v;
  } catch { /* ignore */ }
  return 'priority';
}

function persistSortBy(v: SortBy) {
  try { localStorage.setItem(LS_SORT_KEY, v); } catch { /* ignore */ }
}

function readGroupBy(): GroupBy {
  try {
    const v = localStorage.getItem(LS_GROUP_KEY);
    if (v === 'category' || v === 'none') return v;
  } catch { /* ignore */ }
  return 'category';
}

function persistGroupBy(v: GroupBy) {
  try { localStorage.setItem(LS_GROUP_KEY, v); } catch { /* ignore */ }
}

/** Sort tasks by priority (Immediate → Important → Backlog → None), then by created_at descending within same priority */
function comparePriority(a: Task, b: Task): number {
  const pa = PRIORITY_RANK[effectivePriority(a.priority)] ?? 3;
  const pb = PRIORITY_RANK[effectivePriority(b.priority)] ?? 3;
  if (pa !== pb) return pa - pb;
  // Same priority: newest first
  return compareDate(a, b);
}

/** Sort tasks by created_at descending (newest first) */
function compareDate(a: Task, b: Task): number {
  const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
  const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
  return tb - ta; // newest first
}

/** Sort tasks by updated_at descending (most recently modified first) */
function compareUpdated(a: Task, b: Task): number {
  const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
  const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
  return tb - ta; // most recently updated first
}

// ── Type-aware collision detection ──
// Only considers droppable items of the same type as the active drag item.
// This prevents category drags from colliding with tasks or project headers.

const typeAwareCollision: CollisionDetection = (args) => {
  const activeType = (args.active.data?.current as { type?: string })?.type ?? 'task';
  const activeId = String(args.active.id);

  const filtered = args.droppableContainers.filter((container) => {
    const cType = (container.data?.current as { type?: string })?.type ?? 'task';

    // Tasks can collide with all tasks (cross-group) and header drop zones
    if (activeType === 'task') {
      return cType === 'task' || cType === 'header-drop';
    }

    // Category/project group drags: same-type only
    if (cType !== activeType) return false;

    // For project groups, only match projects in the same parent category
    if (activeType === 'project-group' && activeId.startsWith('proj:') && String(container.id).startsWith('proj:')) {
      const activeCat = activeId.slice(5).split('/')[0];
      const containerCat = String(container.id).slice(5).split('/')[0];
      return activeCat === containerCat;
    }

    return true;
  });

  if (filtered.length === 0) return [];
  return closestCenter({ ...args, droppableContainers: filtered });
};

// ── Modifier: snap overlay to cursor for group drags ──
// The drag handle is small but the sortable element is the full-width header,
// so the default overlay position can be far from the cursor. This modifier
// adjusts the overlay so its top-left is near the initial click point.

const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const event = activatorEvent as PointerEvent;
  if (!event.clientX) return transform;
  const offsetX = event.clientX - draggingNodeRect.left - 16;
  const offsetY = event.clientY - draggingNodeRect.top - 12;
  return { ...transform, x: transform.x + offsetX, y: transform.y + offsetY };
};

// Session info colors — imported from single source of truth.
// Re-exported as local aliases for backwards compat with type signature.
const processDotColors = PROCESS_COLORS as Record<ProcessStatus, string>;
const phaseColors = PHASE_COLORS as Record<TaskPhase, string>;


function truncateCwd(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments.slice(-2).join('/') : p;
}

/**
 * Reverse conversation log entries so newest appear first.
 * Splits on `### YYYY-MM-DD HH:MM` headings (one per entry), reverses, and rejoins.
 * Storage stays append-only — reversal is render-time only.
 */
function reverseConversationLogEntries(log: string): string {
  const entries = log.split(/(?=^### \d{4}-\d{2}-\d{2} \d{2}:\d{2})/m).filter(Boolean);
  if (entries.length <= 1) return log;
  return entries.reverse().join('\n\n');
}

// ── TaskDetailPane ──

function TaskDetailPane({ task, allTasks, onClose, onOpenSession, onOpenTriageForTask, onFocusChild, style }: { task: Task; allTasks?: Task[]; onClose?: () => void; onOpenSession?: (sessionId: string) => void; onOpenTriageForTask?: (taskId: string) => void; onFocusChild?: (task: Task) => void; style?: CSSProperties }) {
  const navigate = useNavigate();
  const integrations = useIntegrations();
  const hasDescription = !!task.description;
  const hasSummary = !!task.summary;
  // Support slim mode: has_note/has_conversation_log are set when content was stripped
  const hasNote = !!task.note || !!(task as Record<string, unknown>).has_note;
  const hasConversationLog = !!task.conversation_log || !!(task as Record<string, unknown>).has_conversation_log;

  // Lazy-load full task when note/conversation_log content is needed but stripped (slim mode)
  const [fullTask, setFullTask] = useState<Task | null>(null);
  useEffect(() => { setFullTask(null); }, [task.id]); // Reset on task change
  const needsFullLoad = (hasNote && !task.note) || (hasConversationLog && !task.conversation_log);
  useEffect(() => {
    if (!needsFullLoad || fullTask) return;
    let cancelled = false;
    fetchTask(task.id).then((t) => { if (!cancelled) setFullTask(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsFullLoad, fullTask, task.id]);
  // Use full task data when available for note/conversation_log rendering
  const noteContent = task.note ?? fullTask?.note;
  const conversationLogContent = task.conversation_log ?? fullTask?.conversation_log;
  const hasSubtasks = task.subtasks && task.subtasks.length > 0;
  const dueDateInfo = task.due_date ? formatDueDate(task.due_date) : null;

  const handleSprintChange = async (sprintName: string | null) => {
    await apiUpdateTask(task.id, { sprint: sprintName ?? '' });
  };

  // Child tasks — tasks whose parent_task_id matches this task (handles prefix parent IDs)
  const childTasks = useMemo(() => {
    if (!allTasks) return [];
    return allTasks.filter((t) => t.parent_task_id && task.id.startsWith(t.parent_task_id));
  }, [allTasks, task.id]);

  // Parent task — resolve parent_task_id (may be a prefix) to the actual parent
  const parentTask = useMemo(() => {
    if (!allTasks || !task.parent_task_id) return null;
    return allTasks.find((t) => t.id.startsWith(task.parent_task_id!)) ?? null;
  }, [allTasks, task.parent_task_id]);

  // Build a comprehensive set of all session IDs from both session_ids array and slot fields.
  // This prevents the Sessions section from disappearing when session_ids is stale but slots are set.
  const allSessionIds = useMemo(() => {
    const ids = new Set<string>(task.session_ids ?? []);
    if (task.session_id) ids.add(task.session_id);
    if (task.plan_session_id) ids.add(task.plan_session_id);
    if (task.exec_session_id) ids.add(task.exec_session_id);
    return Array.from(ids);
  }, [task.session_ids, task.session_id, task.plan_session_id, task.exec_session_id]);

  // Fetch session records for title resolution (API filters out embedded agent runs)
  const [sessionRecords, setSessionRecords] = useState<Map<string, SessionRecord>>(new Map());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Separate archived from visible sessions once records are loaded.
  // Before records load, we can't know which are archived — show all as placeholder.
  const { visibleSessionIds, archivedCount } = useMemo(() => {
    if (sessionRecords.size === 0) return { visibleSessionIds: allSessionIds, archivedCount: 0 };
    const visible: string[] = [];
    let archived = 0;
    for (const sid of allSessionIds) {
      const rec = sessionRecords.get(sid);
      if (rec?.archived) { archived++; continue; }
      // Keep IDs that either have a non-archived record or haven't been fetched yet
      if (rec || !sessionRecords.size) visible.push(sid);
    }
    // Also include API-returned non-archived sessions not in allSessionIds (e.g. embedded)
    for (const [sid, rec] of sessionRecords) {
      if (rec.archived) continue;
      if (!allSessionIds.includes(sid)) visible.push(sid);
    }
    return { visibleSessionIds: visible, archivedCount: archived };
  }, [allSessionIds, sessionRecords]);

  // Show sessions section based on task data (allSessionIds) — not on the async API result.
  // This prevents the section from disappearing/flickering when the fetch is in progress or fails.
  // After fetch completes, refine to only show if API returned actual records (filters embedded runs).
  const hasSessions = sessionsLoading ? allSessionIds.length > 0 : (visibleSessionIds.length > 0 || allSessionIds.length > 0);
  useEffect(() => {
    if (!allSessionIds.length) { setSessionRecords(new Map()); setSessionsLoading(false); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setSessionsLoading(true);

    const applyResults = (sessions: SessionRecord[]) => {
      if (cancelled) return;
      const map = new Map<string, SessionRecord>();
      for (const s of sessions) map.set(s.claudeSessionId, s);
      setSessionRecords(map);
      setSessionsLoading(false);
    };

    fetchSessionsForTask(task.id).then(applyResults).catch(() => {
      // Retry once after 1s — transient errors shouldn't hide sessions
      if (cancelled) return;
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        fetchSessionsForTask(task.id).then(applyResults).catch(() => {
          if (!cancelled) setSessionsLoading(false);
        });
      }, 1000);
    });
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [task.id, allSessionIds.join(',')]);

  // Live-update session records when status/mode changes via WebSocket
  useEvent('session:status-changed', (data) => {
    const { sessionId, taskId, mode, process_status, planCompleted } = data as {
      sessionId?: string; taskId?: string; mode?: string;
      process_status?: string; planCompleted?: boolean;
    };
    if (taskId !== task.id || !sessionId) return;
    setSessionRecords((prev) => {
      const record = prev.get(sessionId);
      if (!record) return prev;
      const updated = new Map(prev);
      const patched = { ...record };
      if (mode !== undefined) patched.mode = mode as SessionRecord['mode'];
      if (process_status !== undefined) patched.process_status = process_status as SessionRecord['process_status'];
      if (planCompleted !== undefined) patched.planCompleted = planCompleted;
      updated.set(sessionId, patched);
      return updated;
    });
  });

  // Fetch triage count for this task
  const [triageTotal, setTriageTotal] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchTriageHistory(1, task.id).then((resp) => {
      if (cancelled) return;
      setTriageTotal(resp.total);
    }).catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [task.id]);

  return (
    <div className="todo-detail-pane" style={style}>
      <div className="todo-detail-header">
        <span className="todo-detail-category">
          {task.category}{task.project && task.project !== task.category ? ` / ${task.project}` : ''}
        </span>
        {dueDateInfo && (
          <span className={`todo-item-due-pill${dueDateInfo.overdue ? ' todo-item-due-overdue' : ''}`}>
            {dueDateInfo.label}
          </span>
        )}
        {task.external_url && (
          <a
            className="todo-detail-external-link"
            href={task.external_url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open in ${getIntegrationMeta(integrations, task.source)?.externalLinkLabel ?? getIntegrationMeta(integrations, task.source)?.name ?? 'external'}`}
          >
            {getIntegrationMeta(integrations, task.source)?.name ?? 'Link'} &#x2197;
          </a>
        )}
        {onClose && (
          <button className="todo-detail-close" onClick={onClose} aria-label="Close detail panel" title="Close">&times;</button>
        )}
      </div>

      {/* Task metadata — always visible */}
      <div className="todo-detail-meta">
        <div className="todo-detail-title">{task.title}</div>
        <div className="todo-detail-badges">
          <span className={`badge-phase badge-phase-${task.phase?.toLowerCase()}`}>
            {PHASE_ICON[task.phase] ?? '○'} {PHASE_LABEL[task.phase] ?? task.phase}
          </span>
          {task.priority && task.priority !== 'none' && (
            <span className={`todo-detail-priority-pill priority-${task.priority}`}>
              {PRIORITY_ICON[task.priority]} {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          <SprintPicker sprint={task.sprint} onSprintChange={handleSprintChange} />
        </div>
        <div className="todo-detail-dates text-xs text-muted">
          {task.created_at && <span>Created {timeAgo(task.created_at)}</span>}
          {task.updated_at && <span> · Updated {timeAgo(task.updated_at)}</span>}
        </div>
      </div>

      {parentTask && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Parent Task</div>
          <div
            className="todo-detail-child-item"
            role="button"
            tabIndex={0}
            onClick={() => onFocusChild ? onFocusChild(parentTask) : navigate(`/tasks/${parentTask.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusChild ? onFocusChild(parentTask) : navigate(`/tasks/${parentTask.id}`); } }}
          >
            <span
              className="todo-detail-child-dot"
              style={{
                background: parentTask.status === 'done' ? '#34c759'
                  : parentTask.phase === 'IN_PROGRESS' ? '#007aff'
                  : parentTask.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                  : parentTask.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                  : 'var(--fg-muted)',
              }}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {parentTask.title}
            </span>
            <span className="text-xs text-muted">{PHASE_LABEL[parentTask.phase] ?? parentTask.phase}</span>
          </div>
        </div>
      )}

      {hasSessions && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Sessions ({sessionsLoading && !sessionRecords.size ? allSessionIds.length : visibleSessionIds.length})</div>
          <div className="todo-detail-sessions">
            {sessionsLoading && sessionRecords.size === 0 ? (
              // While loading, show a placeholder using task-level session status (available immediately)
              allSessionIds.map((sid) => {
                const taskStatus = task.session_status;
                const processStatus = taskStatus?.process_status || 'stopped';
                const taskPhase = (task.phase || 'TODO') as TaskPhase;
                const isPlan = taskStatus?.mode === 'plan' || !!taskStatus?.planCompleted;
                const statusLabel = PHASE_LABELS[taskPhase] ?? taskPhase;
                return (
                  <div
                    key={sid}
                    className="todo-detail-session-item"
                    title={sid}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); } }}
                  >
                    <div className="todo-detail-session-row1">
                      <span className="todo-detail-session-dot" style={{ background: processDotColors[processStatus] ?? 'var(--fg-muted)' }} />
                      {isPlan && <span className="todo-detail-plan-badge">Plan</span>}
                      <span className="todo-detail-session-title text-muted">Loading…</span>
                      <span className="session-id-mono text-xs" title={`Session ID: ${sid}`}>{sid.slice(0, 8)} &#x2197;</span>
                    </div>
                    <div className="todo-detail-session-meta">
                      <span className="todo-detail-ws-pill" style={{ color: phaseColors[taskPhase] ?? 'var(--fg-muted)', borderColor: phaseColors[taskPhase] ?? 'var(--fg-muted)' }}>
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              visibleSessionIds.filter((sid) => sessionRecords.has(sid)).map((sid) => {
                const record = sessionRecords.get(sid);
                const processStatus = record?.process_status || 'stopped';
                const sessionPhase = (task.phase || 'TODO') as TaskPhase;
                const label = record?.title || 'Untitled session';
                const ago = timeAgo(record?.lastActiveAt || record?.startedAt || '');
                const isPlan = record?.mode === 'plan' || !!record?.planCompleted;
                const modeLabel = record?.mode && record.mode !== 'default' && record.mode !== 'plan' && !record?.planCompleted ? record.mode : null;
                const statusLabel = (PHASE_LABELS[sessionPhase] ?? sessionPhase) + (modeLabel ? ` · ${modeLabel}` : '');
                return (
                  <div
                    key={sid}
                    className="todo-detail-session-item"
                    title={sid}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (onOpenSession) {
                        onOpenSession(sid);
                      } else {
                        navigate(`/sessions?id=${sid}`);
                      }
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); } }}
                  >
                    {/* Row 1: process dot + title + time + open-tab */}
                    <div className="todo-detail-session-row1">
                      <span
                        className="todo-detail-session-dot"
                        style={{ background: processDotColors[processStatus] ?? 'var(--fg-muted)' }}
                      />
                      {isPlan && (
                        <span className="todo-detail-plan-badge">Plan</span>
                      )}
                      <span className="todo-detail-session-title">{label}</span>
                      {ago && <span className="todo-detail-session-time">{ago}</span>}
                      <span
                        className="session-id-mono text-xs"
                        role="button"
                        title={`Session ID: ${sid}\nClick to open in Sessions page`}
                        onClick={(e) => { e.stopPropagation(); onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`); }}
                      >
                        {sid.slice(0, 8)} &#x2197;
                      </span>
                    </div>
                    {/* Row 2: phase pill + activity */}
                    <div className="todo-detail-session-meta">
                      <span
                        className="todo-detail-ws-pill"
                        style={{
                          color: phaseColors[sessionPhase] ?? 'var(--fg-muted)',
                          borderColor: phaseColors[sessionPhase] ?? 'var(--fg-muted)',
                        }}
                      >
                        {statusLabel}
                      </span>
                      {record?.activity && processStatus === 'running' && (
                        <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
                          — {record.activity}
                        </span>
                      )}
                    </div>
                    {/* Row 3: cwd (conditional) */}
                    {record?.cwd && (
                      <div className="todo-detail-session-cwd">
                        &#x1F4C1; {truncateCwd(record.cwd)}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {childTasks.length > 0 && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Child Tasks ({childTasks.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {childTasks.map((child) => (
              <div
                key={child.id}
                className="todo-detail-child-item"
                role="button"
                tabIndex={0}
                onClick={() => onFocusChild ? onFocusChild(child) : navigate(`/tasks/${child.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocusChild ? onFocusChild(child) : navigate(`/tasks/${child.id}`); } }}
              >
                <span
                  className="todo-detail-child-dot"
                  style={{
                    background: child.status === 'done' ? '#34c759'
                      : child.phase === 'IN_PROGRESS' ? '#007aff'
                      : child.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                      : child.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                      : 'var(--fg-muted)',
                    opacity: child.status === 'done' ? 0.5 : 1,
                  }}
                />
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textDecoration: child.status === 'done' ? 'line-through' : 'none',
                  opacity: child.status === 'done' ? 0.5 : 1,
                }}>
                  {child.title}
                </span>
                <span className="text-xs text-muted">{PHASE_LABEL[child.phase] ?? child.phase}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasSummary && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Summary <span className="text-xs text-muted">(AI)</span></div>
          <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(task.summary) }} />
        </div>
      )}

      {hasConversationLog && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Conversation Log</div>
          {conversationLogContent
            ? <div className="todo-detail-note markdown-body conversation-log" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(reverseConversationLogEntries(conversationLogContent)) }} />
            : <div className="text-sm text-muted">Loading...</div>
          }
        </div>
      )}

      {triageTotal > 0 && onOpenTriageForTask && (
        <div className="todo-detail-section">
          <button
            className="todo-detail-triage-btn"
            onClick={() => onOpenTriageForTask(task.id)}
          >
            View Triage History ({triageTotal}) &#x2192;
          </button>
        </div>
      )}

      {hasDescription && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Description</div>
          <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(task.description) }} />
        </div>
      )}

      {hasSubtasks && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Subtasks ({task.subtasks!.filter(s => s.done).length}/{task.subtasks!.length})</div>
          <ul className="todo-detail-subtasks">
            {task.subtasks!.map((st) => (
              <li key={st.id} className={st.done ? 'done' : ''}>
                <span className="todo-detail-subtask-check">{st.done ? '\u2713' : '\u25CB'}</span>
                {st.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasNote && (
        <div className="todo-detail-section">
          <div className="todo-detail-section-label">Note</div>
          {noteContent
            ? <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(noteContent) }} />
            : <div className="text-sm text-muted">Loading...</div>
          }
        </div>
      )}

      {!hasDescription && !hasSummary && !hasNote && !hasConversationLog && !hasSubtasks && !hasSessions && triageTotal === 0 && (
        <div className="todo-detail-empty text-sm text-muted">No details</div>
      )}
    </div>
  );
}

const RECENT_VISIBLE_MAX = 3;
const PINNED_VISIBLE_MAX = 7;

// ── RecentCard — recent-activity task card (no drag, has pin button) ──

interface RecentCardProps {
  task: Task;
  isFocused: boolean;
  onClick?: (task: Task) => void;
  onPinTask?: (taskId: string) => void;
}

function RecentCard({ task, isFocused, onClick, onPinTask }: RecentCardProps) {
  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  const phaseLabel = PHASE_LABEL[task.phase] ?? task.phase;
  const ago = timeAgo(task.last_session_update ?? task.created_at);

  return (
    <div
      className={`todo-pinned-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAttention ? ' todo-pinned-card-attention' : ''}`}
      onClick={() => onClick?.(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(task); } }}
    >
      <span className="todo-pinned-title" title={task.title}>{task.title}</span>
      <span className={`todo-pinned-phase${needsAttention ? ' todo-pinned-phase-attention' : ''}`} title={phaseLabel} />
      {ago && <span className="todo-recent-ago" title={task.last_session_update}>{ago}</span>}
      <button
        className="todo-recent-pin"
        onClick={(e) => { e.stopPropagation(); onPinTask?.(task.id); }}
        title="Pin"
        aria-label="Pin task"
      >
        {'\uD83D\uDCCC'}
      </button>
    </div>
  );
}

// ── SortableRecentCard — draggable wrapper around RecentCard for cross-section DnD ──

function SortableRecentCard({ task, isFocused, onClick, onPinTask }: RecentCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { source: 'recent' } });

  const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
  const phaseLabel = PHASE_LABEL[task.phase] ?? task.phase;
  const ago = timeAgo(task.last_session_update ?? task.created_at);

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : undefined,
  };

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
      <span className="todo-pinned-drag-handle" {...attributes} {...listeners}>{'\u2261'}</span>
      <span className="todo-pinned-title" title={task.title}>{task.title}</span>
      <span className={`todo-pinned-phase${needsAttention ? ' todo-pinned-phase-attention' : ''}`} title={phaseLabel} />
      {ago && <span className="todo-recent-ago" title={task.last_session_update}>{ago}</span>}
      <button
        className="todo-recent-pin"
        onClick={(e) => { e.stopPropagation(); onPinTask?.(task.id); }}
        title="Pin"
        aria-label="Pin task"
      >
        {'\uD83D\uDCCC'}
      </button>
    </div>
  );
}

// ── TodoPanel ──

export const TodoPanel = memo(function TodoPanel({ tasks: rawTasks, loading, onComplete, onSetPhase, onCreate, onUpdate, onStar, onSetPriority, onFocusTask, onClearFocus, focusedTaskId, focusNonce, favorites, ordering, onReorder, onMoveTask, onReparentTask, onOpenSession, onOpenTriageForTask, onPinTask, onUnpinTask, onReorderPinned, onSetTier, pinnedTaskIds, focusTaskIds, nextTaskIds, suppressDetail, openSessionIds, operationError, onClearOperationError, onOperationError, externalCategory, onCategoryChange }: TodoPanelProps) {
  // Hide .metadata* tasks (project/category configuration tasks, not user-visible)
  const tasks = useMemo(() => rawTasks.filter((t) => !t.title.startsWith('.metadata')), [rawTasks]);
  const navigate = useNavigate();
  const [showCompleted, setShowCompleted] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>(readSortBy);
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const [activeCategory, setActiveCategory] = useState(readTab);

  // Apply externally-set category (e.g. from URL deep link)
  const prevExternalCatRef = useRef(externalCategory);
  useEffect(() => {
    if (externalCategory !== undefined && externalCategory !== prevExternalCatRef.current) {
      setActiveCategory(externalCategory);
      persistTab(externalCategory);
    }
    prevExternalCatRef.current = externalCategory;
  }, [externalCategory]);

  const integrations = useIntegrations();
  const [newTitle, setNewTitle] = useState('');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const [nextCollapsed, setNextCollapsed] = useState(false);
  const [satelliteCollapsed, setSatelliteCollapsed] = useState(false);
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_CATS_KEY));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => readSetFromStorage(LS_COLLAPSED_PROJS_KEY));
  // Tracks which parent tasks the user has EXPANDED (default = all collapsed)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => readSetFromStorage(LS_EXPANDED_PARENTS_KEY));
  // Auto-expand parents with active (non-completed) children on initial load.
  // Handles edge case: fork created while page was closed (task:created WS never received).
  const didAutoExpandRef = useRef(false);
  useEffect(() => {
    if (loading || tasks.length === 0 || didAutoExpandRef.current) return;
    didAutoExpandRef.current = true;
    const parentsToExpand: string[] = [];
    for (const t of tasks) {
      if (!t.parent_task_id || t.status === 'done') continue;
      const parent = tasks.find((p) => p.id.startsWith(t.parent_task_id!));
      if (parent && !expandedParents.has(parent.id)) {
        parentsToExpand.push(parent.id);
      }
    }
    if (parentsToExpand.length === 0) return;
    setExpandedParents((prev) => {
      const next = new Set(prev);
      for (const id of parentsToExpand) next.add(id);
      persistSet(LS_EXPANDED_PARENTS_KEY, next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after initial load
  }, [loading, tasks]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);

  // Search state
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, isSearching, clearSearch } = useTaskSearch();

  // Global notes
  const globalNotes = useGlobalNotes();

  // Vertical splitter for list/detail ratio
  const { ratio: detailRatio, containerRef: splitterContainerRef, handleMouseDown: splitterMouseDown, isResizing: splitterResizing } = useVerticalSplitter();

  // Determine if search mode is active (query entered)
  const isSearchMode = searchQuery.trim().length > 0;

  // Track previous focusedTaskId to detect new focus (not re-renders)
  const prevFocusedRef = useRef<string | undefined>(undefined);
  // Track whether the focused task was already handled (prevents re-running on unrelated tasks changes)
  const focusHandledRef = useRef(false);
  // Track previous focusNonce to detect re-focus on same task
  const prevNonceRef = useRef(focusNonce ?? 0);
  // RAF handle for cancellation on unmount / new focus
  const scrollRafRef = useRef<number>(0);

  // Scroll to a task by ID inside .todo-panel-list.
  // Uses double-RAF + retry to wait for React commit + browser paint + layout settle
  // after state changes (expand/filter-clear, detail panel open).
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const scrollToTask = useCallback((taskId: string) => {
    cancelAnimationFrame(scrollRafRef.current);
    clearTimeout(scrollTimerRef.current);
    scrollLog('focus-scroll-start', { taskId: taskId.substring(0, 12) });

    const doScroll = () => {
      const listContainer = document.querySelector('.todo-panel-list');
      if (!listContainer) {
        scrollLog('focus-scroll-MISS', { reason: 'no-list-container' });
        return;
      }
      const el = listContainer.querySelector(`[data-task-id="${window.CSS.escape(taskId)}"]`);
      if (!el) {
        scrollLog('focus-scroll-MISS', { reason: 'element-not-found', taskId: taskId.substring(0, 12) });
        return;
      }
      const elRect = el.getBoundingClientRect();
      const containerRect = listContainer.getBoundingClientRect();
      const outOfView = elRect.top < containerRect.top || elRect.bottom > containerRect.bottom;
      if (outOfView) {
        const elTopInContainer = elRect.top - containerRect.top + listContainer.scrollTop;
        listContainer.scrollTop = elTopInContainer - containerRect.height / 3;
        scrollLog('focus-scroll-done', { taskId: taskId.substring(0, 12), scrollTo: Math.round(listContainer.scrollTop) });
      } else {
        scrollLog('focus-scroll-skip', { reason: 'already-visible', taskId: taskId.substring(0, 12) });
      }
    };

    // Phase 1: double-RAF (React commit + paint) — handles expand/filter DOM changes
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = requestAnimationFrame(() => {
        doScroll();
        // Phase 2: re-scroll after 150ms to handle layout shifts from the detail
        // panel opening (flex ratio change on .todo-panel-list). No CSS transition
        // is involved — the flex change is instant — but React may batch the
        // focusedTask state update (which controls the flex style) separately from
        // the focusedTaskId update that triggers this effect. 150ms is generous
        // enough to cover any batched re-renders on slow machines.
        scrollTimerRef.current = setTimeout(() => {
          scrollLog('focus-scroll-phase2', { taskId: taskId.substring(0, 12) });
          doScroll();
        }, 150);
      });
    });
  }, []);

  // Cleanup RAF + timer on unmount
  useEffect(() => {
    return () => { cancelAnimationFrame(scrollRafRef.current); clearTimeout(scrollTimerRef.current); };
  }, []);

  // Auto-switch tab, expand groups, and scroll to task when focusedTaskId changes
  useEffect(() => {
    if (!focusedTaskId) {
      prevFocusedRef.current = focusedTaskId;
      focusHandledRef.current = false;
      return;
    }
    const isNewFocus = focusedTaskId !== prevFocusedRef.current;
    const nonceChanged = (focusNonce ?? 0) !== prevNonceRef.current;
    prevNonceRef.current = focusNonce ?? 0;
    if (!isNewFocus && !nonceChanged && focusHandledRef.current) return; // already handled
    prevFocusedRef.current = focusedTaskId;

    const task = tasks.find((t) => t.id === focusedTaskId);
    if (!task) {
      scrollLog('focus-effect-SKIP', { taskId: focusedTaskId.substring(0, 12), reason: 'task-not-in-list' });
      return; // task not yet in list (e.g. waiting for WebSocket) — will retry when tasks update
    }
    focusHandledRef.current = true;
    scrollLog('focus-effect-run', { taskId: focusedTaskId.substring(0, 12), isNewFocus, cat: task.category, proj: task.project, activeTab: activeCategory });

    // Switch to the correct category tab (unless already showing All or Starred with this task visible)
    const cat = task.category || 'Uncategorized';
    if (activeCategory !== '' && activeCategory !== cat && activeCategory !== STARRED_TAB) {
      setActiveCategory(cat);
      persistTab(cat);
      onCategoryChange?.(cat);
    } else if (activeCategory === STARRED_TAB) {
      // If task isn't visible under starred tab, switch to its category
      const isStarred = !!task.starred;
      const isCatFav = favorites?.isCategoryFavorite(cat) ?? false;
      const isProjFav = favorites?.isProjectFavorite(task.project) ?? false;
      if (!isStarred && !isCatFav && !isProjFav && !isDescendantVisibleInStarred(task)) {
        setActiveCategory(cat);
        persistTab(cat);
        onCategoryChange?.(cat);
      }
    }

    // Expand collapsed category
    if (collapsedCategories.has(cat)) {
      setCollapsedCategories((prev) => {
        const next = new Set(prev);
        next.delete(cat);
        persistSet(LS_COLLAPSED_CATS_KEY, next);
        return next;
      });
    }

    // Expand collapsed project
    const hasDistinctProject = task.project && task.project !== task.category;
    if (hasDistinctProject) {
      const projKey = `${cat}/${task.project}`;
      if (collapsedProjects.has(projKey)) {
        setCollapsedProjects((prev) => {
          const next = new Set(prev);
          next.delete(projKey);
          persistSet(LS_COLLAPSED_PROJS_KEY, next);
          return next;
        });
      }
    }

    // Expand collapsed parent if focused task is a child (temporary — not persisted,
    // so parents collapse back on page reload unless user manually expanded them)
    if (task.parent_task_id) {
      const parentTask = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
      if (parentTask && !expandedParents.has(parentTask.id)) {
        setExpandedParents((prev) => {
          const next = new Set(prev);
          next.add(parentTask.id);
          // Don't persist — only manual chevron clicks save to localStorage
          return next;
        });
      }
    }

    // Auto-reveal: adjust filters if the focused task is hidden by current filters
    const isDone = task.status === 'done';
    if (isDone && !showCompleted && phaseFilter !== 'COMPLETE') {
      setShowCompleted(true);
    }
    if (priorityFilter && effectivePriority(task.priority) !== priorityFilter) {
      setPriorityFilter('');
    }
    if (phaseFilter && task.phase !== phaseFilter) {
      setPhaseFilter('');
    }
    if (sessionFilter && task.phase !== sessionFilter) {
      setSessionFilter('');
    }
    if (sourceFilter !== 'all' && (task.source || 'ms-todo') !== sourceFilter) {
      setSourceFilter('all');
    }

    // Scroll to the focused task after state changes (expand/filter) have flushed to DOM.
    // scrollToTask uses double-RAF + retry to wait for React commit + browser paint.
    scrollToTask(focusedTaskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTaskId, focusNonce, tasks, activeCategory, collapsedCategories, collapsedProjects, favorites]);

  // Auto-expand parent when a child task is created (via WS event)
  // Persist to localStorage so expansion survives page refresh (fork subtask bug fix)
  useEvent('task:created', (data) => {
    const { task } = data as { task: { parent_task_id?: string } };
    if (!task?.parent_task_id) return;
    // Resolve full parent ID (parent_task_id may be a prefix)
    const parentTask = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
    if (parentTask) {
      setExpandedParents((prev) => {
        if (prev.has(parentTask.id)) return prev;
        const next = new Set(prev);
        next.add(parentTask.id);
        persistSet(LS_EXPANDED_PARENTS_KEY, next);
        return next;
      });
    }
  });

  const focusedTask = useMemo(() => {
    if (!focusedTaskId) return null;
    return tasks.find((t) => t.id === focusedTaskId) ?? null;
  }, [tasks, focusedTaskId]);

  // Resolve pinned task IDs to Task objects for the pinned section
  // Filter out completed tasks (status=done or phase=COMPLETE) for display
  const pinnedTasks = useMemo(() => {
    if (!pinnedTaskIds || pinnedTaskIds.size === 0) return [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return [...pinnedTaskIds]
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.status !== 'done' && t.phase !== 'COMPLETE');
  }, [tasks, pinnedTaskIds]);

  // Split pinned into Focus / Next / Satellite
  const focusTasksLocal = useMemo(() => {
    if (!focusTaskIds || focusTaskIds.size === 0) return [];
    return pinnedTasks.filter((t) => focusTaskIds.has(t.id));
  }, [pinnedTasks, focusTaskIds]);

  const nextTasksLocal = useMemo(() => {
    if (!nextTaskIds || nextTaskIds.size === 0) return [];
    return pinnedTasks.filter((t) => nextTaskIds.has(t.id));
  }, [pinnedTasks, nextTaskIds]);

  const satelliteTasksLocal = useMemo(() => {
    const fSet = focusTaskIds ?? new Set<string>();
    const nSet = nextTaskIds ?? new Set<string>();
    return pinnedTasks.filter((t) => !fSet.has(t.id) && !nSet.has(t.id));
  }, [pinnedTasks, focusTaskIds, nextTaskIds]);

  // Recent tasks: all non-completed tasks excluding pinned, sorted by most recent activity
  const recentTasks = useMemo(() => {
    const pinSet = pinnedTaskIds ?? new Set<string>();
    // Use the most recent timestamp between session activity and creation time
    const recentTime = (t: Task) => {
      const s = t.last_session_update ?? '';
      const c = t.created_at ?? '';
      return s > c ? s : c;
    };
    return tasks
      .filter(t => !pinSet.has(t.id)
                   && t.status !== 'done' && t.phase !== 'COMPLETE')
      .sort((a, b) => recentTime(b).localeCompare(recentTime(a)))
      .slice(0, 50);
  }, [tasks, pinnedTaskIds]);

  // Stable sensor config — inline objects in useSensor destabilize dnd-kit's internal
  // memoization (Object.values({distance:5}) produces new ref each render → sensors
  // re-register on every render → cascading re-renders during drag-end transition).
  const pointerConstraint = useRef({ distance: 5 }).current;
  const pointerOpts = useMemo(() => ({ activationConstraint: pointerConstraint }), [pointerConstraint]);
  const keyboardOpts = useMemo(() => ({ coordinateGetter: sortableKeyboardCoordinates }), []);

  const sensors = useSensors(
    useSensor(PointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );

  // Sensors for pinned section DnD (separate from main task DnD)
  const pinnedSensors = useSensors(
    useSensor(PointerSensor, pointerOpts),
    useSensor(KeyboardSensor, keyboardOpts),
  );

  const pinnedTaskIds_arr = useMemo(() => pinnedTasks.map((t) => t.id), [pinnedTasks]);

  // ── Live cross-container DnD ──
  // During drag, we maintain local overrides of tier arrays so items appear in the
  // target section in real-time. On drop we commit to the server; on cancel we revert.

  const DROP_ZONE_TIERS: Record<string, FocusTier> = { 'focus-drop-zone': 'focus', 'next-drop-zone': 'next', 'satellite-drop-zone': 'satellite' };

  // Local tier arrays that can be overridden during drag
  // Drag overlay arrays stored as refs (NOT state) to avoid triggering React re-renders
  // during DnD Kit's rapid onDragOver events. A single tick counter forces a re-render
  // when we explicitly want the UI to update (during over + on end).
  const dragFocusIdsRef = useRef<string[] | null>(null);
  const dragNextIdsRef = useRef<string[] | null>(null);
  const dragSatelliteIdsRef = useRef<string[] | null>(null);
  const [, setDragTick] = useState(0);
  const bumpDragTick = useCallback(() => setDragTick(n => n + 1), []);
  // Convenience getters for the current render
  const dragFocusIds = dragFocusIdsRef.current;
  const dragNextIds = dragNextIdsRef.current;
  const dragSatelliteIds = dragSatelliteIdsRef.current;

  // Active arrays: use drag overrides when dragging, else the source-of-truth.
  // MUST be memoized — .map() creates a new array on every render, which makes
  // SortableContext receive new `items` each time → internal re-registration →
  // state update → re-render → infinite loop (React #185) during drag-end.
  const focusIds_arr = useMemo(() => dragFocusIds ?? focusTasksLocal.map((t) => t.id), [dragFocusIds, focusTasksLocal]);
  const nextIds_arr = useMemo(() => dragNextIds ?? nextTasksLocal.map((t) => t.id), [dragNextIds, nextTasksLocal]);
  const satelliteIds_arr = useMemo(() => dragSatelliteIds ?? satelliteTasksLocal.map((t) => t.id), [dragSatelliteIds, satelliteTasksLocal]);

  // Resolve tier ID arrays to Task objects (uses drag overrides when active)
  const pinnedTaskMap = useMemo(() => new Map(pinnedTasks.map((t) => [t.id, t])), [pinnedTasks]);
  const focusTasksDisplay = useMemo(() => focusIds_arr.map((id) => pinnedTaskMap.get(id)).filter(Boolean) as Task[], [focusIds_arr, pinnedTaskMap]);
  const nextTasksDisplay = useMemo(() => nextIds_arr.map((id) => pinnedTaskMap.get(id)).filter(Boolean) as Task[], [nextIds_arr, pinnedTaskMap]);
  const satelliteTasksDisplay = useMemo(() => satelliteIds_arr.map((id) => pinnedTaskMap.get(id)).filter(Boolean) as Task[], [satelliteIds_arr, pinnedTaskMap]);

  // Snapshot of original tier arrays at drag start (for revert on cancel)
  const dragStartSnapshot = useRef<{ focus: string[]; next: string[]; satellite: string[]; recent?: string[] } | null>(null);
  const [activeDragPinnedId, setActiveDragPinnedId] = useState<string | null>(null);
  const activeDragPinnedTask = useMemo(
    () => {
      if (!activeDragPinnedId) return null;
      return pinnedTasks.find((t) => t.id === activeDragPinnedId)
        ?? recentTasks.find((t) => t.id === activeDragPinnedId)
        ?? null;
    },
    [activeDragPinnedId, pinnedTasks, recentTasks],
  );

  // Recent task IDs for SortableContext
  const recentIds = useMemo(() => recentTasks.map((t) => t.id), [recentTasks]);

  const tierOfIdInArrays = useCallback((id: string): FocusTier => {
    if (focusIds_arr.includes(id)) return 'focus';
    if (nextIds_arr.includes(id)) return 'next';
    return 'satellite';
  }, [focusIds_arr, nextIds_arr]);

  const handlePinnedDragStart = useCallback((event: DragStartEvent) => {
    const fArr = focusTasksLocal.map((t) => t.id);
    const nArr = nextTasksLocal.map((t) => t.id);
    const sArr = satelliteTasksLocal.map((t) => t.id);
    const rArr = recentTasks.map((t) => t.id);
    dragStartSnapshot.current = { focus: fArr, next: nArr, satellite: sArr, recent: rArr };
    setActiveDragPinnedId(event.active.id as string);
  }, [focusTasksLocal, nextTasksLocal, satelliteTasksLocal, recentTasks]);

  // Live movement: when hovering over a different tier, move item between arrays
  // Also handles items dragged FROM Recent into a tier zone
  const handlePinnedDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    const snap = dragStartSnapshot.current;
    if (!snap) return;

    // Check if this item came from Recent
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    // Determine target tier from drop zone or card
    const targetTier = DROP_ZONE_TIERS[overId]
      ?? (snap.focus.includes(overId) || (dragFocusIds ?? snap.focus).includes(overId) ? 'focus' : undefined)
      ?? (snap.next.includes(overId) || (dragNextIds ?? snap.next).includes(overId) ? 'next' : undefined)
      ?? (snap.satellite.includes(overId) || (dragSatelliteIds ?? snap.satellite).includes(overId) ? 'satellite' : undefined);
    if (!targetTier) return;

    // For items from Recent: check if already placed in a tier during this drag
    if (isFromRecent) {
      const getRef = (tier: FocusTier) => tier === 'focus' ? (dragFocusIdsRef.current ?? snap.focus) : tier === 'next' ? (dragNextIdsRef.current ?? snap.next) : (dragSatelliteIdsRef.current ?? snap.satellite);
      const setRef = (tier: FocusTier, val: string[]) => { if (tier === 'focus') dragFocusIdsRef.current = val; else if (tier === 'next') dragNextIdsRef.current = val; else dragSatelliteIdsRef.current = val; };
      const currentPlacement =
        getRef('focus').includes(activeId) ? 'focus' as FocusTier :
        getRef('next').includes(activeId) ? 'next' as FocusTier :
        getRef('satellite').includes(activeId) ? 'satellite' as FocusTier : null;
      if (currentPlacement === targetTier) return;
      const remove = (arr: string[]) => arr.filter((id) => id !== activeId);
      if (currentPlacement) {
        setRef(currentPlacement, remove(getRef(currentPlacement)));
      }
      const targetArr = getRef(targetTier);
      setRef(targetTier, [...remove(targetArr), activeId]);
      bumpDragTick();
      return;
    }

    // Existing pinned-to-pinned cross-tier logic
    const currentTier = tierOfIdInArrays(activeId);
    if (currentTier === targetTier) return;

    // Move activeId from current to target tier arrays
    const remove = (arr: string[]) => arr.filter((id) => id !== activeId);
    const addAt = (arr: string[], ovId: string) => {
      const idx = arr.indexOf(ovId);
      if (idx === -1) return [...arr, activeId];
      const copy = [...arr];
      copy.splice(idx, 0, activeId);
      return copy;
    };

    const getArr = (tier: FocusTier) => tier === 'focus' ? (dragFocusIdsRef.current ?? snap.focus) : tier === 'next' ? (dragNextIdsRef.current ?? snap.next) : (dragSatelliteIdsRef.current ?? snap.satellite);
    const setArr = (tier: FocusTier, val: string[]) => { if (tier === 'focus') dragFocusIdsRef.current = val; else if (tier === 'next') dragNextIdsRef.current = val; else dragSatelliteIdsRef.current = val; };

    setArr(currentTier, remove(getArr(currentTier)));
    setArr(targetTier, addAt(getArr(targetTier), overId));
    bumpDragTick(); // trigger visual update
  }, [tierOfIdInArrays, bumpDragTick]);

  const clearDragState = useCallback(() => {
    dragFocusIdsRef.current = null;
    dragNextIdsRef.current = null;
    dragSatelliteIdsRef.current = null;
    dragStartSnapshot.current = null;
    setActiveDragPinnedId(null);
  }, []);

  const handlePinnedDragCancel = useCallback(() => {
    clearDragState();
  }, [clearDragState]);

  const handlePinnedDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const snap = dragStartSnapshot.current;
    clearDragState();

    if (!over || !snap) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    // Check if item came from Recent section
    const isFromRecent = snap.recent?.includes(activeId) ?? false;

    if (isFromRecent) {
      // Determine target tier from drop zone or card
      const targetTier = DROP_ZONE_TIERS[overId]
        ?? (snap.focus.includes(overId) ? 'focus' : undefined)
        ?? (snap.next.includes(overId) ? 'next' : undefined)
        ?? (snap.satellite.includes(overId) ? 'satellite' : undefined);
      if (!targetTier) return;
      // Pin first, then set tier. setFocusTier requires task.pinned===true in the
      // store, so we delay to let the pin write complete before changing tier.
      onPinTask?.(activeId);
      setTimeout(() => onSetTier?.(activeId, targetTier), 100);
      return;
    }

    // Existing pinned-to-pinned logic
    const origTier: FocusTier = snap.focus.includes(activeId) ? 'focus' : snap.next.includes(activeId) ? 'next' : 'satellite';
    const targetTier = DROP_ZONE_TIERS[overId]
      ?? (snap.focus.includes(overId) ? 'focus' : undefined)
      ?? (snap.next.includes(overId) ? 'next' : undefined)
      ?? 'satellite';

    if (origTier !== targetTier) {
      onSetTier?.(activeId, targetTier);
      return;
    }

    // Same-container reorder
    const oldIndex = pinnedTaskIds_arr.indexOf(activeId);
    const newIndex = pinnedTaskIds_arr.indexOf(overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = [...pinnedTaskIds_arr];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, activeId);
    onReorderPinned?.(newOrder);
  }, [pinnedTaskIds_arr, onReorderPinned, onSetTier, onPinTask, clearDragState]);

  // Recently completed: tracks tasks completed in the last few seconds.
  // Used for BOTH visual styling (isRecentlyDone green tint) AND filtering —
  // recently completed tasks stay visible briefly before being hidden, giving
  // the user visual feedback that the completion took effect.
  const recentlyCompletedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [, setRecentTick] = useState(0);

  useEffect(() => {
    const GRACE_MS = 3_000; // keep visible for 3s after completion
    let added = false;
    for (const task of tasks) {
      if (task.status === 'done' && task.completed_at && !recentlyCompletedRef.current.has(task.id)) {
        const elapsed = Date.now() - new Date(task.completed_at).getTime();
        if (elapsed >= 0 && elapsed < GRACE_MS) {
          recentlyCompletedRef.current.add(task.id);
          added = true;
          const timerId = setTimeout(() => {
            recentlyCompletedRef.current.delete(task.id);
            timersRef.current.delete(task.id);
            setRecentTick((n) => n + 1);
          }, GRACE_MS - elapsed);
          timersRef.current.set(task.id, timerId);
        }
      }
    }
    // Trigger re-render so the filter re-runs with the new grace entries
    if (added) setRecentTick((n) => n + 1);
    // Clean up timers for tasks that are no longer done (reopened)
    for (const [taskId, timerId] of timersRef.current) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || task.status !== 'done') {
        clearTimeout(timerId);
        timersRef.current.delete(taskId);
        recentlyCompletedRef.current.delete(taskId);
      }
    }
  }, [tasks]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const id of timers.values()) clearTimeout(id); };
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.category) set.add(t.category);
    const names = Array.from(set);
    return orderedSort(names, ordering?.categoryOrder ?? []);
  }, [tasks, ordering?.categoryOrder]);



  // Show starred tab when there are starred tasks or favorited categories/projects
  const hasStarredContent = useMemo(() => {
    const hasStarredTasks = tasks.some((t) => t.starred);
    const hasFavorites = favorites?.hasFavorites ?? false;
    return hasStarredTasks || hasFavorites;
  }, [tasks, favorites?.hasFavorites]);

  // Category counts for ViewDropdown
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.status !== 'done' || showCompleted) {
        const cat = t.category || 'Uncategorized';
        counts[cat] = (counts[cat] ?? 0) + 1;
      }
    }
    return counts;
  }, [tasks, showCompleted]);

  // Available tags for ViewDropdown
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of tasks) {
      if (t.tags) for (const tag of t.tags) tagSet.add(tag);
    }
    return Array.from(tagSet).sort();
  }, [tasks]);

  // Helper: check if a task is visible in starred view via its ancestor chain.
  // Walks up parent_task_id links (max 10 depth) checking if any ancestor is starred
  // or belongs to a favorited category/project.
  const isDescendantVisibleInStarred = useCallback((t: Task): boolean => {
    if (!t.parent_task_id) return false;
    const parent = tasks.find(p => p.id.startsWith(t.parent_task_id!));
    if (!parent) return false;
    if (parent.starred) return true;
    if (favorites?.isCategoryFavorite(parent.category)) return true;
    if (favorites?.isProjectFavorite(parent.project)) return true;
    return isDescendantVisibleInStarred(parent);
  }, [tasks, favorites]);

  const filtered = useMemo(() => {
    // First pass: apply all filters to get directly-matching tasks
    const directList = tasks.filter((t) => {
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        // Keep recently-completed tasks visible briefly for visual feedback
        if (!recentlyCompletedRef.current.has(t.id)) return false;
      }
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter) {
        if (t.phase !== sessionFilter) return false;
      }

      // Source/provider filter (treat undefined as 'ms-todo')
      if (sourceFilter !== 'all') {
        const taskSource = t.source || 'ms-todo';
        if (taskSource !== sourceFilter) return false;
      }

      // Tag filter
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;

      // Starred tab: show starred tasks + tasks in favorited categories/projects
      // Also include children of starred parents (handles prefix parent_task_id)
      if (activeCategory === STARRED_TAB) {
        const isStarred = !!t.starred;
        const isCatFavorite = favorites?.isCategoryFavorite(t.category) ?? false;
        const isProjFavorite = favorites?.isProjectFavorite(t.project) ?? false;
        return isStarred || isCatFavorite || isProjFavorite || isDescendantVisibleInStarred(t);
      }

      if (activeCategory && t.category !== activeCategory) return false;
      return true;
    });
    // Build included-ID set from first pass results
    const directlyMatched = new Set<string>(directList.map(t => t.id));

    // Second pass (iterative): include child tasks at any depth whose ancestor passed
    // the first-pass filter. Category and other filters are relaxed for children —
    // only the completed-hiding rule is enforced. Repeat until no new tasks are added
    // so that grandchildren (and deeper) are also included.
    const result = [...directList];
    let added = true;
    while (added) {
      added = false;
      for (const t of tasks) {
        if (directlyMatched.has(t.id)) continue; // already included
        if (!t.parent_task_id) continue; // not a child task
        // Respect completed filter even for children (but keep recently-completed visible)
        if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE' && !recentlyCompletedRef.current.has(t.id)) continue;
        // parent_task_id uses a prefix convention: check if any visible task's id
        // starts with this task's parent_task_id (handles composite/prefixed IDs)
        const parentVisible = result.some(p => p.id.startsWith(t.parent_task_id!));
        if (parentVisible) {
          result.push(t);
          directlyMatched.add(t.id);
          added = true;
        }
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDescendantVisibleInStarred is stable (useCallback)
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isDescendantVisibleInStarred]);

  // --- Search filtering: intersect search results with active filters ---
  // Search bypasses category tab so results span ALL categories (the whole
  // point of search is to find things you can't see in the current view).
  // Explicit toolbar filters (priority, phase, source, tag, session) are
  // still respected because the user toggled those intentionally.
  const searchFiltered = useMemo(() => {
    if (!isSearchMode) return filtered;

    const applySearchFilters = (t: Task): boolean => {
      // Show/hide completed (keep recently-completed visible briefly)
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE' && !recentlyCompletedRef.current.has(t.id)) return false;
      // Priority
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      // Phase
      if (phaseFilter && t.phase !== phaseFilter) return false;
      // Session work status
      if (sessionFilter) {
        if (t.phase !== sessionFilter) return false;
      }
      // Source/provider
      if (sourceFilter !== 'all') {
        const taskSource = t.source || 'ms-todo';
        if (taskSource !== sourceFilter) return false;
      }
      // Tag
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      // NOTE: category tab filter is intentionally skipped in search mode.
      // Search should find tasks across ALL categories — scoping to the
      // active tab defeats the purpose of searching. Other filters (priority,
      // phase, source, tag, session) are kept because they are explicit user
      // refinement choices rather than navigation affordances.
      return true;
    };

    // While API results haven't arrived yet, show client-side matches as a placeholder.
    if (!searchResults) {
      const lowerQuery = searchQuery.toLowerCase();
      return tasks.filter((t) =>
        applySearchFilters(t) && (
          t.title.toLowerCase().includes(lowerQuery) ||
          (t.description && t.description.toLowerCase().includes(lowerQuery)) ||
          (t.summary && t.summary.toLowerCase().includes(lowerQuery)) ||
          t.category.toLowerCase().includes(lowerQuery) ||
          t.project.toLowerCase().includes(lowerQuery) ||
          (t.tags && t.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) ||
          t.id.toLowerCase().includes(lowerQuery) ||
          (t.session_id && t.session_id.toLowerCase().includes(lowerQuery)) ||
          (t.session_ids && t.session_ids.some(sid => sid.toLowerCase().includes(lowerQuery))) ||
          (t.external_url && t.external_url.toLowerCase().includes(lowerQuery))
        )
      );
    }

    // Server-side results: filter to respect active view context.
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    return searchResults
      .map((r) => taskMap.get(r.taskId))
      .filter((t): t is NonNullable<typeof t> => {
        if (!t) return false;
        return applySearchFilters(t);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- activeCategory/favorites/isDescendantVisibleInStarred intentionally omitted: search bypasses category tab
  }, [tasks, filtered, isSearchMode, searchQuery, searchResults, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter]);

  // Count of search results (for display)
  const searchResultCount = isSearchMode ? searchFiltered.length : null;

  // --- Parent-anchored sort with child grouping ---
  // Produces a sorted ID order where children always follow their parent.
  const computeSortOrder = useCallback((items: Task[]): string[] => {
    const cmpMap: Record<SortBy, (a: Task, b: Task) => number> = { priority: comparePriority, date: compareDate, updated: compareUpdated };
    const cmp = cmpMap[sortBy] ?? compareDate;

    // Partition tasks into top-level (+ orphans) vs children-of-visible-parent
    const topLevel: Task[] = [];
    const childrenOf = new Map<string, Task[]>();

    // Build a prefix→fullId lookup so parent_task_id (short prefix) resolves to the actual parent
    const fullIds = items.map((t) => t.id);
    const resolveParent = (prefix: string): string | undefined =>
      fullIds.find((id) => id.startsWith(prefix));

    for (const task of items) {
      if (!task.parent_task_id) {
        topLevel.push(task);
        continue;
      }
      // parent_task_id may be a short prefix (e.g. "mlk71mm5") — resolve via prefix match
      const parentFullId = resolveParent(task.parent_task_id);
      if (parentFullId) {
        let siblings = childrenOf.get(parentFullId);
        if (!siblings) { siblings = []; childrenOf.set(parentFullId, siblings); }
        siblings.push(task);
      } else {
        // Orphan: parent not in filtered set — render as top-level
        topLevel.push(task);
      }
    }

    topLevel.sort(cmp);
    for (const children of childrenOf.values()) children.sort(cmp);

    // Recursive interleave: parent → children → grandchildren
    const order: string[] = [];
    const visited = new Set<string>();
    function emitWithChildren(task: Task) {
      if (visited.has(task.id)) return; // cycle guard
      visited.add(task.id);
      order.push(task.id);
      const children = childrenOf.get(task.id);
      if (children) for (const child of children) emitWithChildren(child);
    }
    for (const task of topLevel) emitWithChildren(task);
    return order;
  }, [sortBy]);

  // --- Debounced sort order ---
  // Badge/data updates instantly (always use latest `filtered` task objects).
  // Only the POSITION (sort order) is debounced by 3s on reorder-only changes.
  const [sortOrder, setSortOrder] = useState<string[]>(() => computeSortOrder(filtered));
  const sortByRef = useRef(sortBy);
  const prevFilteredIdsRef = useRef<Set<string>>(new Set(filtered.map((t) => t.id)));
  // Equality check for sort order — prevents no-op re-renders when task data changes
  // but the sorted order is identical (e.g. focus_tier change doesn't affect sort position).
  const stableSortUpdate = useCallback((newOrder: string[]) => {
    setSortOrder(prev => {
      if (prev.length === newOrder.length && prev.every((id, i) => id === newOrder[i])) return prev;
      return newOrder;
    });
  }, []);

  useEffect(() => {
    const newOrder = computeSortOrder(filtered);

    // sortBy toggle or structural change (IDs added/removed): flush immediately
    const currIds = new Set(filtered.map((t) => t.id));
    const prevIds = prevFilteredIdsRef.current;
    const structural = currIds.size !== prevIds.size || !filtered.every((t) => prevIds.has(t.id));
    if (sortByRef.current !== sortBy || structural) {
      sortByRef.current = sortBy;
      prevFilteredIdsRef.current = currIds;
      stableSortUpdate(newOrder);
      return;
    }
    prevFilteredIdsRef.current = currIds;

    // Same set of tasks, just reordered (e.g. priority change): debounce 3s
    const timer = setTimeout(() => stableSortUpdate(newOrder), 3000);
    return () => clearTimeout(timer);
  }, [filtered, sortBy, computeSortOrder, stableSortUpdate]);

  // --- Combine: latest task data arranged in deferred sort order ---
  // This ensures badges/fields update INSTANTLY while position delays.
  const sorted = useMemo(() => {
    const taskById = new Map(filtered.map((t) => [t.id, t]));
    const result: Task[] = [];
    const emitted = new Set<string>();
    // Emit tasks in deferred sort order (stale position), using fresh task objects
    for (const id of sortOrder) {
      const task = taskById.get(id);
      if (task) { result.push(task); emitted.add(id); }
    }
    // Append any new tasks not yet in sortOrder (just added)
    for (const task of filtered) {
      if (!emitted.has(task.id)) result.push(task);
    }
    return result;
  }, [filtered, sortOrder]);

  // Cross-filter counts: each dimension counts tasks matching all OTHER active filters
  const filterCounts = useMemo(() => {
    // Shared predicates to avoid duplication across filter dimensions.
    const matchesCategory = (t: Task) => {
      if (activeCategory === STARRED_TAB) {
        return !!t.starred || (favorites?.isCategoryFavorite(t.category) ?? false) || (favorites?.isProjectFavorite(t.project) ?? false) || isDescendantVisibleInStarred(t);
      }
      return !activeCategory || t.category === activeCategory;
    };
    const matchesPrioritySessionSource = (t: Task) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    };

    // baseTasks: respects showCompleted (used for "All" counts and most dimensions)
    const baseTasks = tasks.filter((t) => {
      if (!showCompleted && t.status === 'done' && phaseFilter !== 'COMPLETE') {
        return false;
      }
      return matchesCategory(t);
    });

    // Priority counts (apply phase + session + source + tag filters)
    const forPriority = baseTasks.filter((t) => {
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    const priority: Record<string, number> = { immediate: 0, important: 0, backlog: 0, none: 0 };
    for (const t of forPriority) {
      const p = effectivePriority(t.priority); // legacy fallback
      if (p && priority[p] !== undefined) priority[p]++;
    }

    // Phase counts: include all done tasks so COMPLETE count is accurate even when
    // showCompleted is off. Clicking COMPLETE overrides showCompleted (line ~1055),
    // so the count must reflect what the user would see after clicking.
    // Note: sum(phase counts) > totalForPhase when showCompleted=false — this is intentional.
    const forPhase = tasks.filter((t) => matchesCategory(t) && matchesPrioritySessionSource(t));
    const phase: Record<string, number> = {};
    for (const p of PHASE_ORDER) phase[p] = 0;
    for (const t of forPhase) if (t.phase && phase[t.phase] !== undefined) phase[t.phase]++;

    // totalForPhase: "All" chip count respects showCompleted so it matches visible tasks
    const totalForPhase = baseTasks.filter(matchesPrioritySessionSource).length;

    // Session counts (apply priority + phase + source + tag filters)
    const forSession = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    const session: Record<string, number> = {};
    for (const p of PHASE_ORDER) session[p] = 0;
    for (const t of forSession) {
      if (t.phase && session[t.phase] !== undefined) session[t.phase]++;
    }

    // Source counts (apply priority + phase + session + tag filters)
    const forSource = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (tagFilter && (!t.tags || !t.tags.includes(tagFilter))) return false;
      return true;
    });
    // Build source counts dynamically from registered integrations
    const source: Record<string, number> = { all: forSource.length };
    for (const integ of integrations) source[integ.id] = 0;
    source['local'] = 0;
    for (const t of forSource) {
      const s = t.source || 'ms-todo';
      if (source[s] === undefined) source[s] = 0;
      source[s]++;
    }

    // Tag counts (apply priority + phase + session + source filters)
    const forTags = baseTasks.filter((t) => {
      if (priorityFilter && effectivePriority(t.priority) !== priorityFilter) return false;
      if (phaseFilter && t.phase !== phaseFilter) return false;
      if (sessionFilter && t.phase !== sessionFilter) return false;
      if (sourceFilter !== 'all' && (t.source || 'ms-todo') !== sourceFilter) return false;
      return true;
    });
    const tagCounts: Record<string, number> = {};
    for (const t of forTags) {
      if (t.tags) for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }

    return { priority, phase, session, source, tagCounts, totalForPriority: forPriority.length, totalForPhase, totalForSession: forSession.length, totalForTags: forTags.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, showCompleted, priorityFilter, phaseFilter, sessionFilter, sourceFilter, tagFilter, activeCategory, favorites, isDescendantVisibleInStarred]);

  // Build category -> project -> tasks hierarchy (skipped in flat mode)
  const grouped = useMemo(() => {
    if (groupBy === 'none') return [];
    const map = new Map<string, { direct: Task[]; projects: Map<string, Task[]> }>();
    for (const task of sorted) {
      const cat = task.category || 'Uncategorized';
      const hasDistinctProject = task.project && task.project !== task.category;
      if (!map.has(cat)) map.set(cat, { direct: [], projects: new Map() });
      const entry = map.get(cat)!;
      if (hasDistinctProject) {
        const proj = task.project!;
        if (!entry.projects.has(proj)) entry.projects.set(proj, []);
        entry.projects.get(proj)!.push(task);
      } else {
        entry.direct.push(task);
      }
    }
    const catOrder = ordering?.categoryOrder ?? [];
    const projOrder = ordering?.projectOrder ?? {};
    const catNames = orderedSort(Array.from(map.keys()), catOrder);
    return catNames.map((cat) => {
      const entry = map.get(cat)!;
      const projNames = orderedSort(Array.from(entry.projects.keys()), projOrder[cat] ?? []);
      return {
        category: cat,
        directTasks: entry.direct,
        projects: projNames.map((proj) => ({ project: proj, tasks: entry.projects.get(proj)! })),
      };
    });
  }, [sorted, groupBy, ordering?.categoryOrder, ordering?.projectOrder]);

  // Child task maps: parentId → count, set of child task IDs, and child→parent mapping
  // Only tasks whose parent is VISIBLE in the current list are treated as children.
  // Orphans (parent hidden/completed/filtered out) render as normal top-level tasks.
  // True child count from the FULL task list (unfiltered) — used for chevron + "N sub" badge
  // so the user always sees that children exist, even when they're filtered out.
  const trueChildCountMap = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const task of tasks) {
      if (task.parent_task_id) {
        const parent = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
        if (parent) countMap.set(parent.id, (countMap.get(parent.id) ?? 0) + 1);
      }
    }
    return countMap;
  }, [tasks]);

  const { childTaskIds, childParentMap, depthMap } = useMemo(() => {
    const childIds = new Set<string>();
    const parentMap = new Map<string, string>(); // childId → parentFullId
    for (const task of sorted) {
      if (task.parent_task_id) {
        // Find parent — match by prefix (parent_task_id may be a short prefix)
        const parentId = task.parent_task_id;
        const parent = sorted.find((t) => t.id.startsWith(parentId));
        if (parent) {
          childIds.add(task.id);
          parentMap.set(task.id, parent.id);
        }
        // If parent not visible → orphan: no childIds entry, renders as top-level
      }
    }
    // Compute depth for each task by walking the parent chain (supports unlimited nesting)
    const depths = new Map<string, number>();
    const MAX_DEPTH = 10; // Safety cap against unexpected cycles
    const getDepth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const pid = parentMap.get(id);
      const d = pid ? Math.min(getDepth(pid) + 1, MAX_DEPTH) : 0;
      depths.set(id, d);
      return d;
    };
    for (const task of sorted) getDepth(task.id);
    return { childTaskIds: childIds, childParentMap: parentMap, depthMap: depths };
  }, [sorted]);

  // Determine if a child task should be hidden (any ancestor is collapsed — walks full chain)
  const isChildHidden = useCallback((taskId: string) => {
    let currentId: string | undefined = taskId;
    while (currentId) {
      const parentId = childParentMap.get(currentId);
      if (!parentId) return false; // reached a root task
      if (!expandedParents.has(parentId)) return true; // ancestor collapsed
      currentId = parentId;
    }
    return false;
  }, [childParentMap, expandedParents]);

  // Full (unfiltered) group map — needed so task reorder sends ALL IDs to the backend
  const fullGrouped = useMemo(() => {
    const map = new Map<string, { direct: Task[]; projects: Map<string, Task[]> }>();
    for (const task of tasks) {
      const cat = task.category || 'Uncategorized';
      const hasDistinctProject = task.project && task.project !== task.category;
      if (!map.has(cat)) map.set(cat, { direct: [], projects: new Map() });
      const entry = map.get(cat)!;
      if (hasDistinctProject) {
        const proj = task.project!;
        if (!entry.projects.has(proj)) entry.projects.set(proj, []);
        entry.projects.get(proj)!.push(task);
      } else {
        entry.direct.push(task);
      }
    }
    return map;
  }, [tasks]);

  // Build a lookup: taskId → { category, project } for drag end
  // Normalize project: direct tasks use category as project (matches DroppableHeader data)
  const taskGroupMap = useMemo(() => {
    const m = new Map<string, { category: string; project: string }>();
    for (const g of grouped) {
      for (const t of g.directTasks) m.set(t.id, { category: g.category, project: g.category });
      for (const p of g.projects) {
        for (const t of p.tasks) m.set(t.id, { category: g.category, project: p.project });
      }
    }
    return m;
  }, [grouped]);

  const handleAdd = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    try {
      const result = await onCreate({ title, priority: 'none', category: 'Inbox', project: 'Quick Start' });
      setNewTitle('');
      if (onClearOperationError) onClearOperationError();
      const newTask = result as Task | undefined;
      if (newTask?.id) {
        // Smart navigation: All view shows everything so stay; others jump to Inbox
        if (activeCategory !== '') {
          setActiveCategory('Inbox');
          persistTab('Inbox');
          onCategoryChange?.('Inbox');
        }
        // Auto-focus triggers scroll-into-view via SortableTaskItem
        onFocusTask?.(newTask);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add task';
      if (onOperationError) onOperationError(msg);
    }
  }, [newTitle, onCreate, onClearOperationError, onOperationError, onFocusTask, activeCategory]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      persistSet(LS_COLLAPSED_CATS_KEY, next);
      return next;
    });
  };

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistSet(LS_COLLAPSED_PROJS_KEY, next);
      return next;
    });
  };

  // Toggle child task visibility for a parent task (default: collapsed)
  const toggleParentExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      persistSet(LS_EXPANDED_PARENTS_KEY, next);
      return next;
    });
  }, []);

  const isParentExpanded = useCallback((parentId: string) => {
    return expandedParents.has(parentId);
  }, [expandedParents]);

  // Collapse all / expand all
  const allGroupKeys = useMemo(() => {
    const catNames = grouped.map((g) => g.category);
    const projKeys: string[] = [];
    for (const g of grouped) {
      for (const p of g.projects) {
        projKeys.push(`${g.category}/${p.project}`);
      }
    }
    return { catNames, projKeys };
  }, [grouped]);

  const allCollapsed = allGroupKeys.catNames.length > 0 &&
    allGroupKeys.catNames.every((c) => collapsedCategories.has(c));

  const handleCollapseExpandAll = useCallback(() => {
    if (allCollapsed) {
      // Expand all
      setCollapsedCategories(new Set());
      setCollapsedProjects(new Set());
      persistSet(LS_COLLAPSED_CATS_KEY, new Set());
      persistSet(LS_COLLAPSED_PROJS_KEY, new Set());
    } else {
      // Collapse all — also collapse child tasks
      const nextCats = new Set(allGroupKeys.catNames);
      const nextProjs = new Set(allGroupKeys.projKeys);
      setCollapsedCategories(nextCats);
      setCollapsedProjects(nextProjs);
      setExpandedParents(new Set());
      persistSet(LS_COLLAPSED_CATS_KEY, nextCats);
      persistSet(LS_COLLAPSED_PROJS_KEY, nextProjs);
      persistSet(LS_EXPANDED_PARENTS_KEY, new Set());
    }
  }, [allCollapsed, allGroupKeys]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    const type = (event.active.data?.current as { type?: string })?.type ?? 'task';
    setActiveDragType(type);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    setActiveDragType(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeType = (active.data?.current as { type?: string })?.type ?? 'task';

    // Category group reorder (collision is type-aware, so over.id is always cat:*)
    if (activeType === 'category-group' && ordering) {
      const overId = String(over.id);
      if (!overId.startsWith('cat:')) return;
      const activeId = String(active.id).slice(4); // strip 'cat:'
      const targetCat = overId.slice(4);
      if (targetCat === activeId) return;
      const catNames = grouped.map((g) => g.category);
      const oldIndex = catNames.indexOf(activeId);
      const newIndex = catNames.indexOf(targetCat);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...catNames];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeId);
      ordering.reorderCategories(newOrder);
      return;
    }

    // Project group reorder (collision is type-aware, so over.id is always proj:*)
    if (activeType === 'project-group' && ordering) {
      const overId = String(over.id);
      if (!overId.startsWith('proj:')) return;
      const activeRest = String(active.id).slice(5); // strip 'proj:'
      const slashIdx = activeRest.indexOf('/');
      if (slashIdx === -1) return;
      const activeCat = activeRest.slice(0, slashIdx);
      const activeProj = activeRest.slice(slashIdx + 1);
      const overRest = overId.slice(5);
      const overSlashIdx = overRest.indexOf('/');
      if (overSlashIdx === -1) return;
      const targetProj = overRest.slice(overSlashIdx + 1);
      if (targetProj === activeProj) return;
      const group = grouped.find((g) => g.category === activeCat);
      if (!group) return;
      const projNames = group.projects.map((p) => p.project);
      const oldIndex = projNames.indexOf(activeProj);
      const newIndex = projNames.indexOf(targetProj);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = [...projNames];
      newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, activeProj);
      ordering.reorderProjects(activeCat, newOrder);
      return;
    }

    // Task reorder or cross-group move
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeInfo = taskGroupMap.get(activeId);
    if (!activeInfo) return;

    // Determine target group: from task or from header drop zone
    let targetCategory: string;
    let targetProject: string;
    let insertNearTaskId: string | undefined;

    if (taskGroupMap.has(overId)) {
      // Dropped on a task
      const overInfo = taskGroupMap.get(overId)!;
      targetCategory = overInfo.category;
      targetProject = overInfo.project;
      insertNearTaskId = overId;
    } else if (overId.startsWith('hdr-cat:') || overId.startsWith('hdr-proj:')) {
      // Dropped on a header
      const overData = over.data?.current as { category?: string; project?: string } | undefined;
      if (!overData?.category) return;
      targetCategory = overData.category;
      targetProject = overData.project ?? overData.category;
      insertNearTaskId = undefined; // append to end
    } else {
      return;
    }

    // ── Reparent detection ──
    // When dragging a task, check if the drop target implies a parent change.
    // Rules:
    //   - Drop on a child task → adopt same parent (become sibling)
    //   - Drop on a parent task (has children) → become child of that task
    //   - Drop on a header → unparent (become top-level)
    //   - Drop on a regular task (no children, no parent) → unparent
    const activeTask = sorted.find((t) => t.id === activeId);
    if (activeTask && onReparentTask) {
      let newParentId: string | null = null;
      if (insertNearTaskId) {
        const targetTask = sorted.find((t) => t.id === insertNearTaskId);
        if (targetTask) {
          if (childParentMap.has(targetTask.id)) {
            // Target is a child → adopt same parent (become sibling)
            newParentId = childParentMap.get(targetTask.id)!;
          } else if ((trueChildCountMap.get(targetTask.id) ?? 0) > 0) {
            // Target is a parent (has visible children) → become child of target
            newParentId = targetTask.id;
          }
          // else: target is a plain top-level task → newParentId stays null (unparent)
        }
      }
      // Dropped on header: newParentId stays null (unparent)

      // Prevent cycles: don't allow reparenting to self or to a descendant
      if (newParentId === activeId) return;
      let walkId: string | undefined = newParentId ?? undefined;
      while (walkId) {
        const nextParent = childParentMap.get(walkId);
        if (nextParent === activeId) return; // would create a cycle
        walkId = nextParent;
      }

      // Resolve current parent of the dragged task
      const currentParentId = activeTask.parent_task_id
        ? (sorted.find((t) => t.id.startsWith(activeTask.parent_task_id!))?.id ?? null)
        : null;

      if (newParentId !== currentParentId) {
        // Auto-expand new parent so the moved task is visible
        if (newParentId) {
          setExpandedParents((prev) => {
            if (prev.has(newParentId!)) return prev;
            const next = new Set(prev);
            next.add(newParentId!);
            return next;
          });
        }
        onReparentTask(activeId, newParentId);
        return;
      }
    }

    const sameGroup = activeInfo.category === targetCategory && activeInfo.project === targetProject;

    if (sameGroup) {
      // Same group: existing reorder logic
      if (!onReorder) return;
      if (!insertNearTaskId) return; // dropped on own header, nothing to do

      const { category, project } = activeInfo;
      const group = grouped.find((g) => g.category === category);
      if (!group) return;

      const hasDistinctProject = project && project !== category;
      const visibleTasks = hasDistinctProject
        ? group.projects.find((p) => p.project === project)?.tasks
        : group.directTasks;
      if (!visibleTasks) return;

      const visibleIds = visibleTasks.map((t) => t.id);
      const oldIndex = visibleIds.indexOf(activeId);
      const newIndex = visibleIds.indexOf(insertNearTaskId);
      if (oldIndex === -1 || newIndex === -1) return;

      const newVisibleIds = [...visibleIds];
      newVisibleIds.splice(oldIndex, 1);
      newVisibleIds.splice(newIndex, 0, activeId);

      // Get the FULL (unfiltered) task list so the backend gets all IDs
      const fullEntry = fullGrouped.get(category);
      if (!fullEntry) return;
      const fullTasks = hasDistinctProject
        ? fullEntry.projects.get(project!)
        : fullEntry.direct;
      if (!fullTasks) return;

      // Merge reordered visible tasks back into the full list,
      // preserving positions of hidden (e.g. completed) tasks
      const fullIds = fullTasks.map((t) => t.id);
      const visibleSet = new Set(visibleIds);
      const result: string[] = [];
      let vi = 0;
      for (const id of fullIds) {
        if (visibleSet.has(id)) {
          result.push(newVisibleIds[vi++]);
        } else {
          result.push(id);
        }
      }

      onReorder(category, project, result);
    } else {
      // Cross-group move
      if (!onMoveTask) return;
      onMoveTask(activeId, targetCategory, targetProject, insertNearTaskId);
    }
  }, [onReorder, onMoveTask, onReparentTask, ordering, taskGroupMap, grouped, fullGrouped, sorted, childParentMap, trueChildCountMap]);

  const draggedTask = activeDragId ? sorted.find((t) => t.id === activeDragId) : null;

  // User-controlled collapse only — no auto-collapse during drag
  const isCategoryCollapsed = useCallback((cat: string) => {
    return collapsedCategories.has(cat);
  }, [collapsedCategories]);

  const isProjectCollapsed = useCallback((projKey: string) => {
    return collapsedProjects.has(projKey);
  }, [collapsedProjects]);

  // Click task row (or pinned card) = select + scroll + open session (if any). Never open detail panel.
  // Pinned cards and list rows share identical behavior — single handler, one alias.
  const handleTaskClick = useCallback((task: Task) => {
    const sid = resolveTaskSessionId(task);
    if (sid) onOpenSession?.(sid);
    // Always scroll to position; suppress detail panel (ⓘ button is the only way to open detail)
    onFocusTask?.(task, { openDetail: false });
  }, [onFocusTask, onOpenSession]);

  const handlePinnedCardClick = handleTaskClick;

  const handleExpandDetail = useCallback((task: Task) => {
    setDetailTarget(null);
    onFocusTask ? onFocusTask(task) : navigate(`/tasks/${task.id}`);
  }, [onFocusTask, navigate]);

  const showProjectDetail = useCallback((category: string, project: string) => {
    setDetailTarget({ type: 'project', category, project });
    onClearFocus?.();
  }, [onClearFocus]);

  const showCategoryDetail = useCallback((category: string) => {
    setDetailTarget({ type: 'category', category });
    onClearFocus?.();
  }, [onClearFocus]);

  const handleUpdateTitle = useCallback((id: string, title: string) => {
    if (onUpdate) onUpdate(id, { title });
  }, [onUpdate]);

  return (
    <div className={`todo-panel${splitterResizing ? ' splitter-resizing' : ''}`} ref={splitterContainerRef}>
      {/* Search bar + View dropdown — single row replaces old tabs + filters + sort */}
      <div className="todo-panel-toolbar">
        <TodoSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClear={clearSearch}
          isSearching={isSearching}
          resultCount={searchResultCount}
        />
        <ViewDropdown
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={(cat) => { setActiveCategory(cat); persistTab(cat); onCategoryChange?.(cat); }}
          categoryCounts={categoryCounts}
          hasStarredContent={hasStarredContent}
          phaseFilter={phaseFilter}
          onPhaseFilterChange={setPhaseFilter}
          priorityFilter={priorityFilter}
          onPriorityFilterChange={setPriorityFilter}
          tagFilter={tagFilter}
          onTagFilterChange={setTagFilter}
          availableTags={availableTags}
          sortBy={sortBy}
          onSortByChange={(v) => { setSortBy(v); persistSortBy(v); }}
          groupBy={groupBy}
          onGroupByChange={(v) => { setGroupBy(v); persistGroupBy(v); }}
          showCompleted={showCompleted}
          onShowCompletedChange={setShowCompleted}
          onClearAll={() => {
            setActiveCategory(''); persistTab(''); onCategoryChange?.('');
            setPhaseFilter('');
            setPriorityFilter('');
            setTagFilter('');
            setSessionFilter('');
            setSourceFilter('all');
          }}
        />
      </div>

      {/* Unified DndContext wrapping both Pinned + Recent — enables drag from Recent to Pin */}
      {(pinnedTasks.length > 0 || recentTasks.length > 0) && (
        <DndContext sensors={pinnedSensors} collisionDetection={closestCenter} onDragStart={handlePinnedDragStart} onDragOver={handlePinnedDragOver} onDragEnd={handlePinnedDragEnd} onDragCancel={handlePinnedDragCancel}>
          <div className="todo-pinned-wrapper">
          {/* PINNED section — Focus + Next + Satellite sub-groups */}
          {pinnedTasks.length > 0 && (
            <div className="todo-pinned-section">
              <div className="todo-pinned-header" onClick={() => setPinnedCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPinnedCollapsed(c => !c); }} style={{ cursor: 'pointer' }}>
                <span className={`todo-pinned-chevron${pinnedCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                <span className="todo-pinned-label">Pinned</span>
                <span className="todo-pinned-count">{pinnedTasks.length}</span>
              </div>
              {!pinnedCollapsed && (
                <>
                  {/* Focus sub-group */}
                  <div className="todo-pinned-subgroup">
                    <div className="todo-pinned-sublabel" onClick={() => setFocusCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setFocusCollapsed(c => !c); }} style={{ cursor: 'pointer' }} title="Current sprint — finish these first">
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${focusCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-icon-focus" />
                      <span className="todo-pinned-sublabel-text">Focus</span>
                      <span className="todo-pinned-sublabel-count">{focusTasksDisplay.length}</span>
                    </div>
                    {!focusCollapsed && (
                      <SortableContext items={focusIds_arr} strategy={verticalListSortingStrategy}>
                        <TierDropZone id="focus-drop-zone" isEmpty={focusTasksDisplay.length === 0}>
                          {focusTasksDisplay.map((task) => (
                            <SortableTierCard key={task.id} task={task} tier="focus" isFocused={focusedTaskId === task.id} onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask} />
                          ))}
                        </TierDropZone>
                      </SortableContext>
                    )}
                  </div>

                  {/* Next sub-group */}
                  <div className="todo-pinned-subgroup">
                    <div className="todo-pinned-sublabel" onClick={() => setNextCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setNextCollapsed(c => !c); }} style={{ cursor: 'pointer' }} title="Next sprint — queued after Focus is done">
                      <span className={`todo-pinned-chevron todo-pinned-sub-chevron${nextCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                      <span className="todo-pinned-sublabel-icon todo-icon-next" />
                      <span className="todo-pinned-sublabel-text">Next</span>
                      <span className="todo-pinned-sublabel-count">{nextTasksDisplay.length}</span>
                    </div>
                    {!nextCollapsed && (
                      <SortableContext items={nextIds_arr} strategy={verticalListSortingStrategy}>
                        <TierDropZone id="next-drop-zone" isEmpty={nextTasksDisplay.length === 0}>
                          {nextTasksDisplay.map((task) => (
                            <SortableTierCard key={task.id} task={task} tier="next" isFocused={focusedTaskId === task.id} onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask} />
                          ))}
                        </TierDropZone>
                      </SortableContext>
                    )}
                  </div>

                  {/* Satellite sub-group */}
                  {satelliteTasksDisplay.length > 0 && (
                    <div className="todo-pinned-subgroup">
                      <div className="todo-pinned-sublabel" onClick={() => setSatelliteCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSatelliteCollapsed(c => !c); }} style={{ cursor: 'pointer' }} title="Backlog — other pinned tasks">
                        <span className={`todo-pinned-chevron todo-pinned-sub-chevron${satelliteCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                        <span className="todo-pinned-sublabel-icon todo-icon-satellite" />
                        <span className="todo-pinned-sublabel-text">Satellite</span>
                        <span className="todo-pinned-sublabel-count">{satelliteTasksDisplay.length}</span>
                      </div>
                      {!satelliteCollapsed && (
                        <SortableContext items={satelliteIds_arr} strategy={verticalListSortingStrategy}>
                          <div className="todo-pinned-list todo-pinned-list-scroll" style={{ maxHeight: PINNED_VISIBLE_MAX * 30 }}>
                            {satelliteTasksDisplay.map((task) => (
                              <SortableTierCard key={task.id} task={task} tier="satellite" isFocused={focusedTaskId === task.id} onClick={handlePinnedCardClick} onSetTier={onSetTier} onUnpinTask={onUnpinTask} />
                            ))}
                          </div>
                        </SortableContext>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Recent tasks section — draggable cards, drop on Pinned tiers to pin */}
          {recentTasks.length > 0 && (
            <div className="todo-pinned-section">
              <div className="todo-pinned-header" onClick={() => setRecentCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setRecentCollapsed(c => !c); }} style={{ cursor: 'pointer' }}>
                <span className={`todo-pinned-chevron${recentCollapsed ? '' : ' todo-pinned-chevron-open'}`}>{'\u25B8'}</span>
                <span className="todo-pinned-label">Recent</span>
                <span className="todo-pinned-count">{recentTasks.length}</span>
              </div>
              {!recentCollapsed && (
                <SortableContext items={recentIds} strategy={verticalListSortingStrategy}>
                  <div className="todo-pinned-list todo-pinned-list-scroll" style={{ maxHeight: RECENT_VISIBLE_MAX * 30 }}>
                    {recentTasks.map((task) => (
                      <SortableRecentCard
                        key={task.id}
                        task={task}
                        isFocused={focusedTaskId === task.id}
                        onClick={handlePinnedCardClick}
                        onPinTask={onPinTask}
                      />
                    ))}
                  </div>
                </SortableContext>
              )}
            </div>
          )}

          </div>
          {/* Floating preview card during cross-container drag */}
          <DragOverlay dropAnimation={null}>
            {activeDragPinnedTask && (
              <div className="todo-pinned-card todo-pinned-card-dragging">
                <span className="todo-pinned-title" title={activeDragPinnedTask.title}>{activeDragPinnedTask.title}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      <div className="todo-panel-list" style={((focusedTask && !suppressDetail) || detailTarget) ? { flex: `${1 - detailRatio} 1 0%` } : undefined}>
        {loading && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, margin: '0 auto' }} />
          </div>
        )}
        {!loading && isSearchMode && searchFiltered.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <p className="text-sm">No tasks match &lsquo;{searchQuery}&rsquo;</p>
          </div>
        )}
        {!loading && !isSearchMode && filtered.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 8px' }}>
            <p className="text-sm">No tasks found</p>
          </div>
        )}
        {/* Search mode: flat, score-sorted list (no category/project grouping) */}
        {!loading && isSearchMode && searchFiltered.length > 0 && (
          <div className="todo-search-results">
            {(() => {
              const searchMeta = new Map(searchResults?.map(r => [r.taskId, r]) ?? []);
              // Compute child maps from searchFiltered (cross-category)
              const searchChildIds = new Set<string>();
              const searchChildCount = new Map<string, number>();
              const searchChildParent = new Map<string, string>();
              for (const task of searchFiltered) {
                if (task.parent_task_id) {
                  const parent = searchFiltered.find(t => t.id.startsWith(task.parent_task_id!));
                  if (parent) {
                    searchChildIds.add(task.id);
                    searchChildParent.set(task.id, parent.id);
                    searchChildCount.set(parent.id, (searchChildCount.get(parent.id) ?? 0) + 1);
                  }
                }
              }
              // Sort: parents first, children right after their parent
              const ordered: typeof searchFiltered = [];
              const emitted = new Set<string>();
              for (const task of searchFiltered) {
                if (emitted.has(task.id)) continue;
                if (searchChildIds.has(task.id)) continue; // skip children on first pass
                emitted.add(task.id);
                ordered.push(task);
                // Insert children right after parent
                for (const child of searchFiltered) {
                  if (!emitted.has(child.id) && child.parent_task_id && task.id.startsWith(child.parent_task_id)) {
                    emitted.add(child.id);
                    ordered.push(child);
                  }
                }
              }
              // Append any remaining (orphan children whose parent wasn't found)
              for (const task of searchFiltered) {
                if (!emitted.has(task.id)) ordered.push(task);
              }
              let relevanceDividerShown = false;
              return ordered.map((task) => {
                // Hide children of collapsed parents
                const searchParentId = searchChildParent.get(task.id);
                if (searchParentId && !expandedParents.has(searchParentId)) return null;
                // Relevance divider: show once when score drops below 0.4
                const score = searchMeta.get(task.id)?.score;
                let divider: ReactNode = null;
                if (!relevanceDividerShown && score != null && score < 0.4 && !searchChildIds.has(task.id)) {
                  relevanceDividerShown = true;
                  divider = (
                    <div key="__relevance-divider" className="search-relevance-divider">
                      <span>Less relevant</span>
                    </div>
                  );
                }
                return (
                  <Fragment key={task.id}>
                  {divider}
                  <SortableTaskItem
                    key={task.id}
                    task={task}
                    isFocused={focusedTaskId === task.id}
                    isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                    depth={depthMap.get(task.id) ?? 0}
                    childCount={searchChildCount.get(task.id)}
                    isExpanded={expandedParents.has(task.id)}
                    onToggleExpand={() => toggleParentExpand(task.id)}
                    onClick={() => handleTaskClick(task)}
                    onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                    onStar={onStar}
                    onSetPriority={onSetPriority}
                    onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                    onOpenSession={onOpenSession}
                    openSessionIds={openSessionIds}
                    onExpandDetail={handleExpandDetail}
                    onClearFocus={onClearFocus}
                    onPinTask={onPinTask}
                    onUnpinTask={onUnpinTask}
                    isPinned={pinnedTaskIds?.has(task.id)}
                    searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
                    searchMatchField={searchMeta.get(task.id)?.matchField}
                    searchScore={searchMeta.get(task.id)?.score}
                    searchKeywordScore={searchMeta.get(task.id)?.keywordScore}
                    searchSemanticScore={searchMeta.get(task.id)?.semanticScore}
                  />
                  </Fragment>
                );
              });
            })()}
          </div>
        )}
        {/* Flat mode: ungrouped list sorted by selected sort option */}
        {!loading && !isSearchMode && groupBy === 'none' && sorted.length > 0 && (
          <div className="todo-flat-results">
            {sorted.map((task) => {
              if (isChildHidden(task.id)) return null;
              return (
                <SortableTaskItem
                  key={task.id}
                  task={task}
                  isFocused={focusedTaskId === task.id}
                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                  depth={depthMap.get(task.id) ?? 0}
                  childCount={trueChildCountMap.get(task.id)}
                  isExpanded={expandedParents.has(task.id)}
                  onToggleExpand={() => toggleParentExpand(task.id)}
                  onClick={() => handleTaskClick(task)}
                  onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                  onStar={onStar}
                  onSetPriority={onSetPriority}
                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                  onOpenSession={onOpenSession}
                  openSessionIds={openSessionIds}
                  onExpandDetail={handleExpandDetail}
                  onClearFocus={onClearFocus}
                  onPinTask={onPinTask}
                  onUnpinTask={onUnpinTask}
                  isPinned={pinnedTaskIds?.has(task.id)}
                  searchContext={`${task.category}${task.project && task.project !== task.category ? ` / ${task.project}` : ''}`}
                />
              );
            })}
          </div>
        )}
        {/* Normal mode: grouped hierarchy */}
        {!loading && !isSearchMode && groupBy !== 'none' && (
          <DndContext
            sensors={sensors}
            collisionDetection={typeAwareCollision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={grouped.map((g) => `cat:${g.category}`)} strategy={verticalListSortingStrategy}>
              {grouped.map(({ category, directTasks, projects }) => (
                <SortableGroupItem key={`cat:${category}`} id={`cat:${category}`}>
                  {({ dragHandleProps }: { dragHandleProps: Record<string, unknown> }) => (
                    <div className="todo-group-category">
                      <DroppableHeader id={`hdr-cat:${category}`} category={category} project={category} disabled={activeDragType !== 'task'}>
                        {({ isOver: isHeaderOver, setNodeRef: setHeaderRef }) => (
                          <div ref={setHeaderRef} className={`todo-group-category-header${isHeaderOver ? ' header-drop-active' : ''}`} {...dragHandleProps}>
                            <div className="todo-group-header-controls">
                              <button className={`collapse-chevron${!isCategoryCollapsed(category) ? ' expanded' : ''}`} onClick={(e) => { e.stopPropagation(); toggleCategory(category); }} title="Collapse/Expand">
                                {CHEVRON_ICON}
                              </button>
                              <button className="todo-group-name-btn" onClick={() => showCategoryDetail(category)} title="View category details">
                                <span className="todo-group-category-name">{category}</span>
                                <span className="todo-group-count text-xs text-muted">
                                  {directTasks.length + projects.reduce((sum, p) => sum + p.tasks.length, 0)}
                                </span>
                              </button>
                            </div>
                            {favorites && (
                              <button
                                className="todo-group-fav-btn"
                                onClick={(e) => { e.stopPropagation(); favorites.toggleFavoriteCategory(category); }}
                                title={favorites.isCategoryFavorite(category) ? 'Unfavorite category' : 'Favorite category'}
                              >
                                {favorites.isCategoryFavorite(category) ? '\u2605' : '\u2606'}
                              </button>
                            )}
                          </div>
                        )}
                      </DroppableHeader>
                      {!isCategoryCollapsed(category) && (
                        <>
                          <SortableContext items={directTasks.filter((t) => !isChildHidden(t.id)).map((t) => t.id)} strategy={verticalListSortingStrategy}>
                            {directTasks.map((task) => {
                              if (isChildHidden(task.id)) return null;
                              return (
                                <SortableTaskItem
                                  key={task.id}
                                  task={task}
                                  isFocused={focusedTaskId === task.id}
                                  isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                  depth={depthMap.get(task.id) ?? 0}
                                  childCount={trueChildCountMap.get(task.id)}
                                  isExpanded={expandedParents.has(task.id)}
                                  onToggleExpand={() => toggleParentExpand(task.id)}
                                  onClick={() => handleTaskClick(task)}
                                  onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                                  onStar={onStar}
                                  onSetPriority={onSetPriority}
                                  onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                  onOpenSession={onOpenSession}
                                  openSessionIds={openSessionIds}
                                  onExpandDetail={handleExpandDetail}
                                  onClearFocus={onClearFocus}
                                  onPinTask={onPinTask}
                                  onUnpinTask={onUnpinTask}
                                  isPinned={pinnedTaskIds?.has(task.id)}
                                />
                              );
                            })}
                          </SortableContext>
                          <SortableContext items={projects.map((p) => `proj:${category}/${p.project}`)} strategy={verticalListSortingStrategy}>
                            {projects.map(({ project, tasks: projTasks }) => {
                              const projKey = `${category}/${project}`;
                              return (
                                <SortableGroupItem key={`proj:${projKey}`} id={`proj:${projKey}`}>
                                  {({ dragHandleProps: projDragProps }: { dragHandleProps: Record<string, unknown> }) => (
                                    <div className="todo-group-project">
                                      <DroppableHeader id={`hdr-proj:${category}/${project}`} category={category} project={project} disabled={activeDragType !== 'task'}>
                                        {({ isOver: isProjHeaderOver, setNodeRef: setProjHeaderRef }) => (
                                          <div ref={setProjHeaderRef} className={`todo-group-project-header${isProjHeaderOver ? ' header-drop-active' : ''}`} {...projDragProps}>
                                            <div className="todo-group-header-controls">
                                              <button className={`collapse-chevron${!isProjectCollapsed(projKey) ? ' expanded' : ''}`} onClick={(e) => { e.stopPropagation(); toggleProject(projKey); }} title="Collapse/Expand">
                                                {CHEVRON_ICON}
                                              </button>
                                              <button className="todo-group-name-btn" onClick={() => showProjectDetail(category, project)} title="View project details">
                                                <span className="todo-group-project-name">{project}</span>
                                                <span className="todo-group-count text-xs text-muted">{projTasks.length}</span>
                                              </button>
                                            </div>
                                            {favorites && (
                                              <button
                                                className="todo-group-fav-btn"
                                                onClick={(e) => { e.stopPropagation(); favorites.toggleFavoriteProject(project); }}
                                                title={favorites.isProjectFavorite(project) ? 'Unfavorite project' : 'Favorite project'}
                                              >
                                                {favorites.isProjectFavorite(project) ? '\u2605' : '\u2606'}
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </DroppableHeader>
                                      {!isProjectCollapsed(projKey) && (
                                        <SortableContext items={projTasks.filter((t) => !isChildHidden(t.id)).map((t) => t.id)} strategy={verticalListSortingStrategy}>
                                          {projTasks.map((task) => {
                                            if (isChildHidden(task.id)) return null;
                                            return (
                                              <SortableTaskItem
                                                key={task.id}
                                                task={task}
                                                isFocused={focusedTaskId === task.id}
                                                isRecentlyDone={recentlyCompletedRef.current.has(task.id)}
                                                depth={depthMap.get(task.id) ?? 0}
                                                childCount={trueChildCountMap.get(task.id)}
                                                isExpanded={expandedParents.has(task.id)}
                                                onToggleExpand={() => toggleParentExpand(task.id)}
                                                onClick={() => handleTaskClick(task)}
                                                onSetPhase={onSetPhase ?? ((id) => onComplete(id))}
                                                onStar={onStar}
                                                onSetPriority={onSetPriority}
                                                onUpdateTitle={onUpdate ? handleUpdateTitle : undefined}
                                                onOpenSession={onOpenSession}
                                                openSessionIds={openSessionIds}
                                                onExpandDetail={handleExpandDetail}
                                                onClearFocus={onClearFocus}
                                                onPinTask={onPinTask}
                                                onUnpinTask={onUnpinTask}
                                                isPinned={pinnedTaskIds?.has(task.id)}
                                              />
                                            );
                                          })}
                                        </SortableContext>
                                      )}
                                    </div>
                                  )}
                                </SortableGroupItem>
                              );
                            })}
                          </SortableContext>
                        </>
                      )}
                    </div>
                  )}
                </SortableGroupItem>
              ))}
            </SortableContext>

            <DragOverlay
              modifiers={activeDragType === 'category-group' || activeDragType === 'project-group' ? [snapToCursor] : undefined}
            >
              {activeDragType === 'category-group' && activeDragId ? (
                <div className="drag-overlay-group">
                  {activeDragId.replace('cat:', '')}
                </div>
              ) : activeDragType === 'project-group' && activeDragId ? (
                <div className="drag-overlay-group drag-overlay-group-project">
                  {activeDragId.replace(/^proj:[^/]+\//, '')}
                </div>
              ) : draggedTask ? (
                <TaskItemOverlay task={draggedTask} />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Detail pane: task, project, or category */}
      {((focusedTask && !suppressDetail) || detailTarget) && <div className="todo-detail-splitter" onMouseDown={splitterMouseDown} />}
      {focusedTask && !suppressDetail ? (
        <TaskDetailPane task={focusedTask} allTasks={tasks} onClose={onClearFocus} onOpenSession={onOpenSession} onOpenTriageForTask={onOpenTriageForTask} onFocusChild={onFocusTask} style={{ flex: `${detailRatio} 1 0%` }} />
      ) : detailTarget?.type === 'project' ? (
        <ProjectDetailPane
          category={detailTarget.category}
          project={detailTarget.project}
          tasks={tasks}
          onClose={() => setDetailTarget(null)}
          style={{ flex: `${detailRatio} 1 0%` }}
        />
      ) : detailTarget?.type === 'category' ? (
        <CategoryDetailPane
          category={detailTarget.category}
          tasks={tasks}
          onClose={() => setDetailTarget(null)}
          onShowProject={(cat, proj) => setDetailTarget({ type: 'project', category: cat, project: proj })}
          style={{ flex: `${detailRatio} 1 0%` }}
        />
      ) : null}

      {operationError && (
        <div className="todo-panel-add-error" role="alert">
          {operationError}
          {onClearOperationError && <button className="todo-panel-error-dismiss" onClick={onClearOperationError} aria-label="Dismiss">&times;</button>}
        </div>
      )}
      <form className="todo-panel-add" onSubmit={handleAdd}>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Quick add task..."
          aria-label="New task title"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!newTitle.trim()}>
          Add
        </button>
      </form>
      <GlobalNotesSection
        {...globalNotes}
        tasks={tasks}
        focusedTaskId={focusedTaskId ?? undefined}
        onTaskClick={(taskId) => {
          const task = tasks.find(t => t.id === taskId);
          if (task) handleTaskClick(task);
        }}
      />
    </div>
  );
});

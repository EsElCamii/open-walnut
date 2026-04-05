/**
 * TaskKebabMenu — "⋮" dropdown menu for task row actions.
 *
 * Consolidates: source badge, external link, details, priority, star, pin
 * into a single kebab button to reduce visual noise per task row.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Task, TaskPriority } from '@walnut/core';
import type { FocusTier } from '@/api/focus';
import * as ICONS from '../common/Icons';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { resolveTaskSessionId } from '@/utils/session-status';

interface TaskKebabMenuProps {
  task: Task;
  isFocused: boolean;
  isPinned: boolean;
  pinnedTier?: FocusTier;
  isDone: boolean;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onSetPriority?: (id: string, priority: string) => void;
  onStar?: (id: string) => void;
  onPinTask?: (id: string) => void;
  onUnpinTask?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  onOpenSession?: (sessionId: string) => void;
}

const TIER_OPTIONS: { value: FocusTier; label: string; icon: string }[] = [
  { value: 'focus', label: 'Focus', icon: '●' },
  { value: 'next', label: 'Next', icon: '●' },
  { value: 'satellite', label: 'Satellite', icon: '○' },
];

const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  next: '#FF9500',
  satellite: 'var(--fg-muted)',
};

const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

export function TaskKebabMenu({ task, isFocused, isPinned, pinnedTier, isDone, onExpandDetail, onClearFocus, onSetPriority, onStar, onPinTask, onUnpinTask, onSetTier, onOpenSession }: TaskKebabMenuProps) {
  const integrations = useIntegrations();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, closeMenu]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
    }
    setOpen(!open);
  };

  // Source badge info
  const sourceMeta = task.source ? getIntegrationMeta(integrations, task.source) : null;
  const badge = task.source === 'local' ? 'L' : (sourceMeta?.badge ?? task.source?.charAt(0).toUpperCase());
  const integrationName = task.source === 'local' ? 'Local' : (sourceMeta?.name ?? task.source);
  const badgeColor = sourceMeta?.badgeColor;
  const synced = task.source && task.source !== 'local' && (!!task.ext?.[task.source] || !!((task as unknown as Record<string, unknown>)[({ 'ms-todo': 'ms_todo_id' } as Record<string, string>)[task.source] ?? '']));

  return (
    <div className="task-kebab-wrapper">
      <button
        ref={btnRef}
        className="task-kebab-btn"
        onClick={handleToggle}
        title="More actions"
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPos ? { position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 } : undefined}
        >
          {/* Session status */}
          {(() => {
            const sessionId = resolveTaskSessionId(task);
            const ss = task.session_status;
            if (!sessionId && !ss) return null;
            const isRunning = ss?.process_status === 'running';
            const isError = ss?.process_status === 'error';
            const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
            const color = isError || needsAttention ? 'var(--error)' : isRunning ? 'var(--success)' : 'var(--fg-muted)';
            const label = isRunning ? 'AI is working...' : isError ? 'Session error' : needsAttention ? 'Needs your attention' : 'Session idle';
            return (
              <button
                className="task-kebab-item"
                onClick={(e) => {
                  e.stopPropagation();
                  if (sessionId && onOpenSession) { onOpenSession(sessionId); closeMenu(); }
                }}
              >
                <span className="task-kebab-icon" style={{ color }}>●</span>
                <span>{label}</span>
              </button>
            );
          })()}

          {/* Source badge */}
          {task.source && (
            <div className="task-kebab-item task-kebab-info">
              <span
                className="task-source-badge"
                style={!task.sync_error && badgeColor ? { background: badgeColor, color: 'white' } : task.source === 'local' ? { background: '#8E8E93', color: 'white' } : undefined}
              >
                {task.sync_error ? '!' : badge}
              </span>
              <span>{integrationName}{task.sync_error ? ' (sync error)' : synced ? '' : task.source !== 'local' ? ' (unsynced)' : ''}</span>
            </div>
          )}

          {/* External link */}
          {task.external_url && (() => {
            const meta = getIntegrationMeta(integrations, task.source);
            const label = meta?.externalLinkLabel ?? meta?.name ?? 'external';
            return (
              <a
                className="task-kebab-item"
                href={task.external_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.stopPropagation(); closeMenu(); }}
              >
                <span className="task-kebab-icon">↗</span>
                <span>Open in {label}</span>
              </a>
            );
          })()}

          {(task.source || task.external_url) && <div className="task-kebab-divider" />}

          {/* Details */}
          <button
            className={`task-kebab-item${isFocused ? ' task-kebab-item-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (isFocused) onClearFocus?.();
              else onExpandDetail?.(task);
              closeMenu();
            }}
          >
            <span className="task-kebab-icon">{ICONS.ICON_INFO}</span>
            <span>{isFocused ? 'Close details' : 'Details'}</span>
          </button>

          {/* Star */}
          {onStar && (
            <button
              className={`task-kebab-item${task.starred ? ' task-kebab-item-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onStar(task.id);
                closeMenu();
              }}
            >
              <span className="task-kebab-icon">{task.starred ? ICONS.ICON_STAR_FILLED : ICONS.ICON_STAR_EMPTY}</span>
              <span>{task.starred ? 'Unstar' : 'Star'}</span>
            </button>
          )}

          {/* Pin / Tier */}
          {!isDone && (onPinTask || isPinned) && (
            <>
              <div className="task-kebab-divider" />
              {isPinned && onUnpinTask && (
                <button
                  className="task-kebab-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnpinTask(task.id);
                    closeMenu();
                  }}
                >
                  <span className="task-kebab-icon">{ICONS.ICON_PIN_FILLED}</span>
                  <span>Unpin</span>
                </button>
              )}
              <div className="task-kebab-tier">
                <span className="task-kebab-tier-label">{isPinned ? 'Move to' : 'Pin to'}</span>
                <div className="task-kebab-tier-options">
                  {TIER_OPTIONS.map((t) => (
                    <button
                      key={t.value}
                      className={`task-kebab-tier-btn${pinnedTier === t.value ? ' active' : ''}`}
                      style={{ color: TIER_COLORS[t.value] }}
                      title={t.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPinned) {
                          if (pinnedTier !== t.value) onSetTier?.(task.id, t.value);
                        } else {
                          onPinTask?.(task.id);
                          setTimeout(() => onSetTier?.(task.id, t.value), 100);
                        }
                        closeMenu();
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Priority */}
          {onSetPriority && (
            <>
              <div className="task-kebab-divider" />
              <div className="task-kebab-priority">
                <span className="task-kebab-priority-label">Priority</span>
                <div className="task-kebab-priority-options">
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.value}
                      className={`badge badge-${p.value}${task.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                      title={p.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (p.value !== task.priority) onSetPriority(task.id, p.value);
                        closeMenu();
                      }}
                    >
                      {p.icon}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

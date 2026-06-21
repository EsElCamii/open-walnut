import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import type { Editor } from '@tiptap/core';
import type { Task } from '@open-walnut/core';
import { ICON_COLLAPSE } from '@/components/common/Icons';

interface GlobalNotesPopupProps {
  content: string;
  onDirty: (editor: Editor) => void;
  saving: boolean;
  onClose: () => void;
  tasks?: Task[];
  focusedTaskId?: string;
  onTaskClick?: (taskId: string) => void;
}

export function GlobalNotesPopup({ content, onDirty, saving, onClose, tasks, focusedTaskId, onTaskClick }: GlobalNotesPopupProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  return createPortal(
    <div className="notes-popup-overlay" role="dialog" aria-modal="true" aria-label="Global Notes" onClick={onClose}>
      <div className="notes-popup-container" onClick={e => e.stopPropagation()}>
        <div className="notes-popup-header">
          <span className="notes-popup-title">Global Notes</span>
          <div className="notes-popup-actions">
            {saving && <span className="notes-popup-saving">Saving...</span>}
            <button className="notes-popup-close" onClick={onClose} aria-label="Collapse notes" title="Collapse notes">{ICON_COLLAPSE}</button>
          </div>
        </div>
        <div className="notes-popup-body">
          {/* saveStatus idle — the popup header already shows its own "Saving…"
              next to the collapse button, so we don't duplicate it in the shell. */}
          <MarkdownEditorPanel
            content={content}
            onEditorUpdate={onDirty}
            saveStatus="idle"
            docId="notes/global"
            autoFocus
            enableBlockTools
            showWidthToggle
            tasks={tasks}
            focusedTaskId={focusedTaskId}
            onTaskClick={onTaskClick}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * WikiLink Autocomplete popup — shows note suggestions when user types [[.
 * Positioned near the cursor, navigated via keyboard.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { WikiLinkState } from './WikiLinkExtension';
import type { NoteListItem } from '@/api/notes-v2';

interface WikiLinkAutocompleteProps {
  editor: Editor;
  state: WikiLinkState & { phase: 'searching' };
  notes: NoteListItem[];
  onClose: () => void;
  onSelect: (note: NoteListItem) => void;
  onCreateNew: (name: string) => void;
}

export function WikiLinkAutocomplete({
  editor,
  state,
  notes,
  onClose,
  onSelect,
  onCreateNew,
}: WikiLinkAutocompleteProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const rangeRef = useRef(state.range);
  rangeRef.current = state.range;

  // Filter notes by query
  const filtered = useMemo(() => {
    const q = state.query.toLowerCase().trim();
    if (!q) return notes.slice(0, 10);
    return notes
      .filter(n => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, 10);
  }, [notes, state.query]);

  // Reset selection when results change
  useEffect(() => { setSelectedIdx(0); }, [filtered]);

  // Position the popup
  useEffect(() => {
    try {
      const c = editor.view.coordsAtPos(state.range.from);
      const panelH = panelRef.current?.getBoundingClientRect().height || 200;
      const aboveTop = c.top - panelH - 4;
      const belowTop = c.bottom + 4;
      const top = aboveTop >= 0 ? aboveTop : belowTop;
      setCoords({ left: c.left, top });
    } catch {
      setCoords(null);
    }
  }, [editor, state.range.from, filtered]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.min(i + 1, filtered.length)); // +1 for "create new" option
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(i => Math.max(i - 1, 0));
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(selectedIdx);
        return;
      }
    };

    // The `true` flag registers in the capture phase, which fires before the
    // bubble phase. This is essential because ProseMirror consumes keyboard
    // events during the bubble phase; listening in the bubble phase would mean
    // our handler never receives ArrowUp/ArrowDown/Enter/Tab/Escape when the
    // editor is focused.
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selectedIdx, onClose]);

  // Click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const handleSelect = useCallback((idx: number) => {
    if (idx < filtered.length) {
      onSelect(filtered[idx]);
    } else {
      // "Create new" option
      const name = state.query.trim();
      if (name) onCreateNew(name);
    }
  }, [filtered, onSelect, onCreateNew, state.query]);

  if (!coords) return null;

  const showCreateOption = state.query.trim().length > 0 &&
    !filtered.some(n => n.name.toLowerCase() === state.query.trim().toLowerCase());

  return createPortal(
    <div
      ref={panelRef}
      className="notes-wikilink-panel"
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        zIndex: 10001,
      }}
    >
      {filtered.length === 0 && !showCreateOption ? (
        <div className="notes-wikilink-empty">No notes found</div>
      ) : (
        <>
          {filtered.map((note, i) => (
            <div
              key={note.path}
              className={`notes-wikilink-item ${i === selectedIdx ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { onSelect(note); }}
            >
              <span className="notes-wikilink-name">{note.name}</span>
              {note.path !== `${note.name}.md` && (
                <span className="notes-wikilink-path">{note.path.replace(/\.md$/, '')}</span>
              )}
            </div>
          ))}
          {showCreateOption && (
            <div
              className={`notes-wikilink-item notes-wikilink-create ${filtered.length === selectedIdx ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(filtered.length)}
              onClick={() => onCreateNew(state.query.trim())}
            >
              <span className="notes-wikilink-create-label">Create "{state.query.trim()}"</span>
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

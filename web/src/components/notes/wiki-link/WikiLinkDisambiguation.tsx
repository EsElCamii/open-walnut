/**
 * WikiLinkDisambiguation — a small centered picker shown when a clicked bare
 * `[[Title]]` resolves to MORE THAN ONE note (the Obsidian 'ambiguous' case,
 * §2.2). The user picks which target to open. Resolution keys on the target's
 * path (id is display-only here); we never silently mis-resolve.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { NoteListItem } from '@/api/notes-v2';

interface WikiLinkDisambiguationProps {
  /** The link text the user clicked. */
  target: string;
  /** The candidate notes that share this title/basename. */
  candidates: NoteListItem[];
  onPick: (note: NoteListItem) => void;
  onClose: () => void;
}

export function WikiLinkDisambiguation({ target, candidates, onPick, onClose }: WikiLinkDisambiguationProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const pick = useCallback(
    (idx: number) => {
      const note = candidates[idx];
      if (note) onPick(note);
    },
    [candidates, onPick],
  );

  // Keyboard: arrows to move, Enter to pick, Esc to close. Capture phase so the
  // editor's own keymap doesn't swallow the keys while it still holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.min(i + 1, candidates.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pick(selectedIdx);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [candidates.length, selectedIdx, pick, onClose]);

  return createPortal(
    <div className="notes-wikilink-disambig-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="notes-wikilink-disambig"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Choose a note named ${target}`}
      >
        <div className="notes-wikilink-disambig-header">
          Multiple notes named <strong>{target}</strong> — pick one:
        </div>
        <div className="notes-wikilink-disambig-list">
          {candidates.map((note, i) => (
            <button
              key={note.path}
              type="button"
              className={`notes-wikilink-disambig-item ${i === selectedIdx ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => pick(i)}
            >
              <span className="notes-wikilink-disambig-name">{note.title || note.name}</span>
              <span className="notes-wikilink-disambig-path">{note.path.replace(/\.md$/, '')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

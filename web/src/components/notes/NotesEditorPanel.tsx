import { useState, useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { NotesEditor } from './NotesEditor';
import { BacklinksPanel } from './BacklinksPanel';
import { fetchNotesList } from '@/api/notes-v2';
import type { NoteListItem } from '@/api/notes-v2';

interface NotesEditorPanelProps {
  notePath: string | null;
  content: string | null;
  updatedAt: string | null;
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  onEditorUpdate: (editor: Editor) => void;
  onNavigate: (path: string) => void;
}

export function NotesEditorPanel({
  notePath,
  content,
  updatedAt,
  saveStatus,
  onEditorUpdate,
  onNavigate,
}: NotesEditorPanelProps) {
  const [notesList, setNotesList] = useState<NoteListItem[]>([]);

  // Fetch all notes list for wiki link autocomplete
  useEffect(() => {
    fetchNotesList().then(setNotesList).catch(() => {});
  }, [notePath]); // Refresh when switching notes (might have created new ones)

  if (!notePath) {
    return (
      <div className="notes-editor-empty">
        <div className="notes-editor-empty-content">
          <NotepadIcon />
          <p>Select a note or create a new one</p>
        </div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="notes-editor-empty">
        <div className="notes-editor-empty-content">
          <p>Failed to load note</p>
        </div>
      </div>
    );
  }

  const displayName = notePath.replace(/\.md$/, '');
  const breadcrumb = displayName.split('/');

  return (
    <div className="notes-editor-panel">
      <div className="notes-editor-header">
        <div className="notes-editor-breadcrumb">
          {breadcrumb.map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="notes-breadcrumb-sep">/</span>}
              <span className={i === breadcrumb.length - 1 ? 'notes-breadcrumb-current' : 'notes-breadcrumb-parent'}>
                {part}
              </span>
            </span>
          ))}
        </div>
        <div className="notes-editor-meta">
          <SaveStatusIndicator status={saveStatus} />
          {updatedAt && (
            <span className="notes-editor-updated">
              {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <div className="notes-editor-content">
        <NotesEditor
          key={notePath}
          content={content}
          onDirty={onEditorUpdate}
          autoFocus
          placeholder="Start writing..."
          enableWikiLinks
          wikiLinkNotes={notesList}
          onWikiLinkClick={onNavigate}
        />
      </div>
      <BacklinksPanel notePath={notePath} onNavigate={onNavigate} />
    </div>
  );
}

function SaveStatusIndicator({ status }: { status: string }) {
  if (status === 'saving') return <span className="notes-save-status saving">Saving...</span>;
  if (status === 'saved') return <span className="notes-save-status saved">Saved</span>;
  if (status === 'error') return <span className="notes-save-status error">Save failed</span>;
  return null;
}

function NotepadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" opacity="0.3">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

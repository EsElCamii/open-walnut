import { useState, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useNotesTree } from '@/hooks/useNotesTree';
import { useNoteContent } from '@/hooks/useNoteContent';
import { NotesTreePanel } from '@/components/notes/NotesTreePanel';
import { NotesEditorPanel } from '@/components/notes/NotesEditorPanel';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const LS_WIDTH_KEY = 'open-walnut-notes-tree-width';
const WIDTH_MIN = 220;
const WIDTH_MAX = 500;
const WIDTH_DEFAULT = 280;

function clampWidth(w: number): number {
  return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, w));
}

function readWidth(): number {
  try {
    const stored = localStorage.getItem(LS_WIDTH_KEY);
    if (stored) return clampWidth(Number(stored));
  } catch { /* ignore */ }
  return WIDTH_DEFAULT;
}

export function NotesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tree, loading: treeLoading, error: treeError, refresh: refreshTree, addFolder, removeNote, renameNote } = useNotesTree();

  const [selectedPath, setSelectedPath] = useState<string | null>(() => searchParams.get('path'));
  const { content, loading: contentLoading, updatedAt, saveStatus, onEditorUpdate } = useNoteContent(selectedPath);

  // Resizable left pane
  const [listWidth, setListWidth] = useState(readWidth);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = listWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    listPaneRef.current?.classList.add('resizing');

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = clampWidth(startWidthRef.current + (ev.clientX - startXRef.current));
      setListWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      listPaneRef.current?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [listWidth]);

  useEffect(() => {
    try { localStorage.setItem(LS_WIDTH_KEY, String(listWidth)); } catch { /* ignore */ }
  }, [listWidth]);

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      setSearchParams({ path }, { replace: true });
    },
    [setSearchParams],
  );

  const handleCreateNote = useCallback(
    async (notePath: string) => {
      // Just select the path — the editor will create it on first save
      handleSelect(notePath);
      await refreshTree();
    },
    [handleSelect, refreshTree],
  );

  const handleDeleteNote = useCallback(
    async (notePath: string) => {
      await removeNote(notePath);
      if (selectedPath === notePath) {
        setSelectedPath(null);
        setSearchParams({}, { replace: true });
      }
    },
    [removeNote, selectedPath, setSearchParams],
  );

  const handleRenameNote = useCallback(
    async (from: string, to: string) => {
      await renameNote(from, to);
      if (selectedPath === from) {
        handleSelect(to);
      }
    },
    [renameNote, selectedPath, handleSelect],
  );

  // Auto-select from URL on initial load
  useEffect(() => {
    const urlPath = searchParams.get('path');
    if (urlPath && tree.length > 0 && !selectedPath) {
      handleSelect(urlPath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  if (treeLoading) return <LoadingSpinner />;
  if (treeError) return <div className="empty-state"><p>Error: {treeError}</p></div>;

  return (
    <div className="notes-split-view">
      <div
        className="notes-tree-pane"
        ref={listPaneRef}
        style={{ width: listWidth, flex: `0 0 ${listWidth}px` }}
      >
        <NotesTreePanel
          tree={tree}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onCreateNote={handleCreateNote}
          onCreateFolder={addFolder}
          onDeleteNote={handleDeleteNote}
          onRenameNote={handleRenameNote}
          onRefresh={refreshTree}
        />
      </div>
      <div className="notes-resize-handle" onMouseDown={handleResizeStart} />
      <div className="notes-editor-pane">
        {contentLoading ? (
          <LoadingSpinner />
        ) : (
          <NotesEditorPanel
            notePath={selectedPath}
            content={content}
            updatedAt={updatedAt}
            saveStatus={saveStatus}
            onEditorUpdate={onEditorUpdate}
            onNavigate={handleSelect}
          />
        )}
      </div>
    </div>
  );
}

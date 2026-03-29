import { useState, useCallback, useRef, useEffect } from 'react';
import { searchNotes, saveNoteContent } from '@/api/notes-v2';
import type { NoteTreeNode } from '@/api/notes-v2';

interface NotesTreePanelProps {
  tree: NoteTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCreateNote: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onDeleteNote: (path: string) => void;
  onRenameNote: (from: string, to: string) => void;
  onRefresh: () => void;
}

export function NotesTreePanel({
  tree,
  selectedPath,
  onSelect,
  onCreateNote,
  onCreateFolder,
  onDeleteNote,
  onRenameNote,
  onRefresh,
}: NotesTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ path: string; name: string; snippet: string }> | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'folder'>('file');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: NoteTreeNode } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Focus input when creating
  useEffect(() => {
    if (creatingIn !== null && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [creatingIn]);

  useEffect(() => {
    if (renaming !== null && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Cleanup search debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // Search handler with debounce
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!value.trim()) {
      setSearchResults(null);
      return;
    }

    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchNotes(value.trim());
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
    }, 300);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNewItem = useCallback((parentPath: string | null, type: 'file' | 'folder') => {
    setCreatingIn(parentPath ?? '');
    setNewItemType(type);
    setNewItemName('');
    // Expand parent folder
    if (parentPath) {
      setExpandedFolders(prev => new Set(prev).add(parentPath));
    }
  }, []);

  const handleConfirmNewItem = useCallback(async () => {
    const name = newItemName.trim();
    if (!name) { setCreatingIn(null); return; }

    const parentPath = creatingIn || '';
    const fullPath = parentPath ? `${parentPath}/${name}` : name;

    try {
      if (newItemType === 'folder') {
        await onCreateFolder(fullPath);
      } else {
        const notePath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;
        await saveNoteContent(notePath, '');
        onRefresh();
        onCreateNote(notePath);
      }
    } catch { /* silently fail, tree will refresh */ }
    setCreatingIn(null);
    setNewItemName('');
  }, [newItemName, creatingIn, newItemType, onCreateFolder, onCreateNote, onRefresh]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: NoteTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleStartRename = useCallback((node: NoteTreeNode) => {
    setRenaming(node.path);
    setRenameValue(node.name.replace(/\.md$/, ''));
    setContextMenu(null);
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) { setRenaming(null); return; }

    const dir = renaming.includes('/') ? renaming.substring(0, renaming.lastIndexOf('/')) : '';
    const oldName = renaming;
    const newName = renameValue.trim();
    const newPath = dir ? `${dir}/${newName}.md` : `${newName}.md`;

    if (newPath !== oldName) {
      await onRenameNote(oldName, newPath);
    }
    setRenaming(null);
  }, [renaming, renameValue, onRenameNote]);

  const handleDeleteFromMenu = useCallback(() => {
    if (!contextMenu) return;
    const { node } = contextMenu;
    setContextMenu(null);
    if (confirm(`Delete "${node.name}"?`)) {
      onDeleteNote(node.path);
    }
  }, [contextMenu, onDeleteNote]);

  // Render tree node recursively
  const renderNode = (node: NoteTreeNode, depth: number = 0) => {
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedPath === node.path;
    const isRenaming = renaming === node.path;

    if (node.type === 'folder') {
      return (
        <div key={node.path}>
          <div
            className={`notes-tree-item notes-tree-folder depth-${depth}`}
            onClick={() => toggleFolder(node.path)}
            onContextMenu={(e) => handleContextMenu(e, node)}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            <span className={`notes-tree-arrow ${isExpanded ? 'expanded' : ''}`}>
              <ChevronIcon />
            </span>
            <FolderIcon />
            <span className="notes-tree-name">{node.name}</span>
          </div>
          {isExpanded && node.children && (
            <div className="notes-tree-children">
              {creatingIn === node.path && renderNewItemInput(depth + 1)}
              {node.children.map(child => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={`notes-tree-item notes-tree-file depth-${depth} ${isSelected ? 'selected' : ''}`}
        onClick={() => !isRenaming && onSelect(node.path)}
        onContextMenu={(e) => handleContextMenu(e, node)}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <FileIcon />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="notes-tree-inline-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={handleConfirmRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="notes-tree-name">{node.name.replace(/\.md$/, '')}</span>
        )}
      </div>
    );
  };

  const renderNewItemInput = (depth: number) => (
    <div
      className={`notes-tree-item notes-tree-new-item depth-${depth}`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      {newItemType === 'folder' ? <FolderIcon /> : <FileIcon />}
      <input
        ref={newItemInputRef}
        className="notes-tree-inline-input"
        placeholder={newItemType === 'folder' ? 'folder name' : 'note name'}
        value={newItemName}
        onChange={e => setNewItemName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleConfirmNewItem();
          if (e.key === 'Escape') setCreatingIn(null);
        }}
        onBlur={handleConfirmNewItem}
      />
    </div>
  );

  return (
    <div className="notes-tree-panel">
      <div className="notes-tree-header">
        <h3>Notes</h3>
        <div className="notes-tree-actions">
          <button
            className="notes-tree-action-btn"
            onClick={() => handleNewItem(null, 'file')}
            title="New Note"
          >
            <PlusFileIcon />
          </button>
          <button
            className="notes-tree-action-btn"
            onClick={() => handleNewItem(null, 'folder')}
            title="New Folder"
          >
            <PlusFolderIcon />
          </button>
        </div>
      </div>

      <div className="notes-tree-search">
        <input
          type="text"
          placeholder="Search notes..."
          value={searchQuery}
          onChange={e => handleSearchChange(e.target.value)}
          className="notes-search-input"
        />
      </div>

      <div className="notes-tree-body">
        {searchResults ? (
          <div className="notes-search-results">
            {searchResults.length === 0 ? (
              <div className="notes-tree-empty">No results</div>
            ) : (
              searchResults.map(r => (
                <div
                  key={r.path}
                  className={`notes-tree-item notes-tree-file notes-search-result ${selectedPath === r.path ? 'selected' : ''}`}
                  onClick={() => { onSelect(r.path); setSearchQuery(''); setSearchResults(null); }}
                >
                  <FileIcon />
                  <div className="notes-search-result-content">
                    <span className="notes-tree-name">{r.name}</span>
                    <span className="notes-search-snippet">{r.snippet}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {creatingIn === '' && renderNewItemInput(0)}
            {tree.length === 0 ? (
              <div className="notes-tree-empty">
                No notes yet. Click + to create one.
              </div>
            ) : (
              tree.map(node => renderNode(node, 0))
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="notes-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node.type === 'folder' && (
            <>
              <button onClick={() => { handleNewItem(contextMenu.node.path, 'file'); setContextMenu(null); }}>
                New Note
              </button>
              <button onClick={() => { handleNewItem(contextMenu.node.path, 'folder'); setContextMenu(null); }}>
                New Folder
              </button>
            </>
          )}
          {contextMenu.node.type === 'file' && (
            <>
              <button onClick={() => handleStartRename(contextMenu.node)}>Rename</button>
              <button className="danger" onClick={handleDeleteFromMenu}>Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inline SVG Icons ────────────────────────────────────────────────────

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" className="notes-tree-icon">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function PlusFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function PlusFolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

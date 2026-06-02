/**
 * FileMentionPopup — Claude-Code-style "@" file reference picker.
 *
 * A mini VS Code browser shown above the chat input when the user types "@".
 * Left: single-level listing of the current browse dir (dirs first, then files),
 * filtered by the text typed after "@". Right: inline preview of the selected
 * file (FileContentView). Local + remote (daemon) via /api/files/list.
 *
 * Keyboard is driven by the parent ChatInput through the imperative handle:
 *   move(±1)       — change selection
 *   enter()        — dir → navigate into it; file → select it
 *   selectCurrent()— Cmd/Ctrl+Enter: select current item regardless of type
 * Navigation (enter into dir / go up) is internal; selection returns an
 * absolute path via onSelect (the chat input inserts it as an "@" ref).
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { FileContentView } from '@/components/common/FileContentView';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';

export interface FileMentionHandle {
  /** Move selection by delta (wraps). */
  move: (delta: number) => void;
  /** Enter: dir → navigate into it; file → select it. */
  enter: () => void;
  /** Cmd/Ctrl+Enter: select current item (file or dir) regardless of type. */
  selectCurrent: () => void;
}

interface FileMentionPopupProps {
  /** Root directory the browse starts from (session cwd or quick-start cwd). */
  cwd: string;
  /** SSH host (undefined = local). */
  host?: string;
  /** Text typed after "@" — filters the current dir listing. */
  query: string;
  /** Called when the user selects a file or folder. Path is absolute (avoids
   *  ambiguity about what a relative ref would resolve against). */
  onSelect: (absPath: string) => void;
  onClose: () => void;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Path of `full` relative to `base`; falls back to `full` if not under base. */
function relativeTo(base: string, full: string): string {
  const b = base.replace(/\/+$/, '');
  if (full === b) return '.';
  if (full.startsWith(b + '/')) return full.slice(b.length + 1);
  return full;
}

export const FileMentionPopup = forwardRef<FileMentionHandle, FileMentionPopupProps>(
  function FileMentionPopup({ cwd, host, query, onSelect, onClose }, ref) {
    // The canonical root resolved by the backend (~ → absolute). Selection paths
    // are computed relative to this so inserted refs are short + portable.
    const [rootPath, setRootPath] = useState<string>(cwd);
    const [browseDir, setBrowseDir] = useState<string>(cwd);
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [previewFile, setPreviewFile] = useState<string | null>(null);

    const listRef = useRef<HTMLDivElement>(null);
    const inFlightRef = useRef<string | null>(null);

    const loadDir = useCallback(
      async (dirPath: string, opts: { isRoot?: boolean } = {}) => {
        if (inFlightRef.current === dirPath) return;
        inFlightRef.current = dirPath;
        setLoading(true);
        setError(null);
        try {
          const res = await fetchDirList(dirPath, host, false);
          // Drop stale responses: a faster navigation to another dir may have
          // superseded this load. Last-write-wins on the in-flight token, not on
          // response arrival order (FileContentView guards its own fetch the same way).
          if (inFlightRef.current !== dirPath) return;
          // Backend resolves ~ → absolute; adopt it so child/selection paths are absolute.
          const canonical = res.path || dirPath;
          setBrowseDir(canonical);
          if (opts.isRoot) setRootPath(canonical);
          setEntries(res.entries);
          // If the requested path was a file, the backend listed its parent and
          // flagged the file — pre-select it so the right pane previews it.
          const fileIdx = res.selectedFile
            ? res.entries.findIndex((e) => e.name === res.selectedFile && e.type === 'file')
            : -1;
          setSelectedIndex(fileIdx >= 0 ? fileIdx : 0);
          setPreviewFile(null);
        } catch (err) {
          if (inFlightRef.current !== dirPath) return;
          const msg = err instanceof Error ? err.message : String(err);
          log.error('file-mention', 'failed to list dir', { dirPath, host, error: msg });
          setError(msg);
          setEntries([]);
        } finally {
          if (inFlightRef.current === dirPath) {
            inFlightRef.current = null;
            setLoading(false);
          }
        }
      },
      [host],
    );

    // (Re)load from the root whenever the session context (cwd/host) changes.
    // Guard empty cwd (session still loading) so we don't hit the backend with "".
    useEffect(() => {
      if (!cwd) { setError('No working directory'); setLoading(false); return; }
      setRootPath(cwd);
      setBrowseDir(cwd);
      void loadDir(cwd, { isRoot: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd, host]);

    // Filter current dir by the "@query" text (case-insensitive prefix > contains).
    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return entries;
      const starts: DirEntry[] = [];
      const contains: DirEntry[] = [];
      for (const e of entries) {
        const n = e.name.toLowerCase();
        if (n.startsWith(q)) starts.push(e);
        else if (n.includes(q)) contains.push(e);
      }
      return [...starts, ...contains];
    }, [entries, query]);

    // Reset selection to the top whenever the query changes — the result set can
    // reorder (prefix vs contains buckets) at the same length, so clamping on
    // length alone would silently leave the highlight on a different item.
    useEffect(() => {
      setSelectedIndex(0);
    }, [query]);

    // Preview the selected file (skip dirs).
    useEffect(() => {
      const item = filtered[selectedIndex];
      if (item && item.type === 'file') setPreviewFile(joinPath(browseDir, item.name));
      else setPreviewFile(null);
    }, [filtered, selectedIndex, browseDir]);

    // Scroll selection into view.
    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      const el = list.children[selectedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const enterDir = useCallback(
      (dirPath: string) => {
        void loadDir(dirPath);
      },
      [loadDir],
    );

    const goUp = useCallback(() => {
      const parent = parentPath(browseDir);
      if (parent !== browseDir) void loadDir(parent);
    }, [browseDir, loadDir]);

    // Editable path: click the breadcrumb to type an absolute path and jump there.
    const [editingPath, setEditingPath] = useState(false);
    const commitPath = useCallback((raw: string) => {
      const next = raw.trim();
      setEditingPath(false);
      if (next && next !== browseDir) void loadDir(next);
    }, [browseDir, loadDir]);

    const selectEntry = useCallback(
      (entry: DirEntry) => {
        onSelect(joinPath(browseDir, entry.name));
      },
      [browseDir, onSelect],
    );

    useImperativeHandle(
      ref,
      (): FileMentionHandle => ({
        move: (delta) => {
          setSelectedIndex((i) => {
            const n = filtered.length;
            if (n === 0) return 0;
            return (i + delta + n) % n;
          });
        },
        enter: () => {
          const item = filtered[selectedIndex];
          if (!item) return;
          if (item.type === 'dir') enterDir(joinPath(browseDir, item.name));
          else selectEntry(item);
        },
        selectCurrent: () => {
          const item = filtered[selectedIndex];
          if (item) selectEntry(item);
        },
      }),
      [filtered, selectedIndex, browseDir, enterDir, selectEntry],
    );

    const atRoot = browseDir === rootPath;

    return (
      <div className="file-mention-popup">
        <div className="file-mention-toolbar">
          <button
            className="fmp-btn"
            onMouseDown={(e) => { e.preventDefault(); goUp(); }}
            disabled={browseDir === '/'}
            title="Go to parent directory"
          >
            ↑
          </button>
          {editingPath ? (
            <input
              className="fmp-breadcrumb-input"
              defaultValue={browseDir}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                e.stopPropagation(); // don't let popup keyboard nav intercept typing
                if (e.key === 'Enter') { e.preventDefault(); commitPath((e.target as HTMLInputElement).value); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingPath(false); }
              }}
              onBlur={(e) => commitPath(e.target.value)}
            />
          ) : (
            <span
              className="fmp-breadcrumb"
              title={`${browseDir} — click to edit`}
              onMouseDown={(e) => { e.preventDefault(); setEditingPath(true); }}
            >
              {atRoot ? browseDir : relativeTo(rootPath, browseDir)}
            </span>
          )}
          <button
            className="fmp-btn fmp-close"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            title="Close (Esc)"
          >
            &times;
          </button>
        </div>

        <div className="file-mention-body">
          <div className="file-mention-list" ref={listRef}>
            {error && <div className="fmp-error">{error}</div>}
            {!error && loading && <div className="fmp-loading">Loading…</div>}
            {!error && !loading && filtered.length === 0 && (
              <div className="fmp-empty">No matches</div>
            )}
            {!error &&
              filtered.map((entry, i) => (
                <div
                  key={`${entry.type}:${entry.name}`}
                  className={`file-mention-item${i === selectedIndex ? ' selected' : ''}`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (entry.type === 'dir') enterDir(joinPath(browseDir, entry.name));
                    else selectEntry(entry);
                  }}
                  title={joinPath(browseDir, entry.name)}
                >
                  <span className="fmp-icon">{entry.type === 'dir' ? '📁' : '📄'}</span>
                  <span className="fmp-name">{entry.name}</span>
                  {entry.type === 'dir' && <span className="fmp-into">→</span>}
                  {entry.type === 'file' && entry.size != null && (
                    <span className="fmp-size">{formatSize(entry.size)}</span>
                  )}
                  {/* Select-this affordance: works for both files and dirs */}
                  <button
                    className="fmp-pick"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); selectEntry(entry); }}
                    title="Select this (⌘⏎)"
                  >
                    ⏎
                  </button>
                </div>
              ))}
          </div>

          <div className="file-mention-preview">
            {previewFile ? (
              <FileContentView key={previewFile} path={previewFile} host={host} />
            ) : (
              <div className="fmp-preview-empty">
                {filtered[selectedIndex]?.type === 'dir'
                  ? 'Folder — ⏎ to open, ⌘⏎ to select'
                  : 'Select a file to preview'}
              </div>
            )}
          </div>
        </div>

        <div className="file-mention-hint">
          <span>↑↓ navigate</span>
          <span>⏎ open dir / pick file</span>
          <span>⌘⏎ select</span>
          <span>esc close</span>
        </div>
      </div>
    );
  },
);

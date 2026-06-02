/**
 * SessionFileExplorer — VS Code-style two-pane file browser for a session.
 *
 * Left:  lazy-loaded, in-place expandable directory tree rooted at the
 *        session cwd. Local + remote (daemon) both supported via /api/files/list.
 * Right: inline file content preview (FileContentView, syntax-highlight + line numbers).
 *
 * Expanded-dir state persists in localStorage, keyed per host + resolved root.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { fetchDirList, type DirEntry } from '@/api/files';
import { FileContentView } from '@/components/common/FileContentView';
import { formatSize } from '@/utils/format';
import { log } from '@/utils/log';

interface SessionFileExplorerProps {
  cwd?: string;
  host?: string;
  /** Line to highlight/scroll-to in the initially-selected file's preview. */
  initialLine?: number;
}

interface TreeNode {
  path: string;
  name: string;
  type: 'dir' | 'file';
  size?: number;
  depth: number;
}

const LS_EXPANDED = 'open-walnut-file-explorer-expanded';

function lsKeyFor(host: string | undefined, root: string): string {
  return `${LS_EXPANDED}:${host ?? 'local'}:${root}`;
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

export function SessionFileExplorer({ cwd, host, initialLine }: SessionFileExplorerProps) {
  const [root, setRoot] = useState<string>(cwd || '~');
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, DirEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  // toggleDir must persist to the CURRENT root's localStorage key, but we don't
  // want it re-created every time `root` changes (~ → absolute resolution). A ref
  // mirror lets the stable callback read the latest key without taking it as a dep.
  const lsKeyRef = useRef(lsKeyFor(host, root));
  lsKeyRef.current = lsKeyFor(host, root);

  // Mirror of loaded-dir keys + in-flight set, read inside callbacks/effects
  // without adding them as deps (avoids needless callback churn / stale resets).
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadDir = useCallback(async (
    dirPath: string,
    opts: { isRoot?: boolean; restoreExpanded?: boolean } = {},
  ): Promise<void> => {
    const { isRoot = false, restoreExpanded = false } = opts;
    // Dedupe concurrent loads of the same dir (rapid double-clicks, overlapping refetch)
    if (inFlightRef.current.has(dirPath)) return;
    inFlightRef.current.add(dirPath);
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    setErrorPaths((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
    try {
      const res = await fetchDirList(dirPath, host, showHidden);
      // Backend resolves ~ → absolute path and returns it; adopt it as the canonical
      // root so localStorage keys and child paths are all absolute (keeps the
      // persisted expand-state key stable instead of split between ~ and /abs).
      const canonical = isRoot && res.path ? res.path : dirPath;
      setChildrenMap((prev) => new Map(prev).set(canonical, res.entries));
      if (isRoot) {
        if (canonical !== root) setRoot(canonical);
        setRootError(null);
        if (restoreExpanded) {
          try {
            const raw = localStorage.getItem(lsKeyFor(host, canonical));
            setExpanded(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
          } catch { setExpanded(new Set()); }
        }
        // If the user typed a file path, the backend listed its parent and flagged
        // the file — open it in the preview pane (VS Code style).
        if (res.selectedFile) setSelectedFile(joinPath(canonical, res.selectedFile));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('file-explorer', 'failed to list dir', { dirPath, host, error: msg });
      if (isRoot) setRootError(msg);
      else setErrorPaths((prev) => new Map(prev).set(dirPath, msg));
    } finally {
      inFlightRef.current.delete(dirPath);
      setLoadingPaths((prev) => { const next = new Set(prev); next.delete(dirPath); return next; });
    }
  }, [host, showHidden, root]);

  // Full reset + load root only when the session (cwd/host) changes — NOT when
  // showHidden flips (that's handled below without nuking expand/selection state).
  // loadDir is intentionally omitted: it changes with showHidden, which must not reset.
  useEffect(() => {
    const initialRoot = cwd || '~';
    setRoot(initialRoot);
    setChildrenMap(new Map());
    setErrorPaths(new Map());
    setSelectedFile(null);
    setExpanded(new Set()); // re-restored in loadDir once the root resolves to absolute
    void loadDir(initialRoot, { isRoot: true, restoreExpanded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, host]);

  // Toggling hidden files refetches in place, preserving expansion + selection
  // (VS Code keeps your tree open). Skip the initial mount (reset effect already loaded).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    for (const p of childrenMapRef.current.keys()) {
      void loadDir(p, { isRoot: p === root });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  const toggleDir = useCallback((node: TreeNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        next.delete(node.path);
      } else {
        next.add(node.path);
        if (!childrenMapRef.current.has(node.path)) void loadDir(node.path);
      }
      try { localStorage.setItem(lsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
  }, [loadDir]);

  // Flatten the expanded tree into visible rows (DFS). Memoized so unrelated
  // re-renders (hover/selection/loading) don't re-walk the whole tree.
  const rows = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (dirPath: string, depth: number) => {
      const entries = childrenMap.get(dirPath);
      if (!entries) return;
      for (const e of entries) {
        const full = joinPath(dirPath, e.name);
        out.push({ path: full, name: e.name, type: e.type, size: e.size, depth });
        if (e.type === 'dir' && expanded.has(full)) walk(full, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, childrenMap, expanded]);

  const goUp = useCallback(() => {
    const parent = parentPath(root);
    if (parent !== root) {
      setChildrenMap(new Map());
      setSelectedFile(null);
      void loadDir(parent, { isRoot: true, restoreExpanded: true });
    }
  }, [root, loadDir]);

  const handleRefresh = useCallback(() => {
    // Refetch root + every loaded dir so expanded subtrees keep their children.
    const loaded = [...childrenMapRef.current.keys()];
    setChildrenMap(new Map());
    if (loaded.length === 0) { void loadDir(root, { isRoot: true }); return; }
    for (const p of loaded) void loadDir(p, { isRoot: p === root });
  }, [root, loadDir]);

  // Editable root path: click to type an absolute path and jump there.
  const [editingPath, setEditingPath] = useState(false);

  const commitPath = useCallback((raw: string) => {
    const next = raw.trim();
    setEditingPath(false);
    if (!next || next === root) return;
    setChildrenMap(new Map());
    setSelectedFile(null);
    void loadDir(next, { isRoot: true, restoreExpanded: true });
  }, [root, loadDir]);

  return (
    <div className="session-file-explorer">
      <div className="session-file-explorer-toolbar">
        <button className="sfe-btn" onClick={goUp} title="Go to parent directory">↑</button>
        {editingPath ? (
          <input
            className="sfe-root-path-input"
            defaultValue={root}
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitPath((e.target as HTMLInputElement).value); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditingPath(false); }
            }}
            onBlur={(e) => commitPath(e.target.value)}
          />
        ) : (
          <span
            className="sfe-root-path"
            title={`${root} — click to edit`}
            onClick={() => setEditingPath(true)}
          >
            {root}
          </span>
        )}
        <div className="sfe-toolbar-actions">
          <button className="sfe-btn" onClick={handleRefresh} title="Refresh">⟳</button>
          <label className="sfe-hidden-toggle" title="Show hidden files">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>Hidden</span>
          </label>
        </div>
      </div>

      <div className="session-file-explorer-body">
        <div className="session-file-explorer-tree">
          {rootError && <div className="sfe-error">{rootError}</div>}
          {!rootError && loadingPaths.has(root) && childrenMap.size === 0 && (
            <div className="sfe-loading">Loading…</div>
          )}
          {!rootError && childrenMap.has(root) && rows.length === 0 && (
            <div className="sfe-empty">Empty directory</div>
          )}
          {rows.map((node) => {
            const isExpanded = expanded.has(node.path);
            const isSelected = node.type === 'file' && selectedFile === node.path;
            const isLoading = loadingPaths.has(node.path);
            const err = errorPaths.get(node.path);
            return (
              <div key={node.path}>
                <div
                  className={`session-file-explorer-node${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                  onClick={() => node.type === 'dir' ? toggleDir(node) : setSelectedFile(node.path)}
                  title={node.path}
                >
                  <span className="sfe-arrow">
                    {node.type === 'dir' ? (isLoading ? '…' : isExpanded ? '▼' : '▶') : ''}
                  </span>
                  <span className="sfe-icon">{node.type === 'dir' ? '📁' : '📄'}</span>
                  <span className="sfe-name">{node.name}</span>
                  {/* size is local-only — daemon fs.ls returns just {name,type} for remote */}
                  {node.type === 'file' && node.size != null && (
                    <span className="sfe-size">{formatSize(node.size)}</span>
                  )}
                </div>
                {err && (
                  <div className="sfe-error" style={{ paddingLeft: `${8 + (node.depth + 1) * 14}px` }}>{err}</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="session-file-explorer-preview">
          {selectedFile ? (
            <FileContentView
              key={selectedFile}
              path={selectedFile}
              host={host}
              line={selectedFile === cwd ? initialLine : undefined}
            />
          ) : (
            <div className="sfe-preview-empty">Select a file to preview</div>
          )}
        </div>
      </div>
    </div>
  );
}

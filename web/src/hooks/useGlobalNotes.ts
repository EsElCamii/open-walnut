import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import type { Editor } from '@tiptap/core';

export interface UseGlobalNotesReturn {
  content: string;
  onEditorUpdate: (editor: Editor) => void;
  /** True while a save is in-flight. Backed by a ref — reads are snapshot-only. */
  saving: boolean;
  saveError: string | null;
  collapsed: boolean;
  toggleCollapse: () => void;
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
}

const COLLAPSE_KEY = 'open-walnut-global-notes-collapsed';
const DEBOUNCE_MS = 500;

export function useGlobalNotes(): UseGlobalNotesReturn {
  const [content, setContent] = useState('');
  // saving is a ref — no re-renders during typing. We expose a snapshot via return.
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [popupOpen, setPopupOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const dirty = useRef(false);
  const contentHashRef = useRef<string | null>(null);
  /** Set when reloading from external update — prevents reload from triggering a save */
  const externalUpdateRef = useRef(false);

  // Load on mount with cancellation guard
  useEffect(() => {
    let mounted = true;
    fetchGlobalNotes()
      .then(({ content: c, contentHash }) => {
        if (mounted) {
          setContent(c);
          contentHashRef.current = contentHash;
        }
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // ── Reload helper (used by WS handler and 409 recovery) ──
  const reloadContent = useCallback(() => {
    fetchGlobalNotes()
      .then(({ content: c, contentHash }) => {
        contentHashRef.current = contentHash;
        dirty.current = false;
        externalUpdateRef.current = true;
        setContent(c);
      })
      .catch(() => {});
  }, []);

  // ── Listen for external notes updates via WebSocket ──
  useEvent('notes:updated', (data: unknown) => {
    if (!data || typeof (data as any).source !== 'string') return;
    const { source, contentHash } = data as { source: string; contentHash: string };
    if (source !== 'notes/global') return;

    // Content was modified externally (by agent API) — hash differs from ours
    if (contentHash !== contentHashRef.current) {
      log.info('notes', 'Global notes updated externally, reloading', { contentHash });
      // Cancel any pending save to prevent overwriting the external write.
      // savingRef = false only covers the debounce-pending case; in-flight
      // saves rely on server-side 409 rejection + the catch handler's
      // reloadContent recovery.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      savingRef.current = false;
      reloadContent();
    }
  });

  // ── Visibility / focus reload — catch external edits when tab regains focus ──
  useEffect(() => {
    let lastCheck = 0;
    const THROTTLE_MS = 2000;

    const check = () => {
      if (dirty.current) return; // don't overwrite unsaved user edits
      const now = Date.now();
      if (now - lastCheck < THROTTLE_MS) return;
      lastCheck = now;
      reloadContent();
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
    };
  }, [reloadContent]);

  // Lightweight dirty signal — no serialization, no React state update per keystroke
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;

    // TipTap fires onUpdate when content is set programmatically via
    // reloadContent -> setContent; without this guard, that would trigger a
    // debounced save, potentially racing with the next agent write.
    if (externalUpdateRef.current) {
      externalUpdateRef.current = false;
      return;
    }

    dirty.current = true;
    if (saveError) setSaveError(null);

    if (saveTimer.current) clearTimeout(saveTimer.current);

    // Mark saving via ref — no React state update, no re-render
    savingRef.current = true;

    saveTimer.current = setTimeout(() => {
      // Serialize from the editor ref — guard against destroyed editors
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) {
        savingRef.current = false;
        return;
      }
      try {
        const md = ed.storage.markdown.getMarkdown();
        const hash = contentHashRef.current ?? undefined;
        saveGlobalNotes(md, hash)
          .then(({ contentHash: newHash }) => {
            dirty.current = false;
            contentHashRef.current = newHash;
            // Keep content state in sync — needed when editor remounts
            // (collapse/expand, popup). The external sync useEffect will
            // short-circuit because editor already has this content.
            setContent(md);
          })
          .catch((err) => {
            // 409 Conflict — agent writes take priority over unsaved user edits;
            // at most ~500ms of typing may be lost due to the debounce window.
            if (err?.status === 409) {
              log.info('notes', 'Global notes save conflict, reloading');
              reloadContent();
              return;
            }
            setSaveError(err instanceof Error ? err.message : 'Save failed');
          })
          .finally(() => { savingRef.current = false; });
      } catch {
        // Editor was destroyed between scheduling and firing — skip save
        savingRef.current = false;
      }
    }, DEBOUNCE_MS);
  }, [saveError, reloadContent]);

  // Cleanup timer on unmount — only flush if content was actually modified
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        const ed = editorRef.current;
        if (dirty.current && ed && !ed.isDestroyed) {
          try {
            const md = ed.storage.markdown.getMarkdown();
            const hash = contentHashRef.current ?? undefined;
            saveGlobalNotes(md, hash).catch((e) => {
              log.warn('notes', 'Unmount flush failed', { error: e instanceof Error ? e.message : String(e) });
            });
          } catch { /* editor already gone */ }
        }
      }
    };
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  }, []);

  const openPopup = useCallback(() => setPopupOpen(true), []);
  const closePopup = useCallback(() => setPopupOpen(false), []);

  return { content, onEditorUpdate, saving: savingRef.current, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup };
}

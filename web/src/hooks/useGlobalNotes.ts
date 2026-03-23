import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';
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

  // Load on mount with cancellation guard
  useEffect(() => {
    let mounted = true;
    fetchGlobalNotes()
      .then(c => { if (mounted) setContent(c); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Lightweight dirty signal — no serialization, no React state update per keystroke
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
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
        saveGlobalNotes(md)
          .then(() => {
            dirty.current = false;
            // Keep content state in sync — needed when editor remounts
            // (collapse/expand, popup). The external sync useEffect will
            // short-circuit because editor already has this content.
            setContent(md);
          })
          .catch((err) => { setSaveError(err instanceof Error ? err.message : 'Save failed'); })
          .finally(() => { savingRef.current = false; });
      } catch {
        // Editor was destroyed between scheduling and firing — skip save
        savingRef.current = false;
      }
    }, 500);
  }, [saveError]);

  // Cleanup timer on unmount — only flush if content was actually modified
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        const ed = editorRef.current;
        if (dirty.current && ed && !ed.isDestroyed) {
          try {
            const md = ed.storage.markdown.getMarkdown();
            saveGlobalNotes(md).catch(() => {});
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

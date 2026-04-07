import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNoteContent, saveNoteContent } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';
import type { Editor } from '@tiptap/core';
import { log } from '@/utils/log';

const DEBOUNCE_MS = 500;

export function useNoteContent(notePath: string | null) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const contentHashRef = useRef<string | null>(null);
  /** Set when reloading from external update — prevents reload from triggering a save */
  const externalUpdateRef = useRef(false);

  // ── Reload helper (used by WS handler and 409 recovery) ──
  const reloadContent = useCallback((targetPath: string) => {
    fetchNoteContent(targetPath)
      .then(({ content: c, updatedAt: u, contentHash }) => {
        if (currentPathRef.current !== targetPath) return;
        contentHashRef.current = contentHash;
        dirtyRef.current = false;
        externalUpdateRef.current = true;
        setContent(c);
        setUpdatedAt(u);
        setSaveStatus('idle');
      })
      .catch(() => {});
  }, []);

  // ── Listen for external notes updates via WebSocket ──
  useEvent('notes:updated', (data: unknown) => {
    if (!data || typeof (data as any).source !== 'string') return;
    const { source, contentHash } = data as { source: string; contentHash: string };
    const path = currentPathRef.current;
    if (!path) return;

    // Map current note path to the source format used by files tools.
    // Source format must stay in sync with files-tools.ts bus.emit(NOTES_UPDATED, { source }).
    // Notes v2 paths are like "folder/note.md" → source is "notes/folder/note"
    const normalizedPath = path.replace(/\.md$/, '');
    if (source !== `notes/${normalizedPath}`) return;

    if (contentHash !== contentHashRef.current) {
      log.info('notes', 'Note updated externally, reloading', { path, contentHash });
      // Cancel any pending save to prevent overwriting the external write
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      savingRef.current = false;
      reloadContent(path);
    }
  });

  // ── Visibility / focus reload — catch external edits when tab regains focus ──
  useEffect(() => {
    let lastCheck = 0;
    const THROTTLE_MS = 2000;

    const check = () => {
      if (dirtyRef.current) return; // don't overwrite unsaved user edits
      const p = currentPathRef.current;
      if (!p) return;
      const now = Date.now();
      if (now - lastCheck < THROTTLE_MS) return;
      lastCheck = now;
      reloadContent(p);
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
    };
  }, [reloadContent]);

  // Load content when path changes
  useEffect(() => {
    // Capture the previous path before overwriting the ref so the flush below
    // can save to the correct (old) file.
    const prevPath = currentPathRef.current;
    currentPathRef.current = notePath;

    if (!notePath) {
      setContent(null);
      setUpdatedAt(null);
      setSaveStatus('idle');
      contentHashRef.current = null;
      return;
    }

    // Clear any "Saved" fade timer from the previous note so it can't
    // overwrite the new note's save status (e.g. masking "Saving...").
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }

    // Flush pending save for previous note before switching.
    // If there is a dirty, unsaved edit and a timer is pending, cancel the timer
    // and fire the save synchronously so the old note's content is not lost.
    // Note: timerRef is nulled by the timer callback on fire, so a non-null
    // value here means the timer hasn't fired yet (safe to flush ourselves).
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (dirtyRef.current && editorRef.current && prevPath) {
        const editor = editorRef.current;
        const md = editor.storage.markdown.getMarkdown();
        const hash = contentHashRef.current ?? undefined;
        saveNoteContent(prevPath, md, hash).catch(() => {});
      }
    }

    setLoading(true);
    setContent(null);
    setSaveStatus('idle');
    dirtyRef.current = false;
    contentHashRef.current = null;

    let cancelled = false;
    fetchNoteContent(notePath)
      .then(({ content: c, updatedAt: u, contentHash }) => {
        if (cancelled) return;
        setContent(c);
        setUpdatedAt(u);
        contentHashRef.current = contentHash;
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 = new file, start empty
        if (err.status === 404) {
          setContent('');
          setUpdatedAt(null);
          contentHashRef.current = null;
        } else {
          setContent(null);
          log.error('notes', 'Failed to load note', { path: notePath, error: err.message });
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [notePath]);

  // Save function
  const doSave = useCallback(async (editor: Editor) => {
    const pathToSave = currentPathRef.current;
    if (!pathToSave || savingRef.current) return;

    savingRef.current = true;
    setSaveStatus('saving');

    try {
      const md = editor.storage.markdown.getMarkdown();
      const hash = contentHashRef.current ?? undefined;
      const result = await saveNoteContent(pathToSave, md, hash);
      // Only update if we're still on the same note
      if (currentPathRef.current === pathToSave) {
        setUpdatedAt(result.updatedAt);
        contentHashRef.current = result.contentHash;
        setSaveStatus('saved');
        dirtyRef.current = false;
        // Fade "Saved" indicator after 2s
        if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      }
    } catch (err: any) {
      // 409 Conflict — agent writes take priority over unsaved user edits;
      // at most ~500ms of typing may be lost due to the debounce window.
      if (err?.status === 409 && currentPathRef.current === pathToSave) {
        log.info('notes', 'Note save conflict, reloading', { path: pathToSave });
        reloadContent(pathToSave);
        return;
      }
      log.error('notes', 'Failed to save note', { path: pathToSave, error: err.message });
      if (currentPathRef.current === pathToSave) {
        setSaveStatus('error');
      }
    } finally {
      savingRef.current = false;
      // If new dirty content arrived while we were saving, schedule another save.
      if (dirtyRef.current && editorRef.current && currentPathRef.current === pathToSave) {
        const editor = editorRef.current;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          doSave(editor);
        }, DEBOUNCE_MS);
      }
    }
  }, [reloadContent]);

  // Debounced editor update handler
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;

    // Skip save trigger when content was set by external reload
    if (externalUpdateRef.current) {
      externalUpdateRef.current = false;
      return;
    }

    dirtyRef.current = true;
    setSaveStatus('idle');

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Null the ref BEFORE doSave so the note-switch flush logic can
      // distinguish "timer pending" from "timer already fired (save in-flight)".
      timerRef.current = null;
      doSave(editor);
    }, DEBOUNCE_MS);
  }, [doSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (savedFadeTimerRef.current) {
        clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = null;
      }
      if (dirtyRef.current && editorRef.current) {
        // Fire-and-forget save
        const editor = editorRef.current;
        const pathToSave = currentPathRef.current;
        if (pathToSave) {
          const md = editor.storage.markdown.getMarkdown();
          const hash = contentHashRef.current ?? undefined;
          saveNoteContent(pathToSave, md, hash).catch((e) => {
            log.warn('notes', 'Unmount flush failed', { error: e instanceof Error ? e.message : String(e) });
          });
        }
      }
    };
  }, []);

  return { content, loading, updatedAt, saveStatus, onEditorUpdate };
}

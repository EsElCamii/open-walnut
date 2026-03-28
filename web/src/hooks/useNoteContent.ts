import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNoteContent, saveNoteContent } from '@/api/notes-v2';
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
  const currentPathRef = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);

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
      return;
    }

    // Flush pending save for previous note before switching.
    // If there is a dirty, unsaved edit and a timer is pending, cancel the timer
    // and fire the save synchronously so the old note's content is not lost.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (dirtyRef.current && editorRef.current && prevPath) {
        const editor = editorRef.current;
        const md = editor.storage.markdown.getMarkdown();
        saveNoteContent(prevPath, md).catch(() => {});
      }
    }

    setLoading(true);
    setContent(null);
    setSaveStatus('idle');
    dirtyRef.current = false;

    let cancelled = false;
    fetchNoteContent(notePath)
      .then(({ content: c, updatedAt: u }) => {
        if (cancelled) return;
        setContent(c);
        setUpdatedAt(u);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 = new file, start empty
        if (err.status === 404) {
          setContent('');
          setUpdatedAt(null);
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
      const result = await saveNoteContent(pathToSave, md);
      // Only update if we're still on the same note
      if (currentPathRef.current === pathToSave) {
        setUpdatedAt(result.updatedAt);
        setSaveStatus('saved');
        dirtyRef.current = false;
      }
    } catch (err: any) {
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
  }, []);

  // Debounced editor update handler
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    dirtyRef.current = true;
    setSaveStatus('idle');

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
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
      if (dirtyRef.current && editorRef.current) {
        // Fire-and-forget save
        const editor = editorRef.current;
        const pathToSave = currentPathRef.current;
        if (pathToSave) {
          const md = editor.storage.markdown.getMarkdown();
          saveNoteContent(pathToSave, md).catch(() => {});
        }
      }
    };
  }, []);

  return { content, loading, updatedAt, saveStatus, onEditorUpdate };
}

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * useFieldContent — a save/load adapter that lets ANY flat markdown field (a task
 * description/note, a memory .md file) drive the shared MarkdownEditorPanel with
 * the same {content, onEditorUpdate, saveStatus} contract that useNoteContent
 * exposes for vault notes.
 *
 * Unlike useNoteContent it has NO frontmatter handling and NO contentHash 409
 * locking — these fields are last-write-wins. Save is debounced autosave (matches
 * /notes), replacing the old manual Edit/Save button flow.
 *
 * @param key      stable identity of the field (taskId+':desc', memory path…). A
 *                 change re-loads. Null = nothing to edit (renders nothing).
 * @param initial  the current value (caller already has it loaded). Re-seeds when
 *                 `key` changes; ignored while the user has unsaved local edits.
 * @param save     persists the new body. Returns anything (ignored).
 */
export function useFieldContent(
  key: string | null,
  initial: string,
  save: (body: string) => Promise<unknown>,
): {
  content: string | null;
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  onEditorUpdate: (editor: Editor) => void;
} {
  const [content, setContent] = useState<string | null>(key ? initial : null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const keyRef = useRef(key);
  const savedRef = useRef<string>(initial); // last value we persisted / loaded

  const DEBOUNCE_MS = 500;

  // Re-seed when the field identity changes (and not mid-edit on the same key).
  useEffect(() => {
    if (key === keyRef.current && dirtyRef.current) return;
    keyRef.current = key;
    dirtyRef.current = false;
    savedRef.current = initial;
    setContent(key ? initial : null);
    setSaveStatus('idle');
  }, [key, initial]);

  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    dirtyRef.current = true;
    setSaveStatus('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) { setSaveStatus('idle'); return; }
      let md: string;
      try { md = ed.storage.markdown.getMarkdown(); } catch { setSaveStatus('idle'); return; }
      if (md === savedRef.current) { dirtyRef.current = false; setSaveStatus('saved'); return; }
      save(md)
        .then(() => { savedRef.current = md; dirtyRef.current = false; setSaveStatus('saved'); })
        .catch(() => setSaveStatus('error'));
    }, DEBOUNCE_MS);
  }, [save]);

  // Flush a pending edit on unmount (field closed / page left).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const ed = editorRef.current;
      if (dirtyRef.current && ed && !ed.isDestroyed) {
        try {
          const md = ed.storage.markdown.getMarkdown();
          if (md !== savedRef.current) void save(md).catch(() => {});
        } catch { /* editor gone */ }
      }
    };
  }, [save]);

  return { content, saveStatus, onEditorUpdate };
}

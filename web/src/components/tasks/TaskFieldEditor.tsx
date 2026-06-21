import { useCallback } from 'react';
import type { Task } from '@open-walnut/core';
import { MarkdownEditorPanel } from '@/components/notes/MarkdownEditorPanel';
import { useFieldContent } from '@/hooks/useFieldContent';
import { useNavigate } from 'react-router-dom';

/**
 * TaskFieldEditor — a task's description or note edited with the SHARED rich
 * editor (MarkdownEditorPanel), the same one /notes uses. Always-on autosave
 * (no Edit/Save buttons) via useFieldContent; wikilink/#tag enabled (links into
 * the vault, though the task itself isn't reverse-indexed).
 *
 * The task field is a flat markdown string (no frontmatter, no contentHash), so
 * raw-mode flush isn't offered here — just the rendered editor + width toggle.
 */
export function TaskFieldEditor({
  taskId,
  field,
  value,
  save,
  placeholder,
}: {
  taskId: string;
  field: 'description' | 'note';
  value: string;
  save: (taskId: string, body: string) => Promise<Task>;
  placeholder?: string;
}) {
  const navigate = useNavigate();
  const doSave = useCallback((body: string) => save(taskId, body), [save, taskId]);
  const { content, saveStatus, onEditorUpdate } = useFieldContent(
    `${taskId}:${field}`,
    value,
    doSave,
  );

  return (
    <MarkdownEditorPanel
      content={content}
      onEditorUpdate={onEditorUpdate}
      saveStatus={saveStatus}
      docId={`${taskId}:${field}`}
      placeholder={placeholder}
      enableWikiLinks
      enableBlockTools
      showWidthToggle
      onWikiLinkClick={(path) => navigate(`/notes?path=${encodeURIComponent(path)}`)}
    />
  );
}

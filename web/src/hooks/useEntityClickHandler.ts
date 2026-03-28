/**
 * Shared click-delegation handler for containers that render markdown
 * with .task-link, .session-link, and .file-link anchors.
 *
 * EVERY component that renders task-ref / session-ref / file links should use
 * this hook instead of duplicating the event-delegation pattern.
 *
 * Behavior:
 *  - task-link click → onTaskClick(taskId) → select + scroll + open session (no detail)
 *  - session-link click → onSessionClick(sessionId) → open session panel
 *  - file-link click → onFileOpen(path, line?) → open FileViewer overlay
 *  - Fallback: navigate to /tasks/:id or /sessions?id=:id when callbacks are absent
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export function useEntityClickHandler(
  onTaskClick?: (taskId: string) => void,
  onSessionClick?: (sessionId: string) => void,
  onFileOpen?: (path: string, line?: number) => void,
) {
  const navigate = useNavigate();

  // .task-link and .session-link anchors are created by entityRefsToHtml()
  // and injectJsonIdLinks() in utils/markdown.ts, with data-task-id / data-session-id attributes.
  // .file-link anchors are created by filePathsToHtml() with data-file-path / data-file-line.
  // preventDefault() is called but NOT stopPropagation() — callers that need
  // stopPropagation (e.g. TriagePanel inside a toggle button) wrap this handler.
  return useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      e.preventDefault();
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
      return;
    }

    const sessionAnchor = target.closest('a.session-link') as HTMLAnchorElement | null;
    if (sessionAnchor) {
      e.preventDefault();
      const sessionId = sessionAnchor.dataset.sessionId;
      if (sessionId) {
        onSessionClick ? onSessionClick(sessionId) : navigate(`/sessions?id=${sessionId}`);
      }
      return;
    }

    const fileAnchor = target.closest('a.file-link') as HTMLAnchorElement | null;
    if (fileAnchor) {
      e.preventDefault();
      const filePath = fileAnchor.dataset.filePath;
      const fileLine = fileAnchor.dataset.fileLine;
      if (filePath && onFileOpen) {
        onFileOpen(filePath, fileLine ? parseInt(fileLine, 10) : undefined);
      }
    }
  }, [onTaskClick, onSessionClick, onFileOpen, navigate]);
}

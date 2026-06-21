import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PopoutTaskDetail } from '@/pages/TaskDetailPage';

/**
 * Standalone task detail view for a pop-out window.
 *
 * Delegates to <PopoutTaskDetail/> — the context-free entry exported by
 * TaskDetailPage. That entry sources the task id from `?id=` itself, MUST NOT
 * call useTasksContext (no TasksProvider under PopoutRoot), reports operation
 * errors via window.alert, and hides the in-app Back button. It stays live via
 * the same `task:*` / `session:*` WebSocket events the in-app page uses, so the
 * pop-out updates even with the main window closed.
 *
 * The task body is a vertical document flow (cards), so it relies on
 * .popout-root's default padding + internal scroll rather than a full-height
 * editor wrapper. We only set the document title here.
 */
export function PopoutTask() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';

  useEffect(() => {
    document.title = id ? `Task ${id.slice(0, 8)} — Walnut` : 'Task — Walnut';
  }, [id]);

  if (!id) {
    return (
      <div className="popout-stub">
        <h2>No task</h2>
        <code>(no id)</code>
      </div>
    );
  }

  return (
    <div className="popout-task">
      <PopoutTaskDetail />
    </div>
  );
}

import { useTasksContext } from '@/contexts/TasksContext';

/**
 * Global toast for task-operation errors (e.g. 409 when completing a parent
 * with active children). Reads from TasksContext so any page that uses the
 * shared useTasks hook surfaces errors uniformly — no per-page wiring needed.
 *
 * Auto-dismiss is handled inside useTasks (OPERATION_ERROR_TIMEOUT_MS);
 * this component only renders.
 */
export function OperationErrorToast() {
  const { operationError, clearOperationError } = useTasksContext();
  if (!operationError) return null;

  return (
    <div className="operation-error-toast-container" aria-live="polite">
      <div className="operation-error-toast" role="alert">
        <div className="operation-error-toast-body">{operationError}</div>
        <button
          className="operation-error-toast-close"
          onClick={clearOperationError}
          aria-label="Dismiss error"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

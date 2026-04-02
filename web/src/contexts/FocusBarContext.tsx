import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useFocusBar, type UseFocusBarReturn } from '@/hooks/useFocusBar';
import { useTasksContext } from './TasksContext';

const FocusBarContext = createContext<UseFocusBarReturn | null>(null);

export function FocusBarProvider({ children }: { children: ReactNode }) {
  const { tasks } = useTasksContext();
  const focusBar = useFocusBar(tasks);
  // Stabilize context value: only re-render consumers when data actually changes.
  // Callbacks are already stable (useCallback), so only data arrays trigger updates.
  const value = useMemo<UseFocusBarReturn>(() => focusBar,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stable via useCallback
    [focusBar.pinnedIds, focusBar.focusIds, focusBar.nextIds, focusBar.satelliteIds,
     focusBar.pinnedTasks, focusBar.focusTasks, focusBar.nextTasks, focusBar.satelliteTasks,
     focusBar.visible]);
  return <FocusBarContext.Provider value={value}>{children}</FocusBarContext.Provider>;
}

export function useFocusBarContext(): UseFocusBarReturn {
  const ctx = useContext(FocusBarContext);
  if (!ctx) throw new Error('useFocusBarContext must be used within FocusBarProvider');
  return ctx;
}

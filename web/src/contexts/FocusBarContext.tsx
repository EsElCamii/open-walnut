import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useFocusBar, type UseFocusBarReturn } from '@/hooks/useFocusBar';
import { useTasksContext } from './TasksContext';

const FocusBarContext = createContext<UseFocusBarReturn | null>(null);

export function FocusBarProvider({ children }: { children: ReactNode }) {
  const { tasks } = useTasksContext();
  const focusBar = useFocusBar(tasks);
  // Stabilize context value: only update when focus bar STATE changes (IDs or visibility),
  // NOT when task data changes. Task[] arrays (pinnedTasks, focusTasks, etc.) always get
  // new references when `tasks` changes, which would cause a double-trigger cascade:
  // task:updated → TasksContext change → MainPage render AND FocusBarContext change →
  // MainPage render again → TodoPanel filtered recalc → setSortOrder → exceeds max depth.
  // Consumers that need fresh task data already get it from TasksContext.
  const value = useMemo<UseFocusBarReturn>(() => focusBar,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only IDs + visible trigger context update
    [focusBar.pinnedIds, focusBar.focusIds, focusBar.nextIds, focusBar.satelliteIds,
     focusBar.visible]);
  return <FocusBarContext.Provider value={value}>{children}</FocusBarContext.Provider>;
}

export function useFocusBarContext(): UseFocusBarReturn {
  const ctx = useContext(FocusBarContext);
  if (!ctx) throw new Error('useFocusBarContext must be used within FocusBarProvider');
  return ctx;
}

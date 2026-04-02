import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { FocusTier } from '@/api/focus';
import type { Task } from '@open-walnut/core';

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  focusIds: string[];
  nextIds: string[];
  satelliteIds: string[];
  focusTasks: Task[];
  nextTasks: Task[];
  satelliteTasks: Task[];
  pin: (taskId: string) => Promise<void>;
  unpin: (taskId: string) => Promise<void>;
  reorder: (newIds: string[]) => Promise<void>;
  setTier: (taskId: string, tier: FocusTier) => Promise<void>;
  isPinned: (taskId: string) => boolean;
  tierOf: (taskId: string) => FocusTier;
  visible: boolean;
  setVisible: (v: boolean) => void;
}

const SELF_CHANGE_COOLDOWN = 3000;
const VISIBLE_KEY = 'open-walnut-focus-dock-visible';

function readVisible(): boolean {
  try { return localStorage.getItem(VISIBLE_KEY) === 'true'; } catch { return false; }
}

/** Shallow-compare two string arrays — avoids unnecessary state updates from server echoes. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  const [nextIds, setNextIds] = useState<string[]>([]);
  const [satelliteIds, setSatelliteIds] = useState<string[]>([]);
  const [visible, setVisibleState] = useState(readVisible);

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try { localStorage.setItem(VISIBLE_KEY, String(v)); } catch { /* ignore */ }
  }, []);

  const lastWriteRef = useRef(0);

  // Apply server response — handles both full (GET) and partial (setTier) responses.
  // Uses equality check to skip no-op state updates (prevents render cascade when
  // server echoes the same data that the optimistic update already applied).
  const applyData = useCallback((data: Partial<focusApi.FocusBarData>) => {
    if (data.pinned_tasks) setPinnedIds(prev => arraysEqual(prev, data.pinned_tasks!) ? prev : data.pinned_tasks!);
    if (data.focus_tasks) setFocusIds(prev => arraysEqual(prev, data.focus_tasks!) ? prev : data.focus_tasks!);
    if (data.next_tasks) setNextIds(prev => arraysEqual(prev, data.next_tasks!) ? prev : data.next_tasks!);
    if (data.satellite_tasks) setSatelliteIds(prev => arraysEqual(prev, data.satellite_tasks!) ? prev : data.satellite_tasks!);
  }, []);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks().then(applyData).catch(() => {});
  }, [applyData]);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchPinned();
  });

  // Auto-unpin completed tasks
  const removeFromAll = useCallback((taskId: string) => {
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    setFocusIds((prev) => prev.filter((id) => id !== taskId));
    setNextIds((prev) => prev.filter((id) => id !== taskId));
    setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
  }, []);

  useEvent('task:completed', (data: unknown) => {
    const { task } = data as { task: { id: string } };
    if (task?.id && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      removeFromAll(task.id);
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });
  useEvent('task:updated', (data: unknown) => {
    const { task } = data as { task: { id: string; phase?: string; status?: string } };
    if ((task.phase === 'COMPLETE' || task.status === 'done') && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      removeFromAll(task.id);
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });

  const pin = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task && (task.status === 'done' || task.phase === 'COMPLETE')) return;
    lastWriteRef.current = Date.now();
    // New pin defaults to Satellite
    setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    setSatelliteIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    try {
      await focusApi.pinTask(taskId);
    } catch {
      setPinnedIds((prev) => prev.filter((id) => id !== taskId));
      setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    }
  }, [tasks]);

  const unpin = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    removeFromAll(taskId);
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      fetchPinned();
    }
  }, [removeFromAll, fetchPinned]);

  const reorder = useCallback(async (newIds: string[]) => {
    lastWriteRef.current = Date.now();
    setPinnedIds(newIds);
    try {
      await focusApi.reorderPinnedTasks(newIds);
    } catch {
      fetchPinned();
    }
  }, [fetchPinned]);

  const setTier = useCallback(async (taskId: string, tier: FocusTier) => {
    lastWriteRef.current = Date.now();
    // Optimistic: remove from old tier, add to new.
    // Only create new array when the item is actually added/removed (avoids no-op state updates).
    const addTo = (prev: string[]) => prev.includes(taskId) ? prev : [...prev, taskId];
    const removeFrom = (prev: string[]) => prev.includes(taskId) ? prev.filter((id) => id !== taskId) : prev;
    setFocusIds(tier === 'focus' ? addTo : removeFrom);
    setNextIds(tier === 'next' ? addTo : removeFrom);
    setSatelliteIds(tier === 'satellite' ? addTo : removeFrom);
    try {
      const result = await focusApi.setTaskTier(taskId, tier);
      applyData(result);
    } catch {
      fetchPinned();
    }
  }, [applyData, fetchPinned]);

  const isPinned = useCallback((taskId: string) => pinnedIds.includes(taskId), [pinnedIds]);

  const tierOf = useCallback((taskId: string): FocusTier => {
    if (focusIds.includes(taskId)) return 'focus';
    if (nextIds.includes(taskId)) return 'next';
    return 'satellite';
  }, [focusIds, nextIds]);

  // Resolve IDs to Task objects
  const resolve = useCallback((ids: string[], allTasks: Task[]) => {
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    return ids
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, []);

  const pinnedTasks = useMemo(() => resolve(pinnedIds, tasks), [resolve, pinnedIds, tasks]);
  const focusTasks = useMemo(() => resolve(focusIds, tasks), [resolve, focusIds, tasks]);
  const nextTasks = useMemo(() => resolve(nextIds, tasks), [resolve, nextIds, tasks]);
  const satelliteTasks = useMemo(() => resolve(satelliteIds, tasks), [resolve, satelliteIds, tasks]);

  return {
    pinnedIds, pinnedTasks,
    focusIds, nextIds, satelliteIds,
    focusTasks, nextTasks, satelliteTasks,
    pin, unpin, reorder, setTier,
    isPinned, tierOf,
    visible, setVisible,
  };
}

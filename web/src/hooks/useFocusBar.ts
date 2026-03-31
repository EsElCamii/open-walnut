import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { Task } from '@open-walnut/core';

const FOCUS_MAX = 3;

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  focusIds: string[];
  satelliteIds: string[];
  focusTasks: Task[];
  satelliteTasks: Task[];
  pin: (taskId: string) => Promise<void>;
  unpin: (taskId: string) => Promise<void>;
  reorder: (newIds: string[]) => Promise<void>;
  promote: (taskId: string) => Promise<void>;
  demote: (taskId: string) => Promise<void>;
  isPinned: (taskId: string) => boolean;
  isFocus: (taskId: string) => boolean;
  focusFull: boolean;
  visible: boolean;
  setVisible: (v: boolean) => void;
}

// How long to ignore config:changed events after we caused them (ms)
const SELF_CHANGE_COOLDOWN = 3000;

const VISIBLE_KEY = 'open-walnut-focus-dock-visible';

function readVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  const [satelliteIds, setSatelliteIds] = useState<string[]>([]);
  const [visible, setVisibleState] = useState(readVisible);

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    try { localStorage.setItem(VISIBLE_KEY, String(v)); } catch { /* ignore */ }
  }, []);

  // Track when WE last wrote to the focus_bar config
  const lastWriteRef = useRef(0);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks()
      .then((data) => {
        setPinnedIds(data.pinned_tasks);
        setFocusIds(data.focus_tasks ?? []);
        setSatelliteIds(data.satellite_tasks ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  // Re-sync only when focus_bar config changes from EXTERNAL sources
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchPinned();
  });

  // Auto-unpin completed tasks
  useEvent('task:completed', (data: unknown) => {
    const { task } = data as { task: { id: string } };
    if (task?.id && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      setPinnedIds((prev) => prev.filter((pid) => pid !== task.id));
      setFocusIds((prev) => prev.filter((pid) => pid !== task.id));
      setSatelliteIds((prev) => prev.filter((pid) => pid !== task.id));
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });
  useEvent('task:updated', (data: unknown) => {
    const { task } = data as { task: { id: string; phase?: string; status?: string } };
    if ((task.phase === 'COMPLETE' || task.status === 'done') && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      setPinnedIds((prev) => prev.filter((pid) => pid !== task.id));
      setFocusIds((prev) => prev.filter((pid) => pid !== task.id));
      setSatelliteIds((prev) => prev.filter((pid) => pid !== task.id));
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
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    setFocusIds((prev) => prev.filter((id) => id !== taskId));
    setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      // Rollback — re-fetch from server
      fetchPinned();
    }
  }, [fetchPinned]);

  const reorder = useCallback(async (newIds: string[]) => {
    lastWriteRef.current = Date.now();
    setPinnedIds(newIds);
    try {
      await focusApi.reorderPinnedTasks(newIds);
    } catch {
      fetchPinned();
    }
  }, [fetchPinned]);

  const promote = useCallback(async (taskId: string) => {
    if (focusIds.length >= FOCUS_MAX) return;
    lastWriteRef.current = Date.now();
    // Optimistic: move from satellite to focus
    setFocusIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    try {
      const result = await focusApi.setTaskTier(taskId, true);
      setFocusIds(result.focus_tasks);
      setSatelliteIds(result.satellite_tasks);
    } catch {
      // Rollback
      setFocusIds((prev) => prev.filter((id) => id !== taskId));
      setSatelliteIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    }
  }, [focusIds]);

  const demote = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    // Optimistic: move from focus to satellite
    setFocusIds((prev) => prev.filter((id) => id !== taskId));
    setSatelliteIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    try {
      const result = await focusApi.setTaskTier(taskId, false);
      setFocusIds(result.focus_tasks);
      setSatelliteIds(result.satellite_tasks);
    } catch {
      // Rollback
      setFocusIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
      setSatelliteIds((prev) => prev.filter((id) => id !== taskId));
    }
  }, []);

  const isPinned = useCallback(
    (taskId: string) => pinnedIds.includes(taskId),
    [pinnedIds],
  );

  const isFocus = useCallback(
    (taskId: string) => focusIds.includes(taskId),
    [focusIds],
  );

  const focusFull = focusIds.length >= FOCUS_MAX;

  // Resolve IDs to Task objects
  const pinnedTasks = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return pinnedIds
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, [pinnedIds, tasks]);

  const focusTasks = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return focusIds
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, [focusIds, tasks]);

  const satelliteTasks = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return satelliteIds
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, [satelliteIds, tasks]);

  return {
    pinnedIds, pinnedTasks,
    focusIds, satelliteIds, focusTasks, satelliteTasks,
    pin, unpin, reorder, promote, demote,
    isPinned, isFocus, focusFull,
    visible, setVisible,
  };
}

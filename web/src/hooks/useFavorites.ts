import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEvent } from './useWebSocket';
import * as favApi from '@/api/favorites';

export interface UseFavoritesReturn {
  favoriteCategories: string[];
  favoriteProjects: string[];
  favoriteNotes: string[];
  toggleFavoriteCategory: (name: string) => Promise<void>;
  toggleFavoriteProject: (name: string) => Promise<void>;
  toggleFavoriteNote: (path: string) => Promise<void>;
  isCategoryFavorite: (name: string) => boolean;
  isProjectFavorite: (name: string) => boolean;
  isNoteFavorite: (path: string) => boolean;
  hasFavorites: boolean;
}

export function useFavorites(): UseFavoritesReturn {
  const [favoriteCategories, setFavoriteCategories] = useState<string[]>([]);
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);
  const [favoriteNotes, setFavoriteNotes] = useState<string[]>([]);

  const fetchAll = useCallback(() => {
    favApi.fetchFavorites()
      .then((data) => {
        setFavoriteCategories(data.categories);
        setFavoriteProjects(data.projects);
        // Tolerate an older backend that doesn't yet return `notes`.
        setFavoriteNotes(data.notes ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-sync when favorites config changes from other sources
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'favorites') return;
    fetchAll();
  });

  const toggleFavoriteCategory = useCallback(async (name: string) => {
    if (favoriteCategories.includes(name)) {
      await favApi.removeFavoriteCategory(name);
      setFavoriteCategories((prev) => prev.filter((c) => c !== name));
    } else {
      await favApi.addFavoriteCategory(name);
      setFavoriteCategories((prev) => [...prev, name]);
    }
  }, [favoriteCategories]);

  const toggleFavoriteProject = useCallback(async (name: string) => {
    if (favoriteProjects.includes(name)) {
      await favApi.removeFavoriteProject(name);
      setFavoriteProjects((prev) => prev.filter((p) => p !== name));
    } else {
      await favApi.addFavoriteProject(name);
      setFavoriteProjects((prev) => [...prev, name]);
    }
  }, [favoriteProjects]);

  const toggleFavoriteNote = useCallback(async (path: string) => {
    if (favoriteNotes.includes(path)) {
      await favApi.removeFavoriteNote(path);
      setFavoriteNotes((prev) => prev.filter((p) => p !== path));
    } else {
      await favApi.addFavoriteNote(path);
      setFavoriteNotes((prev) => [...prev, path]);
    }
  }, [favoriteNotes]);

  const isCategoryFavorite = useCallback(
    (name: string) => favoriteCategories.includes(name),
    [favoriteCategories],
  );

  const isProjectFavorite = useCallback(
    (name: string) => favoriteProjects.includes(name),
    [favoriteProjects],
  );

  const isNoteFavorite = useCallback(
    (path: string) => favoriteNotes.includes(path),
    [favoriteNotes],
  );

  const hasFavorites = favoriteCategories.length > 0 || favoriteProjects.length > 0 || favoriteNotes.length > 0;

  // Stabilize return value — prevents downstream memo invalidation (e.g. TodoPanel filtered)
  return useMemo(() => ({
    favoriteCategories,
    favoriteProjects,
    favoriteNotes,
    toggleFavoriteCategory,
    toggleFavoriteProject,
    toggleFavoriteNote,
    isCategoryFavorite,
    isProjectFavorite,
    isNoteFavorite,
    hasFavorites,
  }), [favoriteCategories, favoriteProjects, favoriteNotes, toggleFavoriteCategory, toggleFavoriteProject,
       toggleFavoriteNote, isCategoryFavorite, isProjectFavorite, isNoteFavorite, hasFavorites]);
}

import { useState, useEffect, useCallback } from 'react';
import { fetchRepositories, saveRepository, deleteRepository, type RepoSummary } from '@/api/repositories';

export function useRepositories() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRepositories();
      setRepos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (name: string, content: string) => {
    const result = await saveRepository(name, content);
    await refresh();
    return result;
  }, [refresh]);

  const remove = useCallback(async (name: string) => {
    await deleteRepository(name);
    await refresh();
  }, [refresh]);

  return { repos, loading, error, refresh, save, remove };
}

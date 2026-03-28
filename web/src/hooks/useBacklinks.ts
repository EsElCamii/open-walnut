import { useState, useEffect } from 'react';
import { fetchBacklinks } from '@/api/notes-v2';
import type { BacklinkResult } from '@/api/notes-v2';

export function useBacklinks(notePath: string | null) {
  const [backlinks, setBacklinks] = useState<BacklinkResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!notePath) {
      setBacklinks([]);
      return;
    }

    setLoading(true);
    let cancelled = false;

    fetchBacklinks(notePath)
      .then((data) => { if (!cancelled) setBacklinks(data); })
      .catch(() => { if (!cancelled) setBacklinks([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [notePath]);

  return { backlinks, loading };
}

import { useState, useEffect } from 'react';
import { fetchConfig } from '@/api/config';

const DEFAULT_MODES = ['bypass', 'plan'];

/**
 * Fetch session.enabled_modes from config once on mount.
 * Returns the mode cycle array (defaults to all 4 modes).
 */
export function useEnabledModes(): string[] {
  const [modes, setModes] = useState<string[]>(DEFAULT_MODES);

  useEffect(() => {
    fetchConfig().then(c => {
      const m = c.session?.enabled_modes;
      if (Array.isArray(m) && m.length > 0) setModes(m);
    }).catch(() => {});
  }, []);

  return modes;
}

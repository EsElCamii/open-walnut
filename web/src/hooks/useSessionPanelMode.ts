import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';

export type SessionPanelMode = '1' | '2' | 'auto';

const AUTO_BREAKPOINT = 1600; // px — Mac 14" is 1512, Mac 16" is 1728

// matchMedia listener for auto breakpoint
const mql = typeof window !== 'undefined'
  ? window.matchMedia(`(min-width: ${AUTO_BREAKPOINT}px)`)
  : null;

function subscribeMedia(cb: () => void) {
  mql?.addEventListener('change', cb);
  return () => mql?.removeEventListener('change', cb);
}

function getMediaSnapshot(): boolean {
  return mql?.matches ?? true;
}

function isValidMode(v: unknown): v is SessionPanelMode {
  return v === '1' || v === '2' || v === 'auto';
}

// How long to ignore config:changed events after we caused them (ms)
const SELF_CHANGE_COOLDOWN = 3000;

export function useSessionPanelMode() {
  const [mode, setModeState] = useState<SessionPanelMode>('auto');
  const [loaded, setLoaded] = useState(false);
  const isWide = useSyncExternalStore(subscribeMedia, getMediaSnapshot);
  const lastSelfChangeRef = { current: 0 };

  // Fetch from config on mount
  useEffect(() => {
    fetchConfig().then(c => {
      const v = c.ui?.session_panels;
      if (isValidMode(v)) setModeState(v);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  // Sync when config changes (from other tabs/sources)
  useEvent('config:changed', useCallback(() => {
    if (Date.now() - lastSelfChangeRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchConfig().then(c => {
      const v = c.ui?.session_panels;
      if (isValidMode(v)) setModeState(v);
    }).catch(() => {});
  }, []));

  const setMode = useCallback((m: SessionPanelMode) => {
    setModeState(m);
    lastSelfChangeRef.current = Date.now();
    updateConfig({ ui: { session_panels: m } }).catch(() => {});
  }, []);

  const effectiveMaxPanels: number =
    mode === '1' ? 1 :
    mode === '2' ? 2 :
    isWide ? 2 : 1;

  return { mode, setMode, effectiveMaxPanels, loaded } as const;
}

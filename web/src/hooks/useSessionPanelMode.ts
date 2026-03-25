import { useState, useEffect, useSyncExternalStore } from 'react';

export type SessionPanelMode = '1' | '2' | 'auto';

const STORAGE_KEY = 'open-walnut-session-panel-mode';
const AUTO_BREAKPOINT = 1600; // px — Mac 14" is 1512, Mac 16" is 1728

function getStoredMode(): SessionPanelMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === '1' || v === '2' || v === 'auto') return v;
  } catch { /* private browsing */ }
  return 'auto';
}

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

export function useSessionPanelMode() {
  const [mode, setModeState] = useState<SessionPanelMode>(getStoredMode);
  const isWide = useSyncExternalStore(subscribeMedia, getMediaSnapshot);

  const setMode = (m: SessionPanelMode) => {
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* private browsing */ }
    setModeState(m);
  };

  // Sync across tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setModeState(getStoredMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const effectiveMaxPanels: number =
    mode === '1' ? 1 :
    mode === '2' ? 2 :
    isWide ? 2 : 1;

  return { mode, setMode, effectiveMaxPanels } as const;
}

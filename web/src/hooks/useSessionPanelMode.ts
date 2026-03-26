import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';

export type SessionPanelMode = '1' | '2' | 'auto';

// Min width (px) of the chat+sessions container to allow 2 session panels in auto mode.
// Chat needs ~350px + 2 sessions need ~300px each = ~950px minimum.
// Set to 1200 so Mac 14" (content-row ~1084px) defaults to 1 panel,
// while Mac 16" (~1300px) and external monitors get 2 panels.
const AUTO_MIN_WIDTH_FOR_TWO = 1200;

function isValidMode(v: unknown): v is SessionPanelMode {
  return v === '1' || v === '2' || v === 'auto';
}

// How long to ignore config:changed events after we caused them (ms)
const SELF_CHANGE_COOLDOWN = 3000;

/**
 * @param containerWidth - actual pixel width of the session area container.
 *   Used by auto mode to decide 1 vs 2 panels based on available space (not viewport).
 */
export function useSessionPanelMode(containerWidth = 0) {
  const [mode, setModeState] = useState<SessionPanelMode>('1');
  const lastSelfChangeRef = useRef(0);

  // Fetch from config on mount
  useEffect(() => {
    fetchConfig().then(c => {
      const v = c.ui?.session_panels;
      if (isValidMode(v)) setModeState(v);
    }).catch(() => {});
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
    containerWidth >= AUTO_MIN_WIDTH_FOR_TWO ? 2 : 1;

  return { mode, setMode, effectiveMaxPanels } as const;
}

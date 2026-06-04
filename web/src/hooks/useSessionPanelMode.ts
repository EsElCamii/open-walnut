import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';

export type SessionPanelMode = '1' | '2' | 'auto';

// Min width (px) of the chat+sessions container to allow 2 session panels in auto mode.
// Mac 14" content-row ≈ 1305px — too cramped for 2 sessions alongside chat.
// Set to 1400 so Mac 14" gets 1 panel, external monitors (1500px+) get 2.
const AUTO_MIN_WIDTH_FOR_TWO = 1400;

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
  const [mode, setModeState] = useState<SessionPanelMode>('2');
  const lastSelfChangeRef = useRef(0);

  // Fetch from config on mount
  useEffect(() => {
    fetchConfig().then(c => {
      const v = c.ui?.session_panels;
      if (isValidMode(v)) setModeState(v);
    }).catch(() => {});
  }, []);

  // Sync when UI config changes (from other tabs/sources)
  useEvent('config:changed', useCallback((data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'ui') return;
    if (Date.now() - lastSelfChangeRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchConfig().then(c => {
      const v = c.ui?.session_panels;
      if (isValidMode(v)) setModeState(v);
    }).catch(() => {});
  }, []));

  const setMode = useCallback((m: SessionPanelMode) => {
    setModeState(m);
    lastSelfChangeRef.current = Date.now();
    // Merge into existing ui block so sibling keys (e.g. bump_pinned_on_chat) survive —
    // updateConfig replaces the whole `ui` object, not individual sub-keys.
    fetchConfig()
      .then(c => updateConfig({ ui: { ...c.ui, session_panels: m } }))
      .catch(() => {});
  }, []);

  const effectiveMaxPanels: number =
    mode === '1' ? 1 :
    mode === '2' ? 2 :
    containerWidth >= AUTO_MIN_WIDTH_FOR_TWO ? 2 : 1;

  return { mode, setMode, effectiveMaxPanels } as const;
}

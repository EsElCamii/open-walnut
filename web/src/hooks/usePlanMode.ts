import { useState, useCallback, useRef } from 'react';

export type ChatMode = 'execution' | 'plan';

const STORAGE_KEY = 'walnut-chat-mode';

/**
 * Shared hook for Execution / Plan mode toggle.
 * Persists to localStorage; resets planInstructionSent on mode switch.
 */
export function usePlanMode() {
  const [mode, setMode] = useState<ChatMode>(() => {
    try { return (localStorage.getItem(STORAGE_KEY) as ChatMode) ?? 'execution'; }
    catch { return 'execution'; }
  });

  // Tracks whether the full plan instruction has been sent since last mode switch
  const planInstructionSentRef = useRef(false);
  // Tracks plan→execution transition so we can send a one-shot [EXECUTION MODE] signal
  const pendingModeOffRef = useRef(false);

  const toggleMode = useCallback(() => {
    setMode(prev => {
      const next = prev === 'execution' ? 'plan' : 'execution';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* noop */ }
      planInstructionSentRef.current = false;
      if (next === 'execution') pendingModeOffRef.current = true;
      return next;
    });
  }, []);

  /** Build the mode-related payload fields for the current turn. */
  const getPlanPayload = useCallback((): { mode?: 'plan'; planModeFirst?: boolean; planModeOff?: boolean } => {
    if (mode !== 'plan') {
      if (pendingModeOffRef.current) {
        pendingModeOffRef.current = false;
        return { planModeOff: true };
      }
      return {};
    }
    const isFirst = !planInstructionSentRef.current;
    if (isFirst) planInstructionSentRef.current = true;
    return { mode: 'plan', planModeFirst: isFirst || undefined };
  }, [mode]);

  return { mode, toggleMode, getPlanPayload } as const;
}

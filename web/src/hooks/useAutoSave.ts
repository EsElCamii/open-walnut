import { useEffect, useRef } from 'react';

// Default debounce window: wait this long after the last edit before writing to disk.
export const AUTOSAVE_DELAY_MS = 600;

interface UseAutoSaveOptions {
  /**
   * Serialized snapshot of the editable LOCAL state (e.g. JSON.stringify of the inputs).
   * Auto-save fires when this drifts away from `baseline`.
   */
  current: string;
  /**
   * Serialized snapshot derived from the CONFIG prop (the persisted truth), recomputed
   * each render. Used as the "last saved" reference. When config refreshes after a save —
   * or changes externally (another tab, a sibling writer like useSessionPanelMode) — this
   * moves in lockstep with the reset local state, so `current === baseline` and we do NOT
   * echo the change back. This is what breaks the save→refresh→reset→save loop.
   */
  baseline: string;
  /**
   * Async writer. Should validate internally and no-op (or throw) on invalid input —
   * either way the next edit re-triggers, so a half-typed value is never the final state.
   */
  save: () => Promise<void>;
  /** Gate auto-save (e.g. while the section is still loading). Default true. */
  enabled?: boolean;
  /** Debounce window in ms. Default 600. */
  delayMs?: number;
}

/**
 * Debounced auto-save for settings sections. Removes the need for a manual Save button:
 * any change to `current` is written `delayMs` after the user stops editing.
 *
 * The `current` vs `baseline` split is deliberate — see the field docs above. Both are
 * plain serialized strings the caller computes; this hook owns only the timer.
 */
export function useAutoSave({ current, baseline, save, enabled = true, delayMs = AUTOSAVE_DELAY_MS }: UseAutoSaveOptions) {
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!enabled) return;
    if (current === baseline) return; // nothing changed vs persisted truth
    const t = setTimeout(() => {
      saveRef.current().catch(() => {});
    }, delayMs);
    return () => clearTimeout(t);
  }, [current, baseline, enabled, delayMs]);
}

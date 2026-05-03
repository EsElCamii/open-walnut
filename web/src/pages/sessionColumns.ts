// Pure helpers for the home-page SessionPanel column queue.
// Extracted from MainPage.tsx so they can be unit-tested without React.
//
// Layout invariant: unlocked slots on the left, locked slots on the right.
// Lock/unlock always lands at the boundary between the two regions — the
// user's gaze stays anchored to where they just clicked.

export interface SessionSlot {
  id: string;
  locked: boolean;
}

export function splitByLock(cols: SessionSlot[]): { unlocked: SessionSlot[]; locked: SessionSlot[] } {
  const unlocked: SessionSlot[] = [];
  const locked: SessionSlot[] = [];
  for (const c of cols) (c.locked ? locked : unlocked).push(c);
  return { unlocked, locked };
}

/**
 * Shrink to `max` total columns, dropping unlocked slots from the right.
 * Locked slots are exempt — they can even push total > max (visible overflow
 * is preferred over evicting something the user explicitly pinned).
 */
export function trimUnlockedToMax(cols: SessionSlot[], max: number): SessionSlot[] {
  if (cols.length <= max) return cols;
  const { unlocked, locked } = splitByLock(cols);
  const keepUnlocked = Math.max(0, max - locked.length);
  return [...unlocked.slice(0, keepUnlocked), ...locked];
}

/**
 * Returns `cols` unchanged (reference-equal) iff all slots are locked and `id`
 * is new — callers use `next === prev` to detect this rejection path and show
 * a toast. Any other case yields a new array.
 */
export function addSessionColumn(cols: SessionSlot[], id: string, triageOpen: boolean, maxColumns: number): SessionSlot[] {
  const max = triageOpen ? maxColumns - 1 : maxColumns;
  const existing = cols.find(c => c.id === id);
  if (existing) {
    const filtered = cols.filter(c => c.id !== id);
    const { unlocked, locked } = splitByLock(filtered);
    return existing.locked
      ? [...unlocked, existing, ...locked]              // locked: left edge of locked region
      : [{ id, locked: false }, ...unlocked, ...locked]; // unlocked: leftmost
  }
  const { unlocked, locked } = splitByLock(cols);
  if (locked.length >= max) return cols; // fully locked — caller shows toast
  return trimUnlockedToMax([{ id, locked: false }, ...unlocked, ...locked], max);
}

export function removeSessionColumn(cols: SessionSlot[], id: string): SessionSlot[] {
  return cols.filter(c => c.id !== id);
}

export function replaceSessionColumn(cols: SessionSlot[], oldId: string, newId: string): SessionSlot[] {
  const idx = cols.findIndex(c => c.id === oldId);
  if (idx === -1) return cols;
  const next = [...cols];
  next[idx] = { id: newId, locked: cols[idx].locked };
  return next;
}

/**
 * Lock moves slot to the left edge of the locked region (first-locked stays
 * rightmost as the pin anchor; newly-locked slots push in from the left).
 * Unlock moves slot to the right edge of the unlocked region.
 */
export function toggleLockSlot(cols: SessionSlot[], id: string): SessionSlot[] {
  const target = cols.find(c => c.id === id);
  if (!target) return cols;
  const rest = cols.filter(c => c.id !== id);
  const { unlocked, locked } = splitByLock(rest);
  return target.locked
    ? [...unlocked, { id, locked: false }, ...locked]
    : [...unlocked, { id, locked: true }, ...locked];
}

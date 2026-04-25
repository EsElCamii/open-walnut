/**
 * Shared task-metadata constants (tier + priority options).
 * Used by TaskQuickActions kebab menu and SessionPathSelector meta footer.
 */

import type { TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';

export const TIER_OPTIONS: { value: FocusTier; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'next', label: 'Next' },
  { value: 'satellite', label: 'Satellite' },
];

export const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  next: '#FF9500',
  satellite: 'var(--fg-muted)',
};

export const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

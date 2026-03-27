/**
 * QuickAccessBar — horizontal row of pill-shaped shortcut buttons above the chat input.
 * Provides one-click access to frequently used commands like /session
 * and the Execution / Plan mode toggle.
 */

import type { ChatMode } from '@/hooks/usePlanMode';

interface QuickAccessBarProps {
  onSessionClick: () => void;
  mode?: ChatMode;
  onModeToggle?: () => void;
}

export function QuickAccessBar({ onSessionClick, mode, onModeToggle }: QuickAccessBarProps) {
  const isPlan = mode === 'plan';
  return (
    <div className="quick-access-bar-row">
      <button
        className="quick-access-pill"
        onClick={onSessionClick}
        title="Quick Start a session (/session)"
      >
        <span className="quick-access-pill-icon">{'\u{1F4BB}'}</span>
        <span className="quick-access-pill-label">/session</span>
      </button>
      {onModeToggle && (
        <button
          className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
          onClick={onModeToggle}
          title={`Switch to ${isPlan ? 'Execution' : 'Plan'} mode (Shift+Tab)`}
        >
          <span className="mode-toggle-pill-label">
            {isPlan ? 'Plan' : 'Execution'}
          </span>
          <span className="mode-toggle-pill-shortcut">
            {'\u21E7'}Tab
          </span>
        </button>
      )}
    </div>
  );
}

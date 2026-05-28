/**
 * SetupBanner — onboarding checklist shown in the chat area when system isn't fully configured.
 * Dismissible via localStorage; re-accessible from NotificationPanel.
 */
import { useState, useCallback, useEffect } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { InstallButton } from './InstallButton';

const LS_DISMISS_KEY = 'walnut-setup-dismissed';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

interface SetupBannerProps {
  health: SystemHealth;
  onNavigateSettings: (hash?: string) => void;
}

export function SetupBanner({ health, onNavigateSettings }: SetupBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(LS_DISMISS_KEY) === 'true'; } catch { return false; }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(LS_DISMISS_KEY, 'true'); } catch {}
  }, []);

  // Listen for "Show Setup Guide" from NotificationPanel
  useEffect(() => {
    const handler = () => setDismissed(false);
    window.addEventListener(SETUP_SHOW_EVENT, handler);
    return () => window.removeEventListener(SETUP_SHOW_EVENT, handler);
  }, []);

  if (dismissed) return null;

  const cliOk = health.claudeCliAvailable ?? true;
  const providerOk = health.hasReadyProvider ?? true;

  // All steps done — don't show banner
  if (cliOk && providerOk) return null;

  return (
    <div className="setup-banner">
      <div className="setup-banner-header">
        <span className="setup-banner-title">Setup Checklist</span>
        <button className="setup-banner-dismiss" onClick={handleDismiss} aria-label="Dismiss setup banner">&times;</button>
      </div>

      <div className="setup-banner-steps">
        {/* Step 1: Claude Code CLI */}
        <SetupStep
          done={cliOk}
          label="Install Claude Code CLI"
          required
        >
          <InstallButton target="claude-cli" />
          <CopyCommand command="npm install -g @anthropic-ai/claude-code" />
        </SetupStep>

        {/* Step 2: AI Provider */}
        <SetupStep
          done={providerOk}
          label="Configure an AI provider"
          required
        >
          <button className="setup-step-btn" onClick={() => onNavigateSettings('#providers')}>
            Settings &rarr; AI Provider
          </button>
        </SetupStep>

      </div>
    </div>
  );
}

function SetupStep({ done, label, required, children }: {
  done: boolean;
  label: string;
  required: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`setup-step ${done ? 'done' : 'pending'}`}>
      <span className="setup-step-icon">{done ? '\u2713' : '\u25CB'}</span>
      <div className="setup-step-content">
        <span className="setup-step-label">
          {label}
          {!required && <span className="setup-step-optional">optional</span>}
        </span>
        {!done && <div className="setup-step-action">{children}</div>}
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [command]);

  return (
    <span className="setup-copy-wrap">
      <code className="setup-command" onClick={handleCopy} title="Click to copy">{command}</code>
      <button className="setup-copy-btn" onClick={handleCopy} aria-label="Copy command">
        {copied ? '\u2713' : '\u2398'}
      </button>
    </span>
  );
}

/** Exported so NotificationPanel can clear the dismiss key. */
export const SETUP_DISMISS_KEY = LS_DISMISS_KEY;

/**
 * Notification panel — slide-out overlay from sidebar showing system health.
 * iOS-style notification center: embedding status, Ollama availability, etc.
 */
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { SETUP_DISMISS_KEY, SETUP_SHOW_EVENT } from './SetupBanner';
import { InstallButton } from './InstallButton';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { ErrorSuggestionLink } from './ErrorSuggestionLink';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

export function NotificationPanel({ open, onClose, sidebarCollapsed }: NotificationPanelProps) {
  const navigate = useNavigate();
  const { health, gitSync, setupComplete, loading, reindexing, triggerReindex } = useSystemHealth();

  if (!open) return null;

  const emb = health.embedding;
  const embeddingOk = emb.unindexed === 0 && emb.ollamaAvailable;
  const gitOk = gitSync.protected && gitSync.consecutiveFailures < 3;

  return (
    <>
      {/* Backdrop */}
      <div className="notification-panel-backdrop" onClick={onClose} />

      {/* Panel */}
      <div
        className={`notification-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      >
        <div className="notification-panel-header">
          <span className="notification-panel-title">Notifications</span>
          <button className="notification-panel-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="notification-panel-body">
          {loading ? (
            <div className="notification-card">
              <span className="notification-card-icon loading">...</span>
              <span>Loading...</span>
            </div>
          ) : (
            <>
              {/* Setup incomplete */}
              {!setupComplete && (
                <div className="notification-card warn">
                  <div className="notification-card-row">
                    <span className="notification-card-icon warn">{'\u26A0'}</span>
                    <span className="notification-card-label">Setup Incomplete</span>
                  </div>
                  <div className="notification-card-details">
                    {!(health.claudeCliAvailable ?? true) && (
                      <div className="notification-detail-row warn">
                        <span>Claude Code CLI</span>
                        <span className="notification-detail-value warn">Not installed</span>
                        <div className="error-suggestion">
                          <button className="error-suggestion-link" onClick={() => { navigate('/settings#sessions'); onClose(); }}>Sessions &rarr;</button>
                          <InstallButton target="claude-cli" label="Install" className="error-suggestion-install" />
                        </div>
                      </div>
                    )}
                    {!(health.hasReadyProvider ?? true) && (
                      <div className="notification-detail-row warn">
                        <span>AI Provider</span>
                        <span className="notification-detail-value warn">Not configured</span>
                        <div className="error-suggestion">
                          <button className="error-suggestion-link" onClick={() => { navigate('/settings#providers'); onClose(); }}>AI Provider &rarr;</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    className="notification-retry-btn"
                    onClick={() => {
                      try { localStorage.removeItem(SETUP_DISMISS_KEY); } catch {}
                      window.dispatchEvent(new CustomEvent(SETUP_SHOW_EVENT));
                      onClose();
                    }}
                  >
                    Show Setup Guide
                  </button>
                </div>
              )}

              {/* Embedding status */}
              <div className={`notification-card ${embeddingOk ? 'ok' : 'warn'}`}>
                <div className="notification-card-row">
                  <span className={`notification-card-icon ${embeddingOk ? 'ok' : 'warn'}`}>
                    {embeddingOk ? '\u2713' : '\u26A0'}
                  </span>
                  <span className="notification-card-label">Embedding</span>
                </div>

                <div className="notification-card-details">
                  <div className="notification-detail-row">
                    <span>Tasks indexed</span>
                    <span className="notification-detail-value">
                      {emb.indexed}/{emb.total}
                    </span>
                  </div>

                  {emb.unindexed > 0 && (
                    <div className="notification-detail-row warn">
                      <span>Missing embeddings</span>
                      <span className="notification-detail-value">{emb.unindexed}</span>
                    </div>
                  )}

                  <div className="notification-detail-row">
                    <span>Ollama</span>
                    <span className={`notification-detail-value ${emb.ollamaAvailable ? 'ok' : 'warn'}`}>
                      {emb.ollamaAvailable ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  {!emb.ollamaAvailable && (
                    <ErrorSuggestionLink
                      suggestion="Install and start Ollama for semantic search."
                      settingsHash="search"
                      settingsLabel="Search"
                      installTarget="ollama"
                    />
                  )}

                  {emb.lastError && (
                    <div className="notification-detail-row error">
                      <span className="notification-error-text">{emb.lastError}</span>
                      {(() => {
                        const sug = getErrorSuggestion(emb.lastError, { domain: 'embedding' });
                        return sug ? <ErrorSuggestionLink {...sug} /> : null;
                      })()}
                    </div>
                  )}

                  {emb.lastReconcileAt && (
                    <div className="notification-detail-row muted">
                      <span>Last check</span>
                      <span className="notification-detail-value">
                        {formatRelative(emb.lastReconcileAt)}
                      </span>
                    </div>
                  )}
                </div>

                {!embeddingOk && (
                  <button
                    className="notification-retry-btn"
                    onClick={triggerReindex}
                    disabled={reindexing}
                  >
                    {reindexing ? 'Reindexing...' : 'Retry'}
                  </button>
                )}
              </div>

              {/* Remote daemons status */}
              {health.daemons && health.daemons.length > 0 && (
                <div className={`notification-card ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
                  <div className="notification-card-row">
                    <span className={`notification-card-icon ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
                      {health.daemons.some(d => d.connected) ? '\u2713' : '\u25CB'}
                    </span>
                    <span className="notification-card-label">Remote Hosts</span>
                  </div>

                  <div className="notification-card-details">
                    {health.daemons.map((d) => (
                      <div key={d.host} className="notification-detail-row">
                        <span>{d.label ?? d.host}</span>
                        <span className={`notification-detail-value ${d.connected ? 'ok' : 'muted'}`}>
                          {d.connected ? 'Connected' : 'Idle'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Git backup status */}
              <div className={`notification-card ${gitOk ? 'ok' : 'warn'}`}>
                <div className="notification-card-row">
                  <span className={`notification-card-icon ${gitOk ? 'ok' : 'warn'}`}>
                    {gitOk ? '\u2713' : '\u26A0'}
                  </span>
                  <span className="notification-card-label">Data Backup</span>
                </div>

                <div className="notification-card-details">
                  {!gitSync.protected ? (
                    <div className="notification-detail-row warn">
                      <span>Not protected</span>
                      <span className="notification-detail-value">
                        {gitSync.error ?? 'git unavailable'}
                      </span>
                      <ErrorSuggestionLink
                        suggestion="Configure git backup for data protection."
                        settingsHash="integrations"
                        settingsLabel="Integrations"
                      />
                    </div>
                  ) : gitSync.consecutiveFailures >= 3 ? (
                    <>
                      <div className="notification-detail-row warn">
                        <span>Status</span>
                        <span className="notification-detail-value">Failing</span>
                      </div>
                      <div className="notification-detail-row">
                        <span>Consecutive failures</span>
                        <span className="notification-detail-value">{gitSync.consecutiveFailures}</span>
                      </div>
                      {gitSync.error && (
                        <div className="notification-detail-row error">
                          <span className="notification-error-text">{gitSync.error}</span>
                          <ErrorSuggestionLink
                            suggestion="Check git backup configuration."
                            settingsHash="integrations"
                            settingsLabel="Integrations"
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="notification-detail-row">
                      <span>Status</span>
                      <span className="notification-detail-value ok">Protected</span>
                    </div>
                  )}

                  {gitSync.lastCommitAt && (
                    <div className="notification-detail-row muted">
                      <span>Last backup</span>
                      <span className="notification-detail-value">
                        {formatRelative(gitSync.lastCommitAt)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function formatRelative(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

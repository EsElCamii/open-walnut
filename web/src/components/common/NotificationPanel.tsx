/**
 * Notification panel — slide-out overlay from sidebar. Two zones:
 *   1. Recent — the persistent notification feed (cron / permission / errors),
 *      from NotificationProvider. Opening the panel marks all read.
 *   2. System — ambient health (remote hosts, data backup, embedding search).
 */
import { useEffect, useMemo, useState } from 'react';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useNotifications } from '@/contexts/notifications';
import { log } from '@/utils/log';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

interface QmdStoreStats {
  totalIndexed: number;
  totalEmbedded: number;
  totalChunks: number;
  collections: Record<string, { indexed: number; embedded: number; chunks: number }>;
}

interface QmdStatus {
  model: { name: string; downloaded: boolean };
  stores: {
    memory: QmdStoreStats | null;
    notes: QmdStoreStats | null;
    tasks: QmdStoreStats | null;
    sessions: QmdStoreStats | null;
  };
  status: 'ready' | 'indexing' | 'downloading' | 'error';
  error: string | null;
  progress: { chunksEmbedded: number; totalChunks: number; store: string } | null;
}

export function NotificationPanel({ open, onClose, sidebarCollapsed }: NotificationPanelProps) {
  const { health, gitSync, loading } = useSystemHealth();
  const { feed, unreadCount, markAllRead } = useNotifications();
  const [qmdStatus, setQmdStatus] = useState<QmdStatus | null>(null);

  // Newest-first for display. Memoized so the copy+reverse doesn't run on every
  // render (e.g. the 3s QMD poll re-renders below while the panel is open).
  const feedNewestFirst = useMemo(() => [...feed].reverse(), [feed]);

  // Opening the panel clears the unread badge (everything in the feed is now seen).
  // Re-fires while open if new persistent events arrive (unreadCount climbs again) —
  // intentional: items seen while watching the panel should be marked read too.
  useEffect(() => {
    if (open && unreadCount > 0) markAllRead();
  }, [open, unreadCount, markAllRead]);

  // Fetch QMD status on mount, poll every 3s while indexing/downloading
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    const fetchQmd = () => {
      fetch('/api/qmd/status', { signal: ac.signal })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((data: QmdStatus) => setQmdStatus(data))
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          log.warn('notifications', 'QMD status fetch failed', { error: String(err) });
        });
    };
    fetchQmd();
    const interval = setInterval(() => {
      if (qmdStatus?.status === 'indexing' || qmdStatus?.status === 'downloading') fetchQmd();
    }, 3000);
    return () => { ac.abort(); clearInterval(interval); };
  }, [open, qmdStatus?.status]);

  if (!open) return null;

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
          {/* Zone 1 — Recent: the persistent notification feed (newest first). */}
          <div className="notification-section-label">Recent</div>
          {feedNewestFirst.length === 0 ? (
            <div className="notification-feed-empty">No notifications yet</div>
          ) : (
            <div className="notification-feed">
              {feedNewestFirst.map((n) => (
                <div key={n.id} className={`notification-feed-item notification-feed-item--${n.severity}${n.read ? '' : ' unread'}`}>
                  <div className="notification-feed-item-head">
                    <span className={`notification-feed-dot notification-feed-dot--${n.severity}`} />
                    <span className="notification-feed-item-title">{n.title}</span>
                    <span className="notification-feed-item-time">{formatRelative(new Date(n.timestamp).toISOString())}</span>
                  </div>
                  {n.body && <div className="notification-feed-item-body">{n.body}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Zone 2 — System: ambient health (daemons / backup / embedding search). */}
          <div className="notification-section-label">System</div>
          {loading ? (
            <div className="notification-card">
              <span className="notification-card-icon loading">...</span>
              <span>Loading...</span>
            </div>
          ) : (
            <>
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

              {/* Embedding Search status */}
              {qmdStatus && (
                <div className={`notification-card ${qmdStatus.status === 'error' ? 'warn' : 'ok'}`}>
                  <div className="notification-card-row">
                    <span className={`notification-card-icon ${
                      qmdStatus.status === 'error' ? 'error'
                        : (qmdStatus.status === 'downloading' || qmdStatus.status === 'indexing') ? 'pulsing'
                        : 'ok'
                    }`}>
                      {qmdStatus.status === 'error' ? '\u2717' : '\u2713'}
                    </span>
                    <span className="notification-card-label">Embedding Search</span>
                  </div>

                  <div className="notification-card-details">
                    <div className="notification-detail-row">
                      <span>Model</span>
                      <span className={`notification-detail-value ${
                        qmdStatus.status === 'ready' ? 'ok'
                          : qmdStatus.status === 'error' ? 'warn'
                          : ''
                      }`}>
                        {qmdStatus.model.name}{' '}
                        ({qmdStatus.status === 'ready' ? 'Ready'
                          : qmdStatus.status === 'downloading' ? 'Downloading'
                          : qmdStatus.status === 'indexing'
                            ? (qmdStatus.progress && qmdStatus.progress.totalChunks > 0
                              ? `Indexing ${qmdStatus.progress.store} ${Math.round(qmdStatus.progress.chunksEmbedded / qmdStatus.progress.totalChunks * 100)}%`
                              : 'Indexing')
                          : 'Error'})
                      </span>
                    </div>
                    {/* Memory store health */}
                    {qmdStatus.stores.memory && (
                      <div className="notification-detail-row">
                        <span>Memory</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.memory.totalEmbedded >= qmdStatus.stores.memory.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.memory.totalEmbedded}/{qmdStatus.stores.memory.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.memory.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Notes store health */}
                    {qmdStatus.stores.notes && (
                      <div className="notification-detail-row">
                        <span>Notes</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.notes.totalEmbedded >= qmdStatus.stores.notes.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.notes.totalEmbedded}/{qmdStatus.stores.notes.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.notes.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Tasks store health */}
                    {qmdStatus.stores.tasks && (
                      <div className="notification-detail-row">
                        <span>Tasks</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.tasks.totalEmbedded >= qmdStatus.stores.tasks.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.tasks.totalEmbedded}/{qmdStatus.stores.tasks.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.tasks.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Sessions store health */}
                    {qmdStatus.stores.sessions && (
                      <div className="notification-detail-row">
                        <span>Sessions</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.sessions.totalEmbedded >= qmdStatus.stores.sessions.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.sessions.totalEmbedded}/{qmdStatus.stores.sessions.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.sessions.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {qmdStatus.error && (
                      <div className="notification-detail-row error">
                        <span className="notification-error-text">{qmdStatus.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
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

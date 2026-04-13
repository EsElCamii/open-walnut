import { useState, useEffect } from 'react';
import { fetchPhaseHooks, type PhaseHookInfo } from '@/api/hooks';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const ACTION_ICON: Record<string, string> = {
  send_message: '\u{1F4AC}',
  invoke_agent: '\u{1F916}',
  schedule_check: '\u23F1',
};

export function HooksSection() {
  const [hooks, setHooks] = useState<PhaseHookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPhaseHooks()
      .then(setHooks)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load hooks'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div id="hooks"><LoadingSpinner /></div>;
  if (error) return <div id="hooks"><div className="empty-state"><p>Error: {error}</p></div></div>;

  return (
    <div id="hooks" className="card settings-section settings-section-wide">
      <h3 className="settings-section-title">Phase Hooks</h3>
      <p className="settings-section-subtitle">Automated actions triggered by task phase transitions</p>

      {hooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{'\u26A1'}</div>
          <p>No hooks registered</p>
          <p className="text-sm" style={{ marginTop: 8 }}>
            Hooks are defined in the server code and execute automatically when tasks change phase
          </p>
        </div>
      ) : (
        <div className="hooks-list">
          {hooks.map((hook) => (
            <div key={hook.id} className="hook-card">
              <div className="hook-card-header">
                <span className="hook-card-icon">
                  {ACTION_ICON[hook.actionType] ?? '\u26A1'}
                </span>
                <span className="hook-card-name">{hook.name}</span>
                <span className="hook-card-priority" title="Priority (lower = runs first)">
                  #{hook.priority}
                </span>
              </div>

              <p className="hook-card-description">{hook.description}</p>

              <div className="hook-card-details">
                <div className="hook-card-detail">
                  <span className="hook-card-detail-label">Trigger</span>
                  <span className="hook-card-detail-value hook-card-phase">
                    {'\u2192'} {hook.triggerPhase.replace(/_/g, ' ')}
                  </span>
                </div>

                <div className="hook-card-detail">
                  <span className="hook-card-detail-label">Action</span>
                  <span className="hook-card-detail-value">{hook.actionType.replace(/_/g, ' ')}</span>
                </div>

                {hook.conditions.length > 0 && (
                  <div className="hook-card-detail">
                    <span className="hook-card-detail-label">Conditions</span>
                    <span className="hook-card-detail-value">
                      {hook.conditions.join(' \u00B7 ')}
                    </span>
                  </div>
                )}
              </div>

              {hook.actionType === 'send_message' && hook.actionDetail && (
                <div className="hook-card-message">
                  <div className="hook-card-message-label">Message</div>
                  <pre className="hook-card-message-content">
                    {hook.actionDetail.replace(/^Send message: "/, '').replace(/"$/, '')}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-sm text-muted" style={{ marginTop: 24 }}>
        Hooks are defined server-side. Future hooks will appear here as they are registered.
      </p>
    </div>
  );
}

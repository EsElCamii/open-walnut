import { useState, useEffect } from 'react';
import { fetchPhaseHooks, type PhaseHookInfo } from '@/api/hooks';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const ACTION_ICON: Record<string, string> = {
  send_message: '💬',
  invoke_agent: '🤖',
  schedule_check: '⏱',
};

export function HooksPage() {
  const [hooks, setHooks] = useState<PhaseHookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPhaseHooks()
      .then(setHooks)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load hooks'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Phase Hooks</h1>
        <p className="page-subtitle">
          Automated actions triggered by task phase transitions
        </p>
      </div>

      {hooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">⚡</div>
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
                  {ACTION_ICON[hook.actionType] ?? '⚡'}
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
                    → {hook.triggerPhase.replace(/_/g, ' ')}
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
                      {hook.conditions.join(' · ')}
                    </span>
                  </div>
                )}
              </div>

              {hook.actionType === 'send_message' && hook.actionDetail && (
                <div className="hook-card-message">
                  <div className="hook-card-message-label">Message</div>
                  <pre className="hook-card-message-content">
                    {/* Strip the 'Send message: "..."' wrapper produced by describeAction() in registry.ts */}
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

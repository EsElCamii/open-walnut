/**
 * AgentSwitcher — horizontal pill buttons for switching between console agents.
 * Shows unread badge when a non-active agent has new messages.
 */

import type { AgentDefinition } from '@/api/agents';

interface AgentSwitcherProps {
  agents: AgentDefinition[];
  activeAgentId: string;
  unreadCounts: Record<string, number>;
  onSwitch: (agentId: string) => void;
}

export function AgentSwitcher({ agents, activeAgentId, unreadCounts, onSwitch }: AgentSwitcherProps) {
  if (agents.length <= 1) return null;

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        const unread = unreadCounts[agent.id] || 0;
        return (
          <button
            key={agent.id}
            onClick={() => onSwitch(agent.id)}
            style={{
              padding: '2px 10px',
              borderRadius: 12,
              border: 'none',
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              position: 'relative',
              background: isActive ? 'var(--color-accent, #3b82f6)' : 'var(--color-surface-secondary, #f0f0f0)',
              color: isActive ? '#fff' : 'var(--color-text-secondary, #666)',
              transition: 'background 0.15s, color 0.15s',
            }}
            title={agent.description}
          >
            {agent.name}
            {unread > 0 && !isActive && (
              <span
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  background: '#ef4444',
                  color: '#fff',
                  borderRadius: '50%',
                  minWidth: 16,
                  height: 16,
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 4px',
                }}
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

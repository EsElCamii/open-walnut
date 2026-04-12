/**
 * useAgentConsole — manages console agent state.
 *
 * Provides: activeAgentId, agent list, switching, unread badge counts.
 * Persists activeAgentId to localStorage so it survives page refresh.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentDefinition } from '@/api/agents';

const STORAGE_KEY = 'walnut:activeAgentId';

export interface AgentConsoleState {
  /** Currently active console agent ID. */
  activeAgentId: string;
  /** All available console agents. */
  agents: AgentDefinition[];
  /** Switch to a different agent. */
  switchAgent: (agentId: string) => void;
  /** Unread message counts per agent (excludes the active agent). */
  unreadCounts: Record<string, number>;
}

export function useAgentConsole(): AgentConsoleState {
  const [activeAgentId, setActiveAgentId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'general';
    } catch {
      return 'general';
    }
  });
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [unreadCounts] = useState<Record<string, number>>({});
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;

  // Fetch console agents on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { fetchAgents } = await import('@/api/agents');
        const all = await fetchAgents();
        if (cancelled) return;
        const consoleAgents = all.filter((a: AgentDefinition) => a.console);
        setAgents(consoleAgents);
      } catch (err) {
        console.warn('useAgentConsole: failed to load agents', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // TODO: wire up unread tracking using event subscriptions

  const switchAgent = useCallback((agentId: string) => {
    setActiveAgentId(agentId);
    try {
      localStorage.setItem(STORAGE_KEY, agentId);
    } catch { /* localStorage unavailable */ }
  }, []);

  return {
    activeAgentId,
    agents,
    switchAgent,
    unreadCounts,
  };
}

/**
 * Hook to fetch and track system health (git-sync, daemons, etc.).
 * Fetches on mount, then listens for real-time updates via WebSocket.
 */
import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';

export interface GitSyncHealth {
  protected: boolean;
  error?: string;
  lastCommitAt?: string;
  consecutiveFailures: number;
}

export interface DaemonHealth {
  host: string;
  label?: string;
  connected: boolean;
}

export interface SystemHealth {
  daemons?: DaemonHealth[];
}

const defaultHealth: SystemHealth = {};

const defaultGitSync: GitSyncHealth = {
  protected: true,
  consecutiveFailures: 0,
};

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth>(defaultHealth);
  const [gitSync, setGitSync] = useState<GitSyncHealth>(defaultGitSync);
  const [loading, setLoading] = useState(true);

  // Fetch initial state
  useEffect(() => {
    fetch('/api/system/health')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: SystemHealth) => {
        setHealth(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });

    // Fetch git-sync status separately
    fetch('/api/git-sync/status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: GitSyncHealth) => setGitSync(data))
      .catch(() => {});
  }, []);

  // Listen for real-time updates
  useEvent('system:health', useCallback((data: unknown) => {
    if (data && typeof data === 'object') {
      setHealth(data as SystemHealth);
    }
  }, []));

  // Listen for git-sync status updates
  useEvent('git-sync:status', useCallback((data: unknown) => {
    if (data && typeof data === 'object') {
      setGitSync(data as GitSyncHealth);
    }
  }, []));

  const gitSyncFailing = !gitSync.protected || gitSync.consecutiveFailures >= 3;
  const hasIssues = gitSyncFailing;

  return { health, gitSync, hasIssues, loading };
}

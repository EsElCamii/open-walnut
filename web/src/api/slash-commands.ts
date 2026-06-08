import { apiGet } from './client';

export interface SlashCommandItem {
  name: string;
  description: string;
  source: 'skill' | 'walnut' | 'claude-root' | 'project' | 'built-in';
}

export async function fetchSlashCommands(cwd?: string, host?: string, fresh?: boolean): Promise<SlashCommandItem[]> {
  const params: Record<string, string> = {};
  if (cwd) params.cwd = cwd;
  if (host) params.host = host;
  if (fresh) params.fresh = '1';
  // Remote discovery (host set) does an SSH round-trip to the daemon; allow more
  // than the backend's own 15s remote timeout so we receive its degraded response
  // instead of the client aborting first.
  const opts = host ? { timeoutMs: 25_000 } : undefined;
  const res = await apiGet<{ items: SlashCommandItem[] }>('/api/slash-commands', params, opts);
  return res.items;
}

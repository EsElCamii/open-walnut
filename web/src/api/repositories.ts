import { apiGet, apiPost, apiDelete } from './client';

export interface RepoSummary {
  slug: string;
  name: string;
  description: string;
  tech_stack: string;
  hosts: Record<string, { path?: string; ssh_host?: string }>;
  modified: string;
  size: number;
}

export interface RepoDetail {
  slug: string;
  content: string;
  modified: string;
}

export async function fetchRepositories(): Promise<RepoSummary[]> {
  const res = await apiGet<{ repositories: RepoSummary[] }>('/api/repositories');
  return res.repositories;
}

export async function fetchRepository(name: string): Promise<RepoDetail> {
  return apiGet<RepoDetail>(`/api/repositories/${encodeURIComponent(name)}`);
}

export async function saveRepository(name: string, content: string): Promise<{ ok: boolean; status: string }> {
  return apiPost<{ ok: boolean; status: string }>(`/api/repositories/${encodeURIComponent(name)}`, { content });
}

export async function deleteRepository(name: string): Promise<void> {
  await apiDelete(`/api/repositories/${encodeURIComponent(name)}`);
}

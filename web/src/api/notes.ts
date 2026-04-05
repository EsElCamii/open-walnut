import { apiGet, apiPost, apiPut } from './client';

export async function fetchGlobalNotes(): Promise<{ content: string; contentHash: string }> {
  return apiGet<{ content: string; contentHash: string }>('/api/notes/global');
}

export async function saveGlobalNotes(content: string, expectedHash?: string): Promise<{ contentHash: string }> {
  return apiPut<{ ok: boolean; contentHash: string }>('/api/notes/global', { content, expectedHash });
}

/** Upload a base64 image and return the server URL */
export async function uploadNoteImage(data: string, mediaType: string): Promise<string> {
  const res = await apiPost<{ url: string }>('/api/images/upload', { data, mediaType });
  return res.url;
}

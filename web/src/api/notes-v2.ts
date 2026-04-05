import { apiGet, apiPut, apiPost, apiDelete } from './client';

export interface NoteTreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: NoteTreeNode[];
}

export interface NoteListItem {
  path: string;
  name: string;
}

export interface SearchResult {
  path: string;
  name: string;
  snippet: string;
}

export interface BacklinkResult {
  path: string;
  name: string;
  snippet: string;
}

export async function fetchNotesTree(): Promise<NoteTreeNode[]> {
  const res = await apiGet<{ tree: NoteTreeNode[] }>('/api/notes-v2');
  return res.tree;
}

export async function fetchNoteContent(notePath: string): Promise<{ content: string; updatedAt: string; contentHash: string }> {
  return apiGet<{ content: string; updatedAt: string; contentHash: string }>(`/api/notes-v2/content/${notePath}`);
}

export async function saveNoteContent(notePath: string, content: string, expectedHash?: string): Promise<{ updatedAt: string; contentHash: string }> {
  return apiPut<{ ok: boolean; updatedAt: string; contentHash: string }>(`/api/notes-v2/content/${notePath}`, { content, expectedHash });
}

export async function deleteNote(notePath: string): Promise<void> {
  await apiDelete(`/api/notes-v2/content/${notePath}`);
}

export async function moveNote(from: string, to: string): Promise<void> {
  await apiPost('/api/notes-v2/move', { from, to });
}

export async function createFolder(folderPath: string): Promise<void> {
  await apiPost('/api/notes-v2/folder', { path: folderPath });
}

export async function searchNotes(query: string): Promise<SearchResult[]> {
  const res = await apiGet<{ results: SearchResult[] }>('/api/notes-v2/search', { q: query });
  return res.results;
}

export async function fetchBacklinks(notePath: string): Promise<BacklinkResult[]> {
  const res = await apiGet<{ backlinks: BacklinkResult[] }>(`/api/notes-v2/backlinks/${notePath}`);
  return res.backlinks;
}

export async function fetchNotesList(): Promise<NoteListItem[]> {
  const res = await apiGet<{ notes: NoteListItem[] }>('/api/notes-v2/list');
  return res.notes;
}

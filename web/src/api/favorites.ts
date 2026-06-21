import { apiGet, apiPost, apiDelete } from './client';

export interface Favorites {
  categories: string[];
  projects: string[];
  /** Vault-relative note paths (WITH .md), e.g. "PARA/foo.md". */
  notes: string[];
}

export async function fetchFavorites(): Promise<Favorites> {
  return apiGet<Favorites>('/api/favorites');
}

export async function addFavoriteCategory(name: string): Promise<void> {
  await apiPost(`/api/favorites/categories/${encodeURIComponent(name)}`);
}

export async function removeFavoriteCategory(name: string): Promise<void> {
  await apiDelete(`/api/favorites/categories/${encodeURIComponent(name)}`);
}

export async function addFavoriteProject(name: string): Promise<void> {
  await apiPost(`/api/favorites/projects/${encodeURIComponent(name)}`);
}

export async function removeFavoriteProject(name: string): Promise<void> {
  await apiDelete(`/api/favorites/projects/${encodeURIComponent(name)}`);
}

// Note paths contain slashes + .md, so add goes in the request BODY (the BE reads
// req.body.path). Remove uses the query string, since the shared apiDelete client
// helper sends no body — the BE accepts ?path= as the documented fallback. Paths
// are stored/compared verbatim WITH .md (exact-string match, no normalization).
export async function addFavoriteNote(path: string): Promise<void> {
  await apiPost('/api/favorites/notes', { path });
}

export async function removeFavoriteNote(path: string): Promise<void> {
  await apiDelete(`/api/favorites/notes?path=${encodeURIComponent(path)}`);
}

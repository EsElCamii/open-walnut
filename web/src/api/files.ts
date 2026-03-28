/** Fetch file content for the FileViewer overlay. */

export interface FileContentResponse {
  content: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
  extension: string;
}

export async function fetchFileContent(
  filePath: string,
  host?: string,
): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path: filePath });
  if (host) params.set('host', host);

  const res = await fetch(`/api/file-content?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
  return res.json();
}

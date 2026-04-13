export type InstallTarget = 'claude-cli' | 'ollama';

export interface InstallResult {
  ok: boolean;
  error?: string;
}

export async function installDependency(target: InstallTarget): Promise<InstallResult> {
  const res = await fetch('/api/system/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    return { ok: false, error: data.error ?? res.statusText };
  }
  return res.json();
}

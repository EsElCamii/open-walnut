import { apiGet, apiPost } from './client';

export interface RecordingStatus {
  recording: boolean;
  recordingId: string | null;
  source: 'system' | 'mic' | 'both' | null;
  mode: 'continuous' | 'on-demand' | null;
  apps: string[];
  startedAt: string | null;
  currentChunkIndex: number;
  currentChunkDuration: number;
  totalDuration: number;
}

export interface AudioAvailability {
  available: boolean;
  permissions: { granted: boolean; message: string } | null;
}

export interface AppInfo {
  processId: number;
  bundleIdentifier: string;
  applicationName: string;
}

export interface StartRecordingOptions {
  source?: 'system' | 'mic' | 'both';
  mode?: 'continuous' | 'on-demand';
  apps?: string[];
  chunkMinutes?: number;
}

export async function fetchAudioStatus(): Promise<RecordingStatus> {
  return apiGet<RecordingStatus>('/api/audio/status');
}

export async function fetchAudioAvailability(): Promise<AudioAvailability> {
  return apiGet<AudioAvailability>('/api/audio/available');
}

export async function fetchAudioApps(): Promise<AppInfo[]> {
  const res = await apiGet<{ apps: AppInfo[] }>('/api/audio/apps');
  return res.apps;
}

export async function startRecording(options?: StartRecordingOptions): Promise<{ recordingId: string }> {
  return apiPost<{ recordingId: string }>('/api/audio/start', options ?? {});
}

export async function stopRecording(): Promise<{ recordingId: string; chunks: number; totalDuration: number }> {
  return apiPost<{ recordingId: string; chunks: number; totalDuration: number }>('/api/audio/stop');
}

export interface RecordingListEntry {
  date: string;
  files: Array<{ name: string; size: number; meta?: Record<string, unknown> }>;
}

export async function fetchRecordings(): Promise<RecordingListEntry[]> {
  const res = await apiGet<{ recordings: RecordingListEntry[] }>('/api/audio/recordings');
  return res.recordings;
}

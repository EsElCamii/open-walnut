/**
 * SessionFileReader — unified file access for local and remote session data.
 *
 * Provides a single interface for reading session JSONL files and subagent
 * directories, whether the session ran locally or on a remote host via SSH.
 *
 * Local sessions:  fs.readFile / fs.readdir (async — non-blocking)
 * Remote sessions: DaemonFileReader (WebSocket via walnut-daemon)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_HOME } from '../constants.js';
import { log } from '../logging/index.js';

// ── Path helpers ──

/**
 * Encode a working directory path the way Claude Code does.
 * /Users/foo/bar → -Users-foo-bar
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

/** Build the canonical JSONL path for a session (local absolute path). */
export function canonicalJsonlPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, `${sessionId}.jsonl`);
}

/** Build the remote JSONL path (tilde-based, for SSH commands). */
export function remoteJsonlPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}.jsonl`;
  }
  return `~/.claude/projects/*/${sessionId}.jsonl`;
}

/** Build the subagents directory path (local absolute). */
export function subagentDirPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, sessionId, 'subagents');
}

/** Build the remote subagents directory path (tilde-based). */
export function remoteSubagentDirPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}/subagents`;
  }
  return `~/.claude/projects/*/${sessionId}/subagents`;
}

// ── Async file-existence check ──

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── JSONL content helpers ──

/**
 * Extract the working directory from JSONL content.
 * Claude Code writes `cwd` on the first `type: "user"` entry.
 */
export function extractCwdFromJsonlContent(content: string): string | undefined {
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if ((entry.type === 'user' || entry.type === 'human') && entry.cwd) {
        return entry.cwd;
      }
    } catch (err) {
      log.session.debug('failed to parse JSONL line while extracting cwd', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}

// ── Interface ──

export interface SessionFileReader {
  /** Read a file's contents. Returns null if the file doesn't exist or on error. */
  readFile(filePath: string): Promise<string | null>;
  /** List directory entries. Returns empty array if dir doesn't exist or on error. */
  listDir(dirPath: string): Promise<string[]>;
}

// ── Local implementation ──

export class LocalFileReader implements SessionFileReader {
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch (err) {
      log.session.debug('local file read failed', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async listDir(dirPath: string): Promise<string[]> {
    try {
      return await fsp.readdir(dirPath);
    } catch (err) {
      log.session.debug('local dir read failed', {
        dirPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

// ── Factory ──

/** Create the appropriate file reader for local or remote sessions. */
export async function createFileReader(host?: string): Promise<SessionFileReader> {
  if (host) {
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    return new DaemonFileReader(host);
  }
  return new LocalFileReader();
}

// ── High-level helpers ──

/**
 * Find the local JSONL file for a session (async — non-blocking).
 * If cwd provided, check the exact encoded path.
 * Fallback: search all project dirs for the session ID.
 */
export async function findLocalJsonlPath(sessionId: string, cwd?: string): Promise<string | null> {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  if (cwd) {
    const filePath = canonicalJsonlPath(sessionId, cwd);
    if (await fileExists(filePath)) return filePath;
  }

  // Fallback: search all project directories
  try {
    const dirs = await fsp.readdir(projectsDir);
    for (const dir of dirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (await fileExists(filePath)) return filePath;
    }
  } catch (err) {
    log.session.debug('failed to scan projects dir for session', {
      projectsDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}

/** Result from readSessionJsonlContent with optional CWD auto-discovery. */
export type ReadSessionResult = {
  content: string;
  source: 'local' | 'stream' | 'outputFile' | 'remote';
  /** CWD extracted from JSONL content — may differ from the cwd parameter when found via fallback search. */
  foundCwd?: string;
};

/**
 * Read session JSONL content using the appropriate reader.
 * Tries local paths first, then falls back to remote if host is provided.
 *
 * Returns { content, source, foundCwd } where source indicates where data was read from.
 * foundCwd is extracted from the JSONL content (first user message's cwd field) —
 * useful when the provided cwd was wrong but the session was found via fallback search.
 */
export async function readSessionJsonlContent(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
): Promise<ReadSessionResult | null> {
  const { SESSION_STREAMS_DIR } = await import('../constants.js');

  // Helper: attach foundCwd from JSONL content
  const withFoundCwd = (content: string, source: ReadSessionResult['source']): ReadSessionResult => {
    const foundCwd = extractCwdFromJsonlContent(content);
    return { content, source, ...(foundCwd ? { foundCwd } : {}) };
  };

  // Helper: extract synthetic walnut-injected user events from the local streams file.
  // Local sessions write synthetic events (walnut-injected user messages) to their
  // streams capture file, but the canonical JSONL (owned by Claude Code) never sees them.
  // This merges them into remote-fetched content so user messages appear in history.
  // NOTE: Remote sessions do NOT have a local streams file (RemoteSessionManager.outputFile
  // returns null, writeSyntheticUserEvent is a no-op). This helper silently returns
  // unmodified content when no local streams file exists.
  const mergeSyntheticFromLocalStreams = async (remoteContent: string): Promise<string> => {
    const streamFilePath = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`);
    try {
      const streamContent = await fsp.readFile(streamFilePath, 'utf-8');
      const syntheticLines: string[] = [];
      for (const line of streamContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'user' && evt.subtype === 'walnut-injected') {
            syntheticLines.push(line);
          }
        } catch (err) {
          log.session.debug('failed to parse stream event line', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (syntheticLines.length > 0) {
        return remoteContent + '\n' + syntheticLines.join('\n');
      }
    } catch {
      // File doesn't exist or can't be read — no synthetic events to merge
    }
    return remoteContent;
  };

  // 1. Canonical JSONL — source of truth.
  //    Dispatch on host (like readSubagentContents): remote daemon first, else local fs.
  //    Remote sessions have no local canonical file, so we must use daemon first.
  if (host) {
    const REMOTE_READ_TIMEOUT = 10_000; // 10s max — prevents daemon reconnect from blocking the event loop
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(host);
    const exactPath = cwd ? remoteJsonlPath(sessionId, cwd) : null;
    const globPath = remoteJsonlPath(sessionId); // ~/.claude/projects/*/${sessionId}.jsonl

    try {
      const result = await Promise.race([
        (async () => {
          // Try exact encoded path first, then glob fallback, then find fallback.
          if (exactPath) {
            const content = await reader.readFile(exactPath);
            if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote');
          }
          const content = await reader.readFile(globPath);
          if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote');
          const findContent = await reader.findSession(sessionId);
          if (findContent) return withFoundCwd(await mergeSyntheticFromLocalStreams(findContent), 'remote');
          return null;
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Remote read timeout (10s)')), REMOTE_READ_TIMEOUT),
        ),
      ]);
      if (result) return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.session.warn('remote JSONL read failed', {
        host, sessionId,
        error: errMsg,
      });
      throw new Error(`Remote read failed (${host}): ${errMsg}`);
    }
  } else {
    // Local session: read canonical JSONL (source of truth).
    // Streams file is only used as a fallback (step 2 below).
    const localPath = await findLocalJsonlPath(sessionId, cwd);
    if (localPath) {
      try {
        const content = await fsp.readFile(localPath, 'utf-8');
        if (content) return withFoundCwd(content, 'local');
      } catch (err) {
        log.session.debug('failed to read local JSONL file', {
          localPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 2. Local streaming capture (SESSION_STREAMS_DIR) — fallback for LOCAL sessions only.
  //    Only local sessions create streams files (via LocalIO); remote sessions have no
  //    local output file (RemoteSessionManager.outputFile returns null).
  //    Useful when the canonical JSONL is missing (e.g. deleted or not yet written).
  //    Direct filename lookup: streams files are renamed to {sessionId}.jsonl
  //    (see SessionIO.renameForSession() in session-io.ts).
  {
    const streamFilePath = path.join(SESSION_STREAMS_DIR, `${sessionId}.jsonl`);
    try {
      const content = await fsp.readFile(streamFilePath, 'utf-8');
      if (content) return withFoundCwd(content, 'stream');
    } catch {
      // File doesn't exist — no stream capture for this session
    }
  }

  // 3. Direct outputFile path (tmp file not yet renamed)
  if (outputFile) {
    try {
      const content = await fsp.readFile(outputFile, 'utf-8');
      if (content) return withFoundCwd(content, 'outputFile');
    } catch {
      // File doesn't exist or can't be read
    }
  }

  return null;
}

/**
 * Read subagent JSONL files for a session.
 * For local sessions: reads from filesystem directly.
 * For remote sessions: uses batched SSH to read all subagent files in one call.
 *
 * Returns a Map<agentId, rawContent> (callers parse the content themselves).
 */
export async function readSubagentContents(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<Map<string, string>> {
  if (host) {
    return readRemoteSubagentContents(sessionId, cwd, host);
  }
  return readLocalSubagentContents(sessionId, cwd);
}

async function readLocalSubagentContents(sessionId: string, cwd?: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  const candidates: string[] = [];
  if (cwd) {
    candidates.push(subagentDirPath(sessionId, cwd));
  }
  // Fallback: search all project directories
  try {
    for (const dir of await fsp.readdir(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId, 'subagents');
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch (err) {
    log.session.debug('failed to scan projects dir for subagents', {
      projectsDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const subDir of candidates) {
    if (!(await fileExists(subDir))) continue;
    try {
      const files = await fsp.readdir(subDir);
      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        const agentId = file.slice('agent-'.length, -'.jsonl'.length);
        try {
          const content = await fsp.readFile(path.join(subDir, file), 'utf-8');
          if (content) result.set(agentId, content);
        } catch (err) {
          log.session.debug('failed to read subagent file', {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.session.debug('failed to read subagent directory', {
        subDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (result.size > 0) break;
  }

  return result;
}

/**
 * Read a single subagent JSONL file by agentId.
 * Returns the raw content string, or null if not found.
 */
export async function readSingleSubagentContent(
  sessionId: string,
  agentId: string,
  cwd?: string,
  host?: string,
): Promise<string | null> {
  const filename = `agent-${agentId}.jsonl`;

  if (host) {
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(host);
    const remotePath = cwd
      ? `${remoteSubagentDirPath(sessionId, cwd)}/${filename}`
      : `~/.claude/projects/*/${sessionId}/subagents/${filename}`;
    try {
      return await reader.readFile(remotePath);
    } catch (err) {
      log.session.debug('remote single subagent read failed', {
        host, sessionId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Local: check cwd-based path first, then fallback search
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  const candidates: string[] = [];
  if (cwd) {
    candidates.push(path.join(subagentDirPath(sessionId, cwd), filename));
  }
  try {
    for (const dir of await fsp.readdir(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId, 'subagents', filename);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch {
    // projects dir scan failed — continue with what we have
  }

  for (const filePath of candidates) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      if (content) return content;
    } catch {
      // file doesn't exist at this path — try next
    }
  }
  return null;
}

async function readRemoteSubagentContents(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<Map<string, string>> {
  if (!host) return new Map();

  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  const reader = new DaemonFileReader(host);
  const remotePath = remoteSubagentDirPath(sessionId, cwd);

  try {
    const fileMap = await reader.batchReadSubagents(remotePath);
    // Convert filename → agentId
    const result = new Map<string, string>();
    for (const [filename, content] of fileMap) {
      if (!filename.startsWith('agent-') || !filename.endsWith('.jsonl')) continue;
      const agentId = filename.slice('agent-'.length, -'.jsonl'.length);
      result.set(agentId, content);
    }
    return result;
  } catch (err) {
    log.session.debug('remote subagent read failed', {
      host, sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * SessionFileReader — unified file access for local and remote session data.
 *
 * Provides a single interface for reading session JSONL files and subagent
 * directories, whether the session ran locally or on a remote host via SSH.
 *
 * Local sessions:  fs.readFile / fs.readdir (async — non-blocking)
 * Remote sessions: ssh cat / ssh ls (batched where possible)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CLAUDE_HOME } from '../constants.js';
import { getConfig } from './config-manager.js';
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

// ── Remote implementation ──

export class RemoteFileReader implements SessionFileReader {
  private sshTarget: string;
  private sshArgs: string[];

  constructor(private host: string) {
    // Resolved lazily on first use
    this.sshTarget = '';
    this.sshArgs = [];
  }

  private async resolve(): Promise<void> {
    if (this.sshTarget) return;
    const config = await getConfig();
    const hostConfig = config.hosts?.[this.host];
    if (!hostConfig) {
      throw new Error(`Unknown SSH host: ${this.host}`);
    }
    this.sshTarget = hostConfig.user
      ? `${hostConfig.user}@${hostConfig.hostname}`
      : hostConfig.hostname;
    this.sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no'];
    if (hostConfig.port) {
      this.sshArgs.push('-p', String(hostConfig.port));
    }
  }

  private execSsh(remoteCmd: string, timeout = 15000): string | null {
    try {
      // Escape $ and " so they survive the local shell's double-quote expansion
      // and are interpreted by the REMOTE shell instead.
      const escaped = remoteCmd.replace(/\$/g, '\\$').replace(/"/g, '\\"');
      return execSync(
        `ssh ${this.sshArgs.join(' ')} ${this.sshTarget} "${escaped}"`,
        { encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      log.session.debug('SSH command failed', {
        target: this.sshTarget,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async readFile(remotePath: string): Promise<string | null> {
    await this.resolve();
    const useGlob = remotePath.includes('*');
    // Replace ~ with $HOME so the path expands correctly on the remote shell.
    // Tilde expansion is suppressed in both single AND double quotes; $HOME expands
    // in double quotes. execSsh's escaping (\$) passes $ through to the remote shell.
    const safePath = remotePath.replace(/^~/, '$HOME');
    const cmd = useGlob
      ? `for f in ${safePath}; do [ -f "$f" ] && cat "$f" && exit 0; done; exit 1`
      : `cat "${safePath}"`;
    const result = this.execSsh(cmd);
    return result || null;
  }

  async listDir(remotePath: string): Promise<string[]> {
    await this.resolve();
    const safePath = remotePath.replace(/^~/, '$HOME');
    const result = this.execSsh(`ls "${safePath}" 2>/dev/null`);
    if (!result) return [];
    return result.split('\n').filter(Boolean);
  }

  /**
   * Search for a session JSONL using `find` — more robust than shell glob.
   * Returns the file content if found, null otherwise.
   */
  async findSession(sessionId: string): Promise<string | null> {
    await this.resolve();
    // Single SSH call: find the file and cat it
    const cmd = `f=$(find ~/.claude/projects -maxdepth 2 -name '${sessionId}.jsonl' -print -quit 2>/dev/null) && [ -n "$f" ] && cat "$f"`;
    return this.execSsh(cmd, 20000);
  }

  /**
   * Batch-read all subagent JSONL files from a remote directory.
   * Returns a Map<filename, content> to avoid N separate SSH calls.
   */
  async batchReadSubagents(remoteDirPath: string): Promise<Map<string, string>> {
    await this.resolve();
    // Use a single SSH command that prints each file with a delimiter
    const delimiter = '___WALNUT_FILE_BOUNDARY___';
    const safeDirPath = remoteDirPath.replace(/^~/, '$HOME');
    const cmd = `cd "${safeDirPath}" 2>/dev/null && for f in agent-*.jsonl; do [ -f "$f" ] && echo "${delimiter}$f" && cat "$f"; done`;
    const result = this.execSsh(cmd, 30000);
    if (!result) return new Map();

    const fileMap = new Map<string, string>();
    const sections = result.split(delimiter).filter(Boolean);
    for (const section of sections) {
      const newlineIdx = section.indexOf('\n');
      if (newlineIdx === -1) continue;
      const filename = section.slice(0, newlineIdx).trim();
      const content = section.slice(newlineIdx + 1);
      if (filename && content) {
        fileMap.set(filename, content);
      }
    }
    return fileMap;
  }
}

// ── Factory ──

/** Create the appropriate file reader for local or remote sessions. */
export function createFileReader(host?: string): SessionFileReader {
  if (host) return new RemoteFileReader(host);
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
  // Remote sessions write synthetic events to the local streams capture, but the
  // remote canonical JSONL never sees them. Merge them so user messages appear.
  // Uses direct filename lookup (streams files are renamed to {sessionId}.jsonl;
  // see SessionIO.renameForSession() in session-io.ts).
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
  //    Dispatch on host (like readSubagentContents): remote SSH first, else local fs.
  //    Remote sessions have no local canonical file, so we must SSH first.
  if (host) {
    const reader = new RemoteFileReader(host);
    // Try exact encoded path first, then glob fallback, then find fallback.
    const exactPath = cwd ? remoteJsonlPath(sessionId, cwd) : null;
    const globPath = remoteJsonlPath(sessionId); // ~/.claude/projects/*/${sessionId}.jsonl
    try {
      if (exactPath) {
        const content = await reader.readFile(exactPath);
        if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote');
      }
      // Exact path missed or no cwd — try glob
      const content = await reader.readFile(globPath);
      if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote');

      // Glob also missed — try `find` (more robust than shell glob)
      const findContent = await reader.findSession(sessionId);
      if (findContent) return withFoundCwd(await mergeSyntheticFromLocalStreams(findContent), 'remote');
    } catch (err) {
      log.session.debug('remote JSONL read failed', {
        host, sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to stream/outputFile fallbacks
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

  // 2. Local streaming capture (SESSION_STREAMS_DIR) — fallback
  //    Useful when canonical is unavailable (remote SSH down, local file missing).
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

async function readRemoteSubagentContents(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<Map<string, string>> {
  if (!host) return new Map();

  const reader = new RemoteFileReader(host);
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

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
 * Mirrors Claude Code's `sanitizePath` at claude-code-source-code/src/utils/sessionStoragePortable.ts:311:
 *   replaces ALL non-alphanumeric characters with '-', not just '/'.
 * Examples:
 *   /Users/foo/bar       → -Users-foo-bar
 *   /Users/foo-bar/baz   → -Users-foo-bar-baz    (dash gets re-encoded)
 *   /Users/foo_bar/baz   → -Users-foo-bar-baz    (underscore collides with dash)
 * Caveat: paths >200 chars are truncated + hashed (Bun.hash) by Claude Code —
 * not yet handled here; callers that rely on exact parity for long paths
 * should use `isSafeForProjectEncoding` to detect and skip.
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Returns true if Claude Code would encode this cwd without the >200 char
 * hash-suffix path. Migration callers should skip when this is false (we
 * don't replicate Bun.hash). Most real cwds are far under this limit.
 */
export function isSafeForProjectEncoding(cwd: string): boolean {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').length <= 200;
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

/** Build the dynamic-workflow run-manifest directory (local absolute).
 *  Claude Code writes one `wf_<runId>.json` per workflow run here, plus a
 *  `subagents/workflows/wf_<runId>/` dir holding per-agent transcripts. */
export function workflowManifestDirPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, sessionId, 'workflows');
}

/** Build the remote workflow run-manifest directory (tilde-based). */
export function remoteWorkflowManifestDirPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}/workflows`;
  }
  return `~/.claude/projects/*/${sessionId}/workflows`;
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
  /**
   * Remote absolute path where the JSONL was located. Set only for 'remote'
   * source when the file was found via glob/find fallback (i.e. cwd was
   * missing or unsafe for our path encoding). Callers can cache this to
   * skip the search on the next read.
   */
  resolvedRemotePath?: string;
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
  const withFoundCwd = (content: string, source: ReadSessionResult['source'], resolvedRemotePath?: string): ReadSessionResult => {
    const foundCwd = extractCwdFromJsonlContent(content);
    return {
      content, source,
      ...(foundCwd ? { foundCwd } : {}),
      ...(resolvedRemotePath ? { resolvedRemotePath } : {}),
    };
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
    // Timeout: 30s covers cold-start daemon connect (ControlMaster ~15s + tunnel + WS) + file reads.
    // Individual operations have their own timeouts, but getDaemonConnection() may wait in
    // connectingPromises with no timeout — this outer race is the safety net for the API request.
    const REMOTE_READ_TIMEOUT = 30_000;
    const { DaemonFileReader } = await import('./daemon-file-reader.js');
    const reader = new DaemonFileReader(host);
    // Claude Code hashes cwds whose encoded form exceeds 200 chars; we don't
    // replicate that hashing, so the computed exactPath will be wrong. In that
    // case, skip the exact-path attempt and fall through to glob/find.
    const cwdSafeForExactPath = cwd ? isSafeForProjectEncoding(cwd) : false;
    const exactPath = cwdSafeForExactPath ? remoteJsonlPath(sessionId, cwd!) : null;
    const globPath = remoteJsonlPath(sessionId); // ~/.claude/projects/*/${sessionId}.jsonl

    try {
      const result = await Promise.race([
        (async () => {
          // Try exact encoded path first.
          // DaemonFileReader.readFile() now distinguishes ENOENT (returns null)
          // from transport/RPC errors (throws). When cwd is known AND is safe
          // for our encoding and exact path returns null, the file genuinely
          // doesn't exist — no amount of globbing will conjure it.
          if (exactPath) {
            const content = await reader.readFile(exactPath);
            if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote', exactPath);
            return null;
          }
          // cwd unknown OR unsafe-for-encoding (>200 chars, hashed by Claude Code):
          // fall back to glob, then find.
          const content = await reader.readFile(globPath);
          if (content) return withFoundCwd(await mergeSyntheticFromLocalStreams(content), 'remote');
          const findResult = await reader.findSession(sessionId);
          if (findResult) return withFoundCwd(await mergeSyntheticFromLocalStreams(findResult.content), 'remote', findResult.path);
          return null;
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Remote read timeout (30s)')), REMOTE_READ_TIMEOUT),
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

// ── Dynamic-workflow run manifest (reload persistence) ──

/** Parsed dynamic-workflow run manifest (workflows/wf_<runId>.json). Only the
 *  fields the UI panel needs; the file has more (logs, scriptPath, result,
 *  status, totalTokens, durationMs — not surfaced; the panel derives token /
 *  duration aggregates from the per-agent entries instead). */
export interface WorkflowManifest {
  runId: string;
  workflowName?: string;
  summary?: string;          // human description (== meta.description)
  script?: string;           // the generated workflow script source
  startTime?: number;        // used only for latest-run selection
  /** Full accumulated workflow_progress[] — same format as the live event array. */
  workflowProgress: unknown[];
}

/** Filter a dir listing down to `wf_*.json` run-manifest filenames. */
function workflowManifestNames(entries: string[]): string[] {
  return entries.filter((f) => f.startsWith('wf_') && f.endsWith('.json'));
}

/** Read the latest dynamic-workflow run manifest for a session. Returns null when
 *  the session never ran a workflow. Used to reconstruct the progress panel on
 *  page reload / after the live in-memory state is gone.
 *
 *  A session that invokes the Workflow tool more than once produces one
 *  `wf_<runId>.json` PER run, so when several exist we parse each and keep the
 *  most recent by startTime (the panel shows only the latest run). */
export async function readWorkflowManifest(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<WorkflowManifest | null> {
  // Resolve the candidate workflows dirs. When cwd is known, the cwd-encoded path
  // is authoritative — do NOT scan every project dir, because this is called on
  // EVERY session mount (the panel hook fetches /workflow unconditionally) and the
  // common case is "session never ran a workflow"; a full ~/.claude/projects scan
  // per page-load is the exact O(N)-syscall regression the project keeps fixing.
  // Only fall back to the broad scan when cwd is genuinely unknown.
  const reader = await createFileReader(host);
  const dirs: string[] = [];
  if (host) {
    dirs.push(remoteWorkflowManifestDirPath(sessionId, cwd));
  } else if (cwd) {
    dirs.push(workflowManifestDirPath(sessionId, cwd));
  } else {
    const projectsDir = path.join(CLAUDE_HOME, 'projects');
    try {
      for (const dir of await fsp.readdir(projectsDir)) {
        dirs.push(path.join(projectsDir, dir, sessionId, 'workflows'));
      }
    } catch {
      // projects dir scan failed — nothing to read
    }
  }

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await reader.listDir(dir);
    } catch {
      continue;
    }
    const names = workflowManifestNames(entries);
    if (names.length === 0) continue;

    // Parse every manifest in this dir, keep the one with the latest startTime.
    let best: WorkflowManifest | null = null;
    for (const name of names) {
      const filePath = host ? `${dir}/${name}` : path.join(dir, name);
      const content = await reader.readFile(filePath);
      if (!content) continue;
      try {
        const m = JSON.parse(content) as Record<string, unknown>;
        const wp = Array.isArray(m.workflowProgress) ? m.workflowProgress : [];
        const manifest: WorkflowManifest = {
          runId: typeof m.runId === 'string' ? m.runId : name.replace(/\.json$/, ''),
          workflowName: typeof m.workflowName === 'string' ? m.workflowName : undefined,
          summary: typeof m.summary === 'string' ? m.summary : undefined,
          script: typeof m.script === 'string' ? m.script : undefined,
          startTime: typeof m.startTime === 'number' ? m.startTime : undefined,
          workflowProgress: wp,
        };
        if (!best || (manifest.startTime ?? 0) >= (best.startTime ?? 0)) best = manifest;
      } catch (err) {
        log.session.debug('failed to parse workflow manifest', {
          sessionId, filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (best) return best;
  }
  return null;
}

/** Read a single workflow subagent's transcript JSONL by agentId. Scans the
 *  nested subagents/workflows/<runId>/agent-<agentId>.jsonl layout. Returns the
 *  raw content, or null if not found. */
export async function readWorkflowSubagentContent(
  sessionId: string,
  agentId: string,
  cwd?: string,
  host?: string,
): Promise<string | null> {
  const filename = `agent-${agentId}.jsonl`;
  const reader = await createFileReader(host);

  // Resolve candidate `subagents/workflows` parent dirs (each holds wf_<runId>/ dirs).
  // cwd-encoded path is authoritative when known; only scan all project dirs as a
  // last resort (cwd unknown) — same O(N)-syscall avoidance as readWorkflowManifest.
  const parents: string[] = [];
  if (host) {
    parents.push(`${remoteSubagentDirPath(sessionId, cwd)}/workflows`);
  } else if (cwd) {
    parents.push(path.join(subagentDirPath(sessionId, cwd), 'workflows'));
  } else {
    const projectsDir = path.join(CLAUDE_HOME, 'projects');
    try {
      for (const dir of await fsp.readdir(projectsDir)) {
        parents.push(path.join(projectsDir, dir, sessionId, 'subagents', 'workflows'));
      }
    } catch {
      // projects dir scan failed — nothing to read
    }
  }

  for (const parent of parents) {
    let runDirs: string[];
    try {
      runDirs = await reader.listDir(parent);
    } catch {
      continue;
    }
    for (const runDir of runDirs) {
      if (!runDir.startsWith('wf_')) continue;
      const filePath = host
        ? `${parent}/${runDir}/${filename}`
        : path.join(parent, runDir, filename);
      const content = await reader.readFile(filePath);
      if (content) return content;
    }
  }
  return null;
}

/**
 * Session -> QMD sync module.
 *
 * Reads Claude Code sessions from sessions.json, joins with task data
 * for richer content, and inserts into the QMD session store for semantic search.
 * Uses content-hash comparison to skip unchanged sessions.
 *
 * Design notes:
 * - Same programmatic-only / hash-skip / virtual-path conventions as qmd-task-sync.ts.
 * - Session joins task data: serializeSession() enriches session text with linked
 *   task summary/description so semantic search finds sessions by task content too.
 * - embed() is called by the server's debounced event handler (not here)
 *   for incremental syncs. syncAllSessions() calls embed() directly for bulk init.
 */
import { createHash } from 'node:crypto';
import { getSessionStore, DEFAULT_QMD_MODEL } from './qmd-store.js';
import { listSessions } from './session-tracker.js';
import { listTasks } from './task-manager.js';
import { log } from '../logging/index.js';
import type { SessionRecord, Task } from './types.js';

const COLLECTION = 'sessions';

/** Serialize a session into searchable text for embedding. */
function serializeSession(session: SessionRecord, task?: Task): string {
  const parts: string[] = [];

  if (session.title) parts.push(session.title);
  if (session.description) parts.push(session.description);
  if (session.planContent) parts.push(session.planContent);

  // Enrich with linked task data
  if (task) {
    if (task.summary) parts.push(task.summary);
    if (task.description) parts.push(task.description);
  }

  // Metadata
  const meta: string[] = [];
  if (session.project) meta.push(`Project: ${session.project}`);
  if (session.cwd) meta.push(`CWD: ${session.cwd}`);
  if (meta.length) parts.push(meta.join(' | '));

  return parts.join('\n\n');
}

/** SHA256 hash of serialized content. */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Virtual document path for a session. */
function sessionDocPath(sessionId: string): string {
  return `sess-${sessionId}`;
}

/**
 * Full sync: read all sessions, join with tasks, insert/update in QMD, then embed.
 * Skips sessions whose content hash hasn't changed.
 */
export async function syncAllSessions(): Promise<void> {
  const store = await getSessionStore();
  const [sessions, tasks] = await Promise.all([listSessions(), listTasks()]);
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const now = new Date().toISOString();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const session of sessions) {
    const task = session.taskId ? taskMap.get(session.taskId) : undefined;
    const text = serializeSession(session, task);

    // Skip sessions with no meaningful content
    if (!text.trim()) {
      skipped++;
      continue;
    }

    const hash = contentHash(text);
    const docPath = sessionDocPath(session.claudeSessionId);
    const title = session.title || session.claudeSessionId.slice(0, 12);

    const existing = store.internal.findActiveDocument(COLLECTION, docPath);

    if (existing && existing.hash === hash) {
      skipped++;
      continue;
    }

    store.internal.insertContent(hash, text, now);

    if (existing) {
      store.internal.updateDocument(existing.id, title, hash, now);
      updated++;
    } else {
      store.internal.insertDocument(COLLECTION, docPath, title, hash, now, now);
      inserted++;
    }
  }

  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await store.embed({ model });

  log.agent.info(`QMD session sync: ${inserted} inserted, ${updated} updated, ${skipped} skipped (${sessions.length} total)`);
}

/**
 * Incremental sync: upsert a single session (insert/update only, no embed).
 * Call flushSessionEmbeddings() after batching multiple syncs.
 * Optionally accepts a pre-loaded task to avoid re-reading tasks.json.
 */
export async function syncSession(session: SessionRecord, task?: Task): Promise<void> {
  const store = await getSessionStore();

  // If task not provided, try to load it
  let linkedTask = task;
  if (!linkedTask && session.taskId) {
    try {
      const tasks = await listTasks();
      linkedTask = tasks.find(t => t.id === session.taskId);
    } catch { /* task may have been deleted */ }
  }

  const text = serializeSession(session, linkedTask);
  if (!text.trim()) return;

  const hash = contentHash(text);
  const docPath = sessionDocPath(session.claudeSessionId);
  const title = session.title || session.claudeSessionId.slice(0, 12);
  const now = new Date().toISOString();

  const existing = store.internal.findActiveDocument(COLLECTION, docPath);
  if (existing && existing.hash === hash) return;

  store.internal.insertContent(hash, text, now);

  if (existing) {
    store.internal.updateDocument(existing.id, title, hash, now);
  } else {
    store.internal.insertDocument(COLLECTION, docPath, title, hash, now, now);
  }
}

/**
 * Flush pending session embeddings. Called once after batching multiple syncSession() calls.
 */
export async function flushSessionEmbeddings(): Promise<void> {
  const store = await getSessionStore();
  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await store.embed({ model });
}

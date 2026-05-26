/**
 * QMD store singletons for memory, notes, task, and session search.
 *
 * WHY 4 SEPARATE STORES: Each store has its own SQLite DB to avoid noisy-neighbor
 * problems at scale. Memory docs change constantly (daily logs); re-embedding them
 * would block task/session queries if they shared a DB. Separate DBs also let us
 * tune per-store (e.g. force re-embed notes without touching tasks).
 *
 * Four QMD instances:
 * - memoryStore: daily logs, topics, projects, repos, compaction, global memory, sessions
 * - notesStore: Obsidian vault areas, projects, resources, archive
 * - taskStore: tasks (programmatic insertion from tasks.json)
 * - sessionStore: claude code sessions (programmatic insertion from sessions.json)
 */
import { createStore, type QMDStore } from '@tobilu/qmd';
import { WALNUT_HOME, MEMORY_DIR, NOTES_DIR } from '../constants.js';
import path from 'node:path';
import { log } from '../logging/index.js';

/** Default embedding model URI — shared with qmd route. */
export const DEFAULT_QMD_MODEL = 'hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf';

let memoryStore: QMDStore | null = null;
let memoryStorePromise: Promise<QMDStore> | null = null;
let notesStore: QMDStore | null = null;
let notesStorePromise: Promise<QMDStore> | null = null;
let taskStore: QMDStore | null = null;
let taskStorePromise: Promise<QMDStore> | null = null;
let sessionStore: QMDStore | null = null;
let sessionStorePromise: Promise<QMDStore> | null = null;

export async function getMemoryStore(): Promise<QMDStore> {
  if (memoryStore) return memoryStore;
  if (!memoryStorePromise) {
    memoryStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'memory-search.sqlite'),
      config: {
        collections: {
          daily:      { path: path.join(MEMORY_DIR, 'daily'),      pattern: '**/*.md' },
          topic:      { path: path.join(MEMORY_DIR, 'topics'),     pattern: '**/*.md' },
          project:    { path: path.join(MEMORY_DIR, 'projects'),   pattern: '**/*.md' },
          repo:       { path: path.join(MEMORY_DIR, 'repos'),      pattern: '**/*.md' },
          compaction: { path: path.join(MEMORY_DIR, 'compaction'),  pattern: '**/*.md' },
          global:     { path: WALNUT_HOME,                          pattern: 'MEMORY.md' },
          session:    { path: path.join(MEMORY_DIR, 'sessions'),    pattern: '**/*.md' },
        },
      },
    }).then(store => {
      memoryStore = store;
      memoryStorePromise = null;
      return store;
    }).catch(err => {
      memoryStorePromise = null;
      throw err;
    });
  }
  return memoryStorePromise;
}

export async function getNotesStore(): Promise<QMDStore> {
  if (notesStore) return notesStore;
  if (!notesStorePromise) {
    notesStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'notes-search.sqlite'),
      config: {
        collections: {
          areas:     { path: path.join(NOTES_DIR, 'Areas'),     pattern: '**/*.md' },
          projects:  { path: path.join(NOTES_DIR, 'Projects'),  pattern: '**/*.md' },
          resources: { path: path.join(NOTES_DIR, 'Resources'), pattern: '**/*.md' },
          archive:   { path: path.join(NOTES_DIR, 'Archive'),   pattern: '**/*.md', includeByDefault: false },
        },
      },
    }).then(store => {
      notesStore = store;
      notesStorePromise = null;
      return store;
    }).catch(err => {
      notesStorePromise = null;
      throw err;
    });
  }
  return notesStorePromise;
}

/**
 * Task store — programmatic-only (no filesystem scanning).
 * Tasks are inserted via qmd-task-sync.ts from tasks.json.
 *
 * `__qmd_programmatic_only__` is a sentinel glob that matches zero files, so
 * store.update() is a no-op (tasks have no on-disk .md files). NEVER call
 * store.update() on this store — all data enters via insertContent/insertDocument.
 */
export async function getTaskStore(): Promise<QMDStore> {
  if (taskStore) return taskStore;
  if (!taskStorePromise) {
    taskStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'task-search.sqlite'),
      config: {
        collections: {
          tasks: { path: path.join(WALNUT_HOME, 'tasks'), pattern: '__qmd_programmatic_only__' },
        },
      },
    }).then(store => {
      taskStore = store;
      taskStorePromise = null;
      return store;
    }).catch(err => {
      taskStorePromise = null;
      throw err;
    });
  }
  return taskStorePromise;
}

/**
 * Session store — programmatic-only (no filesystem scanning).
 * Sessions are inserted via qmd-session-sync.ts from sessions.json.
 * Same sentinel pattern as taskStore — see comment above.
 */
export async function getSessionStore(): Promise<QMDStore> {
  if (sessionStore) return sessionStore;
  if (!sessionStorePromise) {
    sessionStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'session-search.sqlite'),
      config: {
        collections: {
          sessions: { path: path.join(WALNUT_HOME, 'sessions'), pattern: '__qmd_programmatic_only__' },
        },
      },
    }).then(store => {
      sessionStore = store;
      sessionStorePromise = null;
      return store;
    }).catch(err => {
      sessionStorePromise = null;
      throw err;
    });
  }
  return sessionStorePromise;
}

export async function initQmdStores(): Promise<void> {
  // BGE-M3: multilingual embedding model (Chinese + English) — critical for bilingual search.
  // Replaces QMD's default EmbeddingGemma which is English-only.
  // GGUF conversion by CompendiumLabs (BAAI doesn't publish GGUF directly).
  process.env.QMD_EMBED_MODEL = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;

  log.agent.info('QMD: initializing stores...');
  const [mem, notes] = await Promise.all([getMemoryStore(), getNotesStore()]);

  // Detect embedding model mismatch by checking content_vectors.model in SQLite.
  // embed() without force skips docs that already have vectors, so it can't
  // detect wrong-model vectors. We check the DB directly — source of truth.
  function getStoredEmbedModel(store: QMDStore): string | null {
    try {
      const row = store.internal.db.prepare(
        'SELECT DISTINCT model FROM content_vectors LIMIT 1'
      ).get() as { model: string } | undefined;
      return row?.model ?? null;
    } catch {
      return null; // table doesn't exist yet = no vectors
    }
  }

  // Lazy import to avoid circular dependency — only used during init
  let reportProgress: ((store: string, progress: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => void) | null = null;
  try {
    const { setQmdEmbedProgress } = await import('../web/routes/qmd.js');
    reportProgress = setQmdEmbedProgress;
  } catch { /* web routes not loaded yet — skip progress reporting */ }

  async function updateAndEmbed(store: QMDStore, label: string): Promise<void> {
    await store.update();

    const currentModel = process.env.QMD_EMBED_MODEL!;
    const storedModel = getStoredEmbedModel(store);
    const onProgress = reportProgress ? (p: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => reportProgress!(label, p) : undefined;

    if (storedModel && storedModel !== currentModel) {
      log.agent.warn(`QMD ${label}: model mismatch — stored="${storedModel}", current="${currentModel}". Force re-embedding all documents.`);
      await store.embed({ force: true, model: currentModel, onProgress });
      const afterModel = getStoredEmbedModel(store);
      log.agent.info(`QMD ${label}: force re-embed complete, model now="${afterModel}"`);
    } else {
      await store.embed({ model: currentModel, onProgress });
    }
  }

  await Promise.all([
    updateAndEmbed(mem, 'memory'),
    updateAndEmbed(notes, 'notes'),
  ]);

  // Task and session stores are programmatic-only (no store.update()), but they
  // still need model mismatch detection. Without this, switching embedding models
  // leaves stale vectors with wrong dimensions → every search fails with
  // "Dimension mismatch for query vector" and returns zero results silently.
  async function checkAndReembed(storeFn: () => Promise<QMDStore>, label: string): Promise<void> {
    try {
      const store = await storeFn();
      const currentModel = process.env.QMD_EMBED_MODEL!;
      const storedModel = getStoredEmbedModel(store);
      const onProgress = reportProgress ? (p: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => reportProgress!(label, p) : undefined;

      if (storedModel && storedModel !== currentModel) {
        log.agent.warn(`QMD ${label}: model mismatch — stored="${storedModel}", current="${currentModel}". Force re-embedding.`);
        await store.embed({ force: true, model: currentModel, onProgress });
        log.agent.info(`QMD ${label}: force re-embed complete, model now="${getStoredEmbedModel(store)}"`);
      }
    } catch (err) {
      log.agent.warn(`QMD ${label}: model check failed`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  await Promise.all([
    checkAndReembed(getTaskStore, 'task'),
    checkAndReembed(getSessionStore, 'session'),
  ]);

  log.agent.info('QMD: stores initialized');
}

export async function closeQmdStores(): Promise<void> {
  if (memoryStore) { await memoryStore.close(); memoryStore = null; }
  if (notesStore) { await notesStore.close(); notesStore = null; }
  if (taskStore) { await taskStore.close(); taskStore = null; }
  if (sessionStore) { await sessionStore.close(); sessionStore = null; }
}

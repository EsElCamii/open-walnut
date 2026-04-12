/**
 * QMD store singletons for memory and notes search.
 *
 * Two QMD instances:
 * - memoryStore: daily logs, topics, projects, repos, compaction, global memory, sessions
 * - notesStore: Obsidian vault areas, projects, resources, archive
 */
import { createStore, type QMDStore } from '@tobilu/qmd';
import { WALNUT_HOME, MEMORY_DIR, NOTES_DIR } from '../constants.js';
import path from 'node:path';
import { log } from '../logging/index.js';

let memoryStore: QMDStore | null = null;
let notesStore: QMDStore | null = null;

export async function getMemoryStore(): Promise<QMDStore> {
  if (memoryStore) return memoryStore;
  memoryStore = await createStore({
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
  });
  return memoryStore;
}

export async function getNotesStore(): Promise<QMDStore> {
  if (notesStore) return notesStore;
  notesStore = await createStore({
    dbPath: path.join(WALNUT_HOME, 'notes-search.sqlite'),
    config: {
      collections: {
        areas:     { path: path.join(NOTES_DIR, 'Areas'),     pattern: '**/*.md' },
        projects:  { path: path.join(NOTES_DIR, 'Projects'),  pattern: '**/*.md' },
        resources: { path: path.join(NOTES_DIR, 'Resources'), pattern: '**/*.md' },
        archive:   { path: path.join(NOTES_DIR, 'Archive'),   pattern: '**/*.md', includeByDefault: false },
      },
    },
  });
  return notesStore;
}

export async function initQmdStores(): Promise<void> {
  log.agent.info('QMD: initializing stores...');
  const [mem, notes] = await Promise.all([getMemoryStore(), getNotesStore()]);
  await Promise.all([
    mem.update().then(() => mem.embed()),
    notes.update().then(() => notes.embed()),
  ]);
  log.agent.info('QMD: stores initialized');
}

export async function closeQmdStores(): Promise<void> {
  if (memoryStore) { await memoryStore.close(); memoryStore = null; }
  if (notesStore) { await notesStore.close(); notesStore = null; }
}

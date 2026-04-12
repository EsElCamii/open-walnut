/**
 * Filesystem watcher that triggers QMD update+embed on markdown changes.
 * Replaces memory-watcher.ts for QMD-backed search.
 */
import fs from 'node:fs';
import { MEMORY_DIR, WALNUT_HOME, NOTES_DIR } from '../constants.js';
import { getMemoryStore, getNotesStore } from './qmd-store.js';
import { log } from '../logging/index.js';

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function notifyGitVersioning(filename: string): void {
  import('./git-versioning.js')
    .then(({ getGitVersioning }) => { getGitVersioning()?.notifyMemoryChange(filename); })
    .catch(() => {});
}

export function startQmdWatcher(): { stop: () => void } {
  const watchers: fs.FSWatcher[] = [];

  const scheduleMemoryUpdate = debounce(async () => {
    try {
      const store = await getMemoryStore();
      await store.update();
      await store.embed();
    } catch (err) {
      log.agent.debug('QMD memory update failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 2000);

  const scheduleNotesUpdate = debounce(async () => {
    try {
      const store = await getNotesStore();
      await store.update();
      await store.embed();
    } catch (err) {
      log.agent.debug('QMD notes update failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 5000);

  try {
    if (fs.existsSync(MEMORY_DIR)) {
      watchers.push(fs.watch(MEMORY_DIR, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          scheduleMemoryUpdate();
          notifyGitVersioning(filename);
        }
      }));
    }
    if (fs.existsSync(WALNUT_HOME)) {
      watchers.push(fs.watch(WALNUT_HOME, (_event, filename) => {
        if (filename === 'MEMORY.md') {
          scheduleMemoryUpdate();
          notifyGitVersioning(filename);
        }
      }));
    }
    if (fs.existsSync(NOTES_DIR)) {
      watchers.push(fs.watch(NOTES_DIR, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) scheduleNotesUpdate();
      }));
    }
  } catch { /* graceful */ }

  return {
    stop() {
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}

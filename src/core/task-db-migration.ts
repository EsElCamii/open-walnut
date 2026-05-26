/**
 * task-db-migration.ts — one-shot migration from tasks.json → tasks.sqlite.
 *
 * Called once at startup when the SQLite task store is empty and a legacy
 * tasks.json exists. Reads the JSON blob, INSERTs every task row + category
 * row in a single transaction, then stamps a backup file so the original JSON
 * can never be clobbered without a copy sitting next to it.
 *
 * Idempotency: the function bails out cheaply on every subsequent call by
 * checking the `tasks` row count. Safe to invoke from module init.
 *
 * Migration completeness: tasks.json on disk is assumed to already be
 * post-migration (the live task-manager readStore → writeStore cycle has
 * been running in-place migrations for every existing deploy). So this
 * module does NOT re-run the legacy migrate* chain from task-manager.ts.
 * For the one-off JSON→SQLite cutover, the data is already normalized.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TASKS_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { readJsonFile } from '../utils/fs.js';
import { getDb, taskToRow, TASK_COLUMNS, transaction } from './task-db.js';
import type { Task, TaskStore } from './types.js';

export interface MigrationResult {
  /** true only on the run that actually copied rows in. Subsequent runs return false. */
  migrated: boolean;
  /** Number of task rows the function is responsible for on return. On a no-op
   *  (already migrated / fallback mode / no JSON) this is the row count it
   *  observed, which may be 0 or the pre-existing row count. */
  count: number;
}

/**
 * Run the one-shot JSON→SQLite migration if needed.
 *
 * Returns `{migrated: false, count: N}` in three cases:
 *   1. SQLite handle failed to open — skip, will retry on next startup.
 *   2. `tasks` table already has rows — idempotent no-op.
 *   3. tasks.json doesn't exist — fresh install, nothing to import.
 *
 * Returns `{migrated: true, count: N}` after a successful import.
 */
export async function runMigrationIfNeeded(): Promise<MigrationResult> {
  const db = getDb();
  if (!db) {
    return { migrated: false, count: 0 };
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  if (existing.n > 0) {
    return { migrated: false, count: existing.n };
  }

  if (!fs.existsSync(TASKS_FILE)) {
    return { migrated: false, count: 0 };
  }

  // readJsonFile throws on corrupt content rather than silently returning the
  // fallback — we let that propagate so a bad tasks.json aborts startup
  // instead of silently creating an empty DB.
  const store = await readJsonFile<TaskStore>(TASKS_FILE, { version: 1, tasks: [] });

  const tasks: Task[] = Array.isArray(store.tasks) ? store.tasks : [];
  const categories = store.categories ?? {};

  // Prepared INSERT for `tasks`. Built from TASK_COLUMNS so the column list
  // here and the one in task-db.ts can never drift. `payload` is appended
  // explicitly because it's not in TASK_COLUMNS (it's the spillover column).
  const taskInsertCols = [...TASK_COLUMNS, 'payload'];
  const taskInsertSql =
    'INSERT INTO tasks (' + taskInsertCols.join(', ') + ') ' +
    'VALUES (' + taskInsertCols.map((c) => '@' + c).join(', ') + ')';

  const catInsertSql =
    'INSERT INTO task_categories (name, source, order_index) VALUES (@name, @source, @order_index)';

  transaction((h) => {
    const insertTask = h.prepare(taskInsertSql);
    const insertCat = h.prepare(catInsertSql);

    // Categories first (no FK today but the logical order still matters for
    // any future constraints / observers).
    let catIndex = 0;
    for (const [name, rec] of Object.entries(categories)) {
      insertCat.run({
        name,
        source: (rec && typeof rec === 'object' && 'source' in rec) ? String(rec.source) : 'local',
        order_index: catIndex,
      });
      catIndex += 1;
    }

    // Tasks. taskToRow emits only the keys the task actually carries; we pad
    // the missing columns with null so the prepared statement's named-binding
    // contract is satisfied (better-sqlite3 throws on unbound @params).
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
        log.task.warn('task-db migration: skipping malformed task', {
          sample: String((task as { id?: unknown })?.id ?? '<no id>'),
        });
        continue;
      }
      const partial = taskToRow(task);
      const bound: Record<string, unknown> = {};
      for (const col of taskInsertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      try {
        insertTask.run(bound);
      } catch (err) {
        // One bad row shouldn't abort the whole migration — log and continue.
        // User still has the pristine tasks.json (plus the backup below) for
        // manual recovery if something important was dropped.
        log.task.warn('task-db migration: failed to insert task, skipping', {
          id: task.id,
          err: String(err),
        });
      }
    }
  });

  const after = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
  const count = after.n;

  // Copy the source blob aside so operators / future migrations have a
  // known-good snapshot even after we start mutating the SQLite file. A
  // failure here isn't fatal — the JSON itself still exists untouched.
  const backupPath = path.join(path.dirname(TASKS_FILE), 'tasks.json.migrated-from-json.backup');
  try {
    fs.copyFileSync(TASKS_FILE, backupPath);
  } catch (err) {
    log.task.warn('task-db migration: backup copy failed (non-fatal)', {
      path: backupPath,
      err: String(err),
    });
  }

  log.task.info('task-db: migrated tasks from tasks.json', {
    count,
    categoryCount: Object.keys(categories).length,
  });

  return { migrated: true, count };
}

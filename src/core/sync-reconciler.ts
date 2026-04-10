/**
 * Sync Reconciler — generic full-reconciliation framework for integration plugins.
 *
 * Delta polling (syncPoll) is fast but unreliable: network issues, API truncation,
 * or token expiry can cause permanent drift. This framework adds a periodic full
 * reconciliation layer on top of delta polling to guarantee eventual consistency.
 *
 * Plugin contract: implement fullPull(ctx) + extractRemoteId(task) (~20 lines each).
 * Framework owns all reconciliation logic: scheduling, three-way diff, safety guards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYNC_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import { isPushInflight } from './task-manager.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from './integration-types.js';
import type { Task } from './types.js';

// ── Reconcile state (per-plugin, managed by framework) ──

interface ReconcileState {
  /** Number of delta ticks since last full reconcile. */
  deltaEpoch: number;
  /** ISO timestamp of last successful full reconcile. */
  lastFullReconcileAt: string;
  /** Number of items returned by last full pull (for empty-result guard). */
  lastFullPullCount: number;
  /** Last state file write. */
  updatedAt: string;
}

// ── Scheduling config ──

const FULL_RECONCILE_EPOCH = 60;       // After 60 deltas (~30 min at 30s interval)
const FULL_RECONCILE_INTERVAL_MS = 30 * 60_000; // 30 minutes time-based fallback
const DELTA_FAILURE_THRESHOLD = 3;     // Force full after 3 consecutive delta failures
const EMPTY_RESULT_MIN_RATIO = 0.1;    // Abort if result < 10% of last known count

// ── Diff result types ──

interface ReconcileDiffResult {
  toCreate: RemoteSyncItem[];
  toUpdate: Array<{ local: Task; remote: RemoteSyncItem }>;
  toRemove: Task[];
  unchanged: number;
}

// ── SyncReconciler ──

export class SyncReconciler {
  private stateCache = new Map<string, ReconcileState>();
  private isFirstTick = new Map<string, boolean>();

  constructor() {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
  }

  /**
   * Called after every delta poll. Tracks epochs, decides if full reconcile is needed,
   * and runs the three-way diff + apply cycle when triggered.
   */
  async tick(
    plugin: RegisteredPlugin,
    ctx: SyncPollContext,
    opts: { deltaFailed?: boolean } = {},
  ): Promise<void> {
    // Skip plugins that don't implement full reconciliation
    if (!plugin.sync.fullPull || !plugin.sync.extractRemoteId) return;

    const state = this.loadState(plugin.id);

    // Track delta epoch
    state.deltaEpoch++;
    if (opts.deltaFailed) {
      // deltaEpoch is also used as failure counter when delta fails consecutively
    }

    // Check if first tick for this plugin
    const first = this.isFirstTick.get(plugin.id) !== false;
    if (first) this.isFirstTick.set(plugin.id, false);

    const shouldReconcile = this.shouldRunFull(state, opts, first);
    if (!shouldReconcile) {
      this.saveState(plugin.id, state);
      return;
    }

    log.web.info(`sync-reconciler: starting full reconcile`, { pluginId: plugin.id, trigger: this.getTriggerReason(state, opts, first) });

    try {
      const remoteItems = await plugin.sync.fullPull(ctx);
      if (!remoteItems) {
        log.web.debug('sync-reconciler: fullPull returned null/undefined, skipping', { pluginId: plugin.id });
        this.saveState(plugin.id, state);
        return;
      }

      // Safety guard: empty result when we previously had items
      if (remoteItems.length === 0 && state.lastFullPullCount > 5) {
        log.web.warn('sync-reconciler: fullPull returned 0 items but last pull had items — aborting to prevent mass deletion', {
          pluginId: plugin.id,
          lastCount: state.lastFullPullCount,
        });
        this.saveState(plugin.id, state);
        return;
      }

      // Safety guard: drastic drop in count
      if (
        state.lastFullPullCount > 0 &&
        remoteItems.length > 0 &&
        remoteItems.length < state.lastFullPullCount * EMPTY_RESULT_MIN_RATIO
      ) {
        log.web.warn('sync-reconciler: fullPull count dropped drastically — aborting', {
          pluginId: plugin.id,
          currentCount: remoteItems.length,
          lastCount: state.lastFullPullCount,
        });
        this.saveState(plugin.id, state);
        return;
      }

      // Run three-way diff
      const localTasks = ctx.getTasks().filter(t => t.source === plugin.id);
      const diff = this.computeDiff(localTasks, remoteItems, plugin);

      // Apply changes
      await this.applyDiff(diff, ctx, plugin.id);

      // Update state on success
      state.deltaEpoch = 0;
      state.lastFullReconcileAt = new Date().toISOString();
      state.lastFullPullCount = remoteItems.length;
      state.updatedAt = new Date().toISOString();
      this.saveState(plugin.id, state);

      log.web.info('sync-reconciler: full reconcile complete', {
        pluginId: plugin.id,
        remoteCount: remoteItems.length,
        created: diff.toCreate.length,
        updated: diff.toUpdate.length,
        removed: diff.toRemove.length,
        unchanged: diff.unchanged,
      });
    } catch (err) {
      log.web.error('sync-reconciler: full reconcile failed', {
        pluginId: plugin.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't reset epoch — next tick will try again if threshold still met
      this.saveState(plugin.id, state);
    }
  }

  /** Reset state for a plugin (e.g. on server startup). */
  forceNextReconcile(pluginId: string): void {
    this.isFirstTick.set(pluginId, true);
  }

  // ── Private: Scheduling ──

  private shouldRunFull(
    state: ReconcileState,
    opts: { deltaFailed?: boolean },
    isFirst: boolean,
  ): boolean {
    if (isFirst) return true;
    if (state.deltaEpoch >= FULL_RECONCILE_EPOCH) return true;
    if (opts.deltaFailed && state.deltaEpoch >= DELTA_FAILURE_THRESHOLD) return true;

    const elapsed = Date.now() - new Date(state.lastFullReconcileAt).getTime();
    if (elapsed >= FULL_RECONCILE_INTERVAL_MS) return true;

    return false;
  }

  private getTriggerReason(
    state: ReconcileState,
    opts: { deltaFailed?: boolean },
    isFirst: boolean,
  ): string {
    if (isFirst) return 'first_tick';
    if (opts.deltaFailed && state.deltaEpoch >= DELTA_FAILURE_THRESHOLD) return 'delta_failures';
    if (state.deltaEpoch >= FULL_RECONCILE_EPOCH) return 'epoch_threshold';
    const elapsed = Date.now() - new Date(state.lastFullReconcileAt).getTime();
    if (elapsed >= FULL_RECONCILE_INTERVAL_MS) return 'time_elapsed';
    return 'unknown';
  }

  // ── Private: Three-way diff ──

  private computeDiff(
    localTasks: Task[],
    remoteItems: RemoteSyncItem[],
    plugin: RegisteredPlugin,
  ): ReconcileDiffResult {
    const extractId = plugin.sync.extractRemoteId!;

    // Build maps
    const remoteMap = new Map<string, RemoteSyncItem>();
    for (const item of remoteItems) {
      if (!item.deleted) {
        remoteMap.set(item.remoteId, item);
      }
    }

    const localByRemoteId = new Map<string, Task>();
    const localWithoutRemoteId: Task[] = [];
    for (const task of localTasks) {
      const rid = extractId(task);
      if (rid) {
        localByRemoteId.set(rid, task);
      } else {
        localWithoutRemoteId.push(task);
      }
    }

    const toCreate: RemoteSyncItem[] = [];
    const toUpdate: Array<{ local: Task; remote: RemoteSyncItem }> = [];
    const toRemove: Task[] = [];
    let unchanged = 0;

    // remote ∩ local → check for updates
    // remote - local → create
    for (const [remoteId, remote] of remoteMap) {
      const local = localByRemoteId.get(remoteId);
      if (local) {
        // Skip tasks with inflight push — avoid echo during push window
        if (isPushInflight(local.id)) {
          unchanged++;
          continue;
        }
        // Both exist — check if remote is newer than last synced timestamp
        const remoteTime = new Date(remote.remoteUpdatedAt).getTime();
        const syncedAt = local._syncedAt ? new Date(local._syncedAt).getTime() : 0;
        if (remoteTime > syncedAt) {
          toUpdate.push({ local, remote });
        } else {
          unchanged++;
        }
      } else {
        toCreate.push(remote);
      }
    }

    // local - remote → candidate for removal
    for (const [remoteId, local] of localByRemoteId) {
      if (!remoteMap.has(remoteId)) {
        toRemove.push(local);
      }
    }

    // Tasks without remote ID are left alone (can't reconcile without a join key)
    unchanged += localWithoutRemoteId.length;

    return { toCreate, toUpdate, toRemove, unchanged };
  }

  // ── Private: Apply diff ──

  private async applyDiff(
    diff: ReconcileDiffResult,
    ctx: SyncPollContext,
    pluginId: string,
  ): Promise<void> {
    // Apply creates (batch limit: 50)
    const createBatch = diff.toCreate.slice(0, 50);
    for (const remote of createBatch) {
      try {
        await ctx.addTask({
          ...remote.fields,
          source: pluginId as Task['source'],
          title: remote.fields.title ?? remote.title,
        } as Omit<Task, 'id'>);
      } catch (err) {
        log.web.warn('sync-reconciler: failed to create task', {
          pluginId,
          remoteId: remote.remoteId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Apply updates (batch limit: 100)
    // Protect local-only fields: note, summary, conversation_log
    const updateBatch = diff.toUpdate.slice(0, 100);
    for (const { local, remote } of updateBatch) {
      try {
        const updates = { ...remote.fields };
        // Never overwrite local-only fields from remote
        delete (updates as any).note;
        delete (updates as any).summary;
        delete (updates as any).conversation_log;
        // Never overwrite session fields
        delete (updates as any).session_id;
        delete (updates as any).session_ids;
        delete (updates as any).plan_session_id;
        delete (updates as any).exec_session_id;
        // Never overwrite local-only sync metadata
        delete (updates as any)._syncedAt;
        // Never overwrite phase/status/needs_attention from remote (RC8 fix)
        delete (updates as any).phase;
        delete (updates as any).status;
        delete (updates as any).needs_attention;

        await ctx.updateTask(local.id, updates);
      } catch (err) {
        log.web.warn('sync-reconciler: failed to update task', {
          pluginId,
          taskId: local.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Apply removals — skip tasks with actively-running sessions
    for (const task of diff.toRemove) {
      try {
        if (await this.hasActiveSession(task)) {
          log.web.info('sync-reconciler: skipping removal of task with active session', {
            pluginId,
            taskId: task.id,
            title: task.title,
          });
          continue;
        }
        await ctx.deleteTask(task.id);
        log.web.info('sync-reconciler: removed task no longer in remote', {
          pluginId,
          taskId: task.id,
          title: task.title,
        });
      } catch (err) {
        // ActiveSessionError or other — log and continue
        log.web.warn('sync-reconciler: failed to remove task', {
          pluginId,
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Check if a task has any actively-running sessions (process alive, work in progress). */
  private async hasActiveSession(task: Task): Promise<boolean> {
    const sessionIds = [task.session_id, task.plan_session_id, task.exec_session_id].filter(Boolean) as string[];
    if (sessionIds.length === 0) return false;

    // Look up actual session status — only block if process is actively running
    try {
      const { listSessions } = await import('./session-tracker.js');
      const sessions = await listSessions();
      for (const sid of sessionIds) {
        const session = sessions.find(s => s.claudeSessionId === sid);
        if (session && session.process_status === 'running') return true;
      }
    } catch {
      // If we can't check, be conservative — block removal if session_id is set
      return sessionIds.length > 0;
    }

    return false;
  }

  // ── Private: State persistence ──

  private stateFile(pluginId: string): string {
    return path.join(SYNC_DIR, `reconcile-${pluginId}.json`);
  }

  private loadState(pluginId: string): ReconcileState {
    const cached = this.stateCache.get(pluginId);
    if (cached) return cached;

    const filePath = this.stateFile(pluginId);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.stateCache.set(pluginId, data);
      return data;
    } catch {
      const fresh: ReconcileState = {
        deltaEpoch: 0,
        lastFullReconcileAt: new Date(0).toISOString(),
        lastFullPullCount: 0,
        updatedAt: new Date().toISOString(),
      };
      this.stateCache.set(pluginId, fresh);
      return fresh;
    }
  }

  private saveState(pluginId: string, state: ReconcileState): void {
    state.updatedAt = new Date().toISOString();
    this.stateCache.set(pluginId, state);
    try {
      fs.writeFileSync(this.stateFile(pluginId), JSON.stringify(state, null, 2));
    } catch (err) {
      log.web.warn('sync-reconciler: failed to save state', {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Singleton instance. */
export const syncReconciler = new SyncReconciler();

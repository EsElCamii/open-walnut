/**
 * Integration Plugin System — Type Definitions
 *
 * Every integration plugin implements these interfaces.
 * Core never references specific integrations — only talks through the registry.
 */

import type { Task, TaskPhase, TaskPriority } from './types.js';
import type { SubsystemLogger } from '../logging/index.js';
import type { Router } from 'express';

// ── RemoteSyncItem: standardized representation of a remote task for reconciliation ──

export interface RemoteSyncItem {
  /** Join key — must match what extractRemoteId() returns for local tasks. */
  remoteId: string;
  /** Title for logging and fallback matching. */
  title: string;
  /** ISO timestamp — framework uses this to decide who is newer. */
  remoteUpdatedAt: string;
  /** True if the remote item was deleted/archived. */
  deleted?: boolean;
  /** Mapped local fields (including ext) — ready to merge into a Task. */
  fields: Partial<Task>;
}

// ── ExtData: plugin-specific fields written to task.ext ──

export interface ExtData {
  [key: string]: unknown;
}

// ── SyncPollContext: passed to plugins during periodic sync ──

export interface SyncPollContext {
  getTasks(): Task[];
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  addTask(data: Omit<Task, 'id'>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  emit(event: string, data: unknown): void;
}

// ── PushResult: server-side timestamp for echo detection ──

/** Push response — plugins MUST return server-side timestamp for echo detection. */
export interface PushResult {
  /** Server-side last-modified timestamp (ISO string) from the push API response.
   *  Framework stores this as _syncedAt for echo detection on pull. */
  serverTimestamp: string;
  /** Plugin-specific ext data updates (optional). */
  ext?: Record<string, unknown>;
}

// ── IntegrationSync: strict plugin sync interface ──
// Every method is REQUIRED. Plugin maps Walnut's features to platform capabilities.
// Phase is the only status concept — plugins map 7 phases to whatever the platform supports.

export interface IntegrationSync {
  // ── Task Lifecycle ──
  createTask(task: Task): Promise<ExtData | null>;
  deleteTask(task: Task): Promise<void>;

  // ── Field Updates (called individually per mutation) ──
  updateTitle(task: Task, title: string): Promise<void>;
  updateDescription(task: Task, description: string): Promise<void>;
  updateSummary(task: Task, summary: string): Promise<void>;
  updateNote(task: Task, note: string): Promise<void>;
  updateConversationLog(task: Task, log: string): Promise<void>;
  updatePriority(task: Task, priority: TaskPriority): Promise<void>;
  updatePhase(task: Task, phase: TaskPhase): Promise<void>;
  updateDueDate(task: Task, date: string | null): Promise<void>;
  updateStar(task: Task, starred: boolean): Promise<void>;
  updateCategory(task: Task, category: string, project: string): Promise<void>;
  updateDependencies(task: Task, dependsOn: string[]): Promise<void>;

  // ── Subtask Relationship (child tasks are full Tasks with parent_task_id) ──
  associateSubtask(parentTask: Task, childTask: Task): Promise<void>;
  disassociateSubtask(parentTask: Task, childTask: Task): Promise<void>;

  // ── Content Validation (optional — reject content before store write) ──
  /** Return error string to reject, null to accept. */
  validateContent?(task: Task, field: string, value: string): string | null;

  // ── Full Push (single-call push with server timestamp for echo detection) ──
  /** Push all mutable fields to remote. Returns server-side timestamp for echo detection.
   *  Framework calls this for existing tasks instead of individual update* methods.
   *  Plugins MUST capture the server's lastModified from the API response. */
  pushTask(task: Task): Promise<PushResult>;

  // ── Pull (periodic sync from remote) ──
  syncPoll(ctx: SyncPollContext): Promise<void>;

  // ── Full Reconciliation (optional — enables framework-driven full sync) ──

  /** Pull ALL remote items matching this plugin's scope (no date filter).
   *  Framework calls this periodically to detect drift, deletions, and unassignments.
   *  Return undefined/null to skip reconciliation for this tick. */
  fullPull?(ctx: SyncPollContext): Promise<RemoteSyncItem[] | undefined | null>;

  /** Extract the remote ID from a local task's ext data.
   *  Used to join local tasks with fullPull results. */
  extractRemoteId?(task: Task): string | undefined;
}

// ── CategoryClaimFn: determines if a plugin owns a category ──

export type CategoryClaimFn = (category: string) => boolean | Promise<boolean>;

// ── DisplayMeta: UI rendering metadata for a plugin ──

export interface DisplayMeta {
  badge: string;
  badgeColor: string;
  externalLinkLabel: string;
  getExternalUrl(task: Task): string | null;
  isSynced(task: Task): boolean;
  syncTooltip?(task: Task): string;
  /** Language hint for triage agents (e.g. 'en', 'zh'). Plugins set this so core prompts can choose the right language without hardcoding plugin IDs. */
  languageHint?: string;
}

// ── HttpRoute: plugin-registered HTTP routes ──

export interface HttpRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  handler: Router;
}

// ── MigrateFn: one-time data migration function ──

export type MigrateFn = (tasks: Task[]) => Promise<Task[]> | Task[];

// ── PluginApi: the registration interface passed to plugin entry points ──

export interface PluginApi {
  id: string;
  name: string;
  config: Record<string, unknown>;
  logger: SubsystemLogger;

  registerSync(sync: IntegrationSync): void;
  registerSourceClaim(fn: CategoryClaimFn, opts?: { priority?: number }): void;
  registerDisplay(meta: DisplayMeta): void;
  registerAgentContext(snippet: string): void;
  registerMigration(fn: MigrateFn): void;
  registerHttpRoute(route: HttpRoute): void;
}

// ── RegisteredPlugin: aggregated result after plugin registration ──

export interface RegisteredPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  config: Record<string, unknown>;
  sync: IntegrationSync;
  claim?: { fn: CategoryClaimFn; priority: number };
  display?: DisplayMeta;
  agentContext?: string;
  migrations: MigrateFn[];
  httpRoutes: HttpRoute[];
}

// ── Manifest: plugin manifest.json schema ──

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
}

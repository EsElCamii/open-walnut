/**
 * Built-in session hooks.
 *
 * These are the default hooks that ship with Walnut.
 * They can be overridden or disabled via config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type {
  SessionHookDefinition,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
  OnMessageSendPayload,
  OnToolUsePayload,
} from './types.js';

// ── Triage dedup state ──
// Prevents burst triage dispatches when daemon replays old JSONL events after
// server restart (same session:result emitted N times in milliseconds).
// Key: "sessionId:taskId", Value: last dispatch timestamp.
const triageLastDispatch = new Map<string, number>();
const TRIAGE_COOLDOWN_MS = 5_000; // 5 seconds — normal triage cycle takes 10-30s

/**
 * turn-complete-triage: Dispatches a triage subagent on turn completion.
 * Hook: onTurnComplete. Replaces the hardcoded triage block in server.ts.
 */
export const turnCompleteTriageHook: SessionHookDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Triage (onTurnComplete)',
  description: 'Dispatches triage subagent when a session turn completes successfully.',
  hooks: ['onTurnComplete'],
  priority: 50,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnCompletePayload;
    if (!p.taskId) return; // No task → no triage

    // Skip triage for embedded subagent sessions (provider='embedded').
    if (p.session?.provider === 'embedded') return;

    // Cooldown: prevent burst dispatches from replayed events after server restart.
    // The daemon may replay N result events in milliseconds — without this guard,
    // each one spawns a full triage subagent (get_task + update_task + notify_main_agent).
    const dedupKey = `${p.sessionId}:${p.taskId}`;
    const now = Date.now();

    // Prune stale entries to prevent unbounded growth
    if (triageLastDispatch.size > 100) {
      for (const [k, ts] of triageLastDispatch) {
        if (now - ts > TRIAGE_COOLDOWN_MS) triageLastDispatch.delete(k);
      }
    }

    const lastAt = triageLastDispatch.get(dedupKey);
    if (lastAt && now - lastAt < TRIAGE_COOLDOWN_MS) {
      log.session.warn('turn-complete-triage: skipped — cooldown', {
        taskId: p.taskId, sessionId: p.sessionId,
        msSinceLast: now - lastAt,
      });
      return;
    }
    triageLastDispatch.set(dedupKey, now);

    try {
      const { DEFAULT_TRIAGE_AGENT_ID } = await import('../agent-registry.js');
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      const triageAgentId = config.agent?.session_triage_agent ?? DEFAULT_TRIAGE_AGENT_ID;

      // Build recent notification history so triage can avoid duplicates
      let notificationContext = '';
      try {
        const { getTriageEntries } = await import('../chat-history.js');
        const { entries } = await getTriageEntries(10, p.taskId);
        // Filter to entries that actually triggered main agent notification:
        // New entries: tag:'ai' source:'triage' (stored via addAIMessages)
        // Legacy entries: notification === false (stored via addNotification)
        const notified = entries.filter(e => e.tag === 'ai' || e.notification === false);
        if (notified.length > 0) {
          const lines = notified.slice(0, 5).map(e => {
            const ts = e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
            const contentStr = typeof e.content === 'string' ? e.content : '';
            const summary = contentStr.slice(0, 150) || '(no content)';
            return `[${ts}] ${summary}`;
          });
          notificationContext = `<recent_notifications>\nThese are the most recent notifications you sent to the main agent for this task:\n${lines.join('\n')}\n</recent_notifications>`;
        }
      } catch (err) {
        log.session.warn('failed to load notification history for triage', {
          taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }

      const sessionType = p.isPlanSession ? 'plan-mode ' : '';
      const triageTask = `A Claude Code ${sessionType}session just finished for task ${p.taskId}. Session ID: ${p.sessionId}. Turn index: ${p.turnIndex ?? 'unknown'}.\n\nThe <session_history> context below contains recent messages (User + Assistant) with [index] labels. Use these to determine the current phase. If you need full details of a specific message, call get_session_history with index=N.`;

      bus.emit('subagent:start', {
        agentId: triageAgentId,
        task: triageTask,
        taskId: p.taskId,
        context_override: { taskId: p.taskId, sessionId: p.sessionId, cwd: p.session?.cwd, host: p.session?.host },
        ...(notificationContext ? { context: notificationContext } : {}),
      }, ['subagent-runner'], { source: 'turn-complete-triage' });

      log.session.info('turn-complete-triage hook: dispatched', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        agentId: triageAgentId,
      });
    } catch (err) {
      log.session.error('turn-complete-triage hook failed', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/**
 * message-send-triage: Dispatches a lightweight triage subagent on user message send.
 * Classifies user intent, updates task.summary.Latest, logs the interaction.
 */
export const messageSendTriageHook: SessionHookDefinition = {
  id: 'message-send-triage',
  name: 'Message Send Triage',
  description: 'Dispatches lightweight triage subagent when a user sends a message to a session.',
  hooks: ['onMessageSend'],
  priority: 60,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnMessageSendPayload;
    if (!p.taskId) return; // No task → skip

    // Skip subagent sends (provider='embedded') to prevent loop
    if (p.session?.provider === 'embedded') return;

    try {
      const { DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID } = await import('../agent-registry.js');
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      const agentId = config.agent?.message_send_triage_agent ?? DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID;

      const triageTask = `User sent a message to session ${p.sessionId} for task ${p.taskId}.\n\nMessage:\n${(p.message ?? '').slice(0, 2000)}`;

      bus.emit('subagent:start', {
        agentId,
        task: triageTask,
        taskId: p.taskId,
        context_override: { taskId: p.taskId, sessionId: p.sessionId, cwd: p.session?.cwd, host: p.session?.host },
      }, ['subagent-runner'], { source: 'message-send-triage' });

      log.session.info('message-send-triage hook: dispatched', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        agentId,
      });
    } catch (err) {
      log.session.error('message-send-triage hook failed', {
        sessionId: p.sessionId,
        taskId: p.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/**
 * session-error-notify: Logs session errors.
 */
export const sessionErrorNotifyHook: SessionHookDefinition = {
  id: 'session-error-notify',
  name: 'Session Error Notify',
  description: 'Logs session errors for monitoring.',
  hooks: ['onTurnError'],
  priority: 90,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnErrorPayload;
    log.session.warn('session hook: turn error detected', {
      sessionId: p.sessionId,
      taskId: p.taskId,
      error: p.error?.slice(0, 200),
      isSessionError: p.isSessionError,
    });
  },
};

// ── CWD rename detector ──
// Escape a string for use inside a RegExp character class / pattern.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Conservative: absolute `mv` / `git mv` where the first operand equals task.cwd.
// We intentionally don't try to parse relative paths or shell pipelines —
// false positives would be worse than the Layer-2 tail check catching it.
function detectCwdRename(command: string, cwd: string): string | null {
  const escaped = escapeRegExp(cwd.replace(/\/+$/, ''));
  // Match: optional leading whitespace, (git )?mv, optional flags, then <cwd>(/)? <dest>
  const re = new RegExp(
    `^\\s*(?:git\\s+)?mv\\s+(?:-[-\\w]+\\s+)*${escaped}/?\\s+("[^"]+"|'[^']+'|\\S+)`,
  );
  const m = command.match(re);
  if (!m) return null;
  let dst = m[1];
  if ((dst.startsWith('"') && dst.endsWith('"')) || (dst.startsWith("'") && dst.endsWith("'"))) {
    dst = dst.slice(1, -1);
  }
  // Relative dest resolves against the Bash tool's cwd, which is task.cwd — not its parent.
  if (!path.isAbsolute(dst)) {
    dst = path.resolve(cwd, dst);
  }
  return dst;
}

/**
 * Session CWD rename defense — Layers 1 + 2.
 *
 * Why this exists: Claude Code stores session JSONL at
 * `~/.claude/projects/<sanitize(cwd)>/<sid>.jsonl` where
 * `sanitize = replace(/[^a-zA-Z0-9]/g, '-')`. `claude --resume` is strictly
 * cwd-scoped with no fallback search. If a session renames its own cwd
 * mid-work, subsequent resumes silently lose all history.
 *
 *  - Layer 1 (onToolUse, here): regex-match `mv`/`git mv` of task.cwd in Bash
 *    calls → updateTask({cwd: new}) which triggers JSONL migration to the new
 *    encoded dir. Regex is intentionally conservative (absolute paths only).
 *  - Layer 2 (onTurnComplete, here): existsSync tail-check for renames the
 *    regex missed (Node fs.renameSync, IDE drives, rsync, external deletes)
 *    → flag task.cwd_missing + notify once (dedup on transition).
 *  - Layer 3 (providers/cwd-check.ts): pre-spawn existsSync guard — aborts
 *    spawn with SESSION_ERROR instead of "session created and running" when
 *    the spawn would ENOENT.
 */
export const cwdRenameDetectorHook: SessionHookDefinition = {
  id: 'cwd-rename-detector',
  name: 'CWD Rename Detector',
  description: 'Auto-updates task.cwd when a session renames its own working directory, and flags missing cwds at turn end.',
  hooks: ['onToolUse', 'onTurnComplete'],
  priority: 40,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const ctx = payload as OnToolUsePayload & OnTurnCompletePayload;
    const taskId = ctx.taskId;
    const cwd = ctx.session?.cwd ?? ctx.task?.cwd;
    // Skip remote sessions — migration happens on a different filesystem.
    if (ctx.session?.host) return;
    if (!taskId || !cwd) return;

    // Phase discriminator: `toolName` is a required field on OnToolUsePayload
    // and absent from OnTurnCompletePayload. Gating here ensures the turn-end
    // existsSync check does NOT run on every Edit/Write/Read tool call.
    if ('toolName' in payload) {
      // Branch 1 (Layer 1): onToolUse(Bash) — detect session-initiated renames.
      if ((ctx as OnToolUsePayload).toolName !== 'Bash') return;
      const cmd = ((ctx as OnToolUsePayload).input?.command ?? '') as string;
      if (!cmd) return;
      const newCwd = detectCwdRename(cmd, cwd);
      if (!newCwd) return;
      log.session.info('cwd-rename-detector: matched mv pattern', {
        sessionId: ctx.sessionId, taskId, oldCwd: cwd, newCwd, cmd: cmd.slice(0, 200),
      });
      try {
        const { updateTask } = await import('../task-manager.js');
        // updateTask triggers JSONL migration + session-record cwd sync (see task-manager.ts).
        await updateTask(taskId, { cwd: newCwd }, { source: 'cwd-rename-detector' });
      } catch (err) {
        log.session.warn('cwd-rename-detector: updateTask failed', {
          sessionId: ctx.sessionId, taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Branch 2 (Layer 2): onTurnComplete — tail check for missed renames / external deletes.
    try {
      if (fs.existsSync(cwd)) return;
      log.session.warn('cwd-rename-detector: cwd missing at turn end', {
        sessionId: ctx.sessionId, taskId, cwd,
      });
      // Dedup notification: only emit when the flag transitions false→true so
      // a persistently-broken cwd doesn't spam the UI on every turn.
      const { getTask, updateTask } = await import('../task-manager.js');
      let wasMissing = false;
      try {
        const existing = await getTask(taskId);
        wasMissing = existing.cwd_missing === true;
      } catch {
        // Task may have been archived/deleted between turns — treat as "not flagged yet".
      }
      await updateTask(taskId, { cwd_missing: true }, { source: 'cwd-rename-detector' });
      if (!wasMissing) {
        bus.emit('notification', {
          taskId,
          message: `Working directory no longer exists: ${cwd}. Update the task's working directory to resume.`,
          severity: 'warning',
        }, ['web-ui', 'main-agent'], { source: 'cwd-rename-detector' });
      }
    } catch (err) {
      log.session.warn('cwd-rename-detector: turn-end check failed', {
        sessionId: ctx.sessionId, taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/** All built-in hook definitions. */
export const builtinHooks: SessionHookDefinition[] = [
  turnCompleteTriageHook,
  messageSendTriageHook,
  sessionErrorNotifyHook,
  cwdRenameDetectorHook,
];

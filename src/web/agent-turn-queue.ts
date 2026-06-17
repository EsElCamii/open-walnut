/**
 * Console Agent Turn Queue — serializes agent turns per console agent.
 *
 * Each console agent (General, Mentor, custom) has its own queue with
 * concurrency=1 so that Agent B can respond instantly even while Agent A
 * is mid-turn. Different agents have different system prompts, tools, and
 * chat histories, so there's no prompt-cache benefit to sharing a queue.
 *
 * Callers that share a console agent's history must go through this queue:
 * - WS chat (user messages)
 * - Cron main-session jobs (wakeMode: 'now') → General queue
 * - Session/subagent triage (post-result AI processing) → General queue
 *
 * Callers that do NOT need the queue (isolated, independent history):
 * - Cron isolated jobs (empty history, never write chat-history)
 * - Embedded subagents (own history)
 * - Compaction summarizer (empty history)
 */

import { log } from '../logging/index.js';

interface QueueEntry<T> {
  label: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

interface AgentQueue {
  queue: QueueEntry<unknown>[];
  active: number;
}

const queues = new Map<string, AgentQueue>();

const WARN_WAIT_MS = 2_000;

function getOrCreate(agentId: string): AgentQueue {
  let q = queues.get(agentId);
  if (!q) {
    q = { queue: [], active: 0 };
    queues.set(agentId, q);
  }
  return q;
}

/**
 * Try to start the next queued task for a specific agent if the slot is free.
 */
function pump(agentId: string): void {
  const q = queues.get(agentId);
  if (!q) return;

  while (q.active < 1 && q.queue.length > 0) {
    const entry = q.queue.shift()!;
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > WARN_WAIT_MS) {
      log.agent.warn('agent turn queue: long wait', {
        agentId,
        label: entry.label,
        waitMs,
        queued: q.queue.length,
      });
    }
    log.agent.info('agent turn queue: dequeue', {
      agentId,
      label: entry.label,
      waitMs,
      queued: q.queue.length,
    });
    q.active++;
    void (async () => {
      const startMs = Date.now();
      try {
        const result = await entry.task();
        q.active--;
        log.agent.info('agent turn queue: done', {
          agentId,
          label: entry.label,
          durationMs: Date.now() - startMs,
          queued: q.queue.length,
        });
        pump(agentId);
        entry.resolve(result);
      } catch (err) {
        q.active--;
        log.agent.error('agent turn queue: error', {
          agentId,
          label: entry.label,
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
        pump(agentId);
        entry.reject(err);
      }
    })();
  }
}

/**
 * Enqueue a turn for a specific console agent.
 * Each agent has its own concurrency=1 queue — no cross-agent blocking.
 *
 * @param agentId — console agent ID (e.g. 'general', 'mentor')
 * @param label — human-readable label for logging (e.g. 'chat', 'cron:reminder')
 * @param task — async function that runs the agent turn
 */
export function enqueueAgentTurn<T>(
  agentId: string,
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  const q = getOrCreate(agentId);
  return new Promise<T>((resolve, reject) => {
    q.queue.push({
      label,
      task: () => task() as Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    });
    log.agent.info('agent turn queue: enqueue', {
      agentId,
      label,
      queueSize: q.queue.length + q.active,
    });
    pump(agentId);
  });
}

/**
 * Enqueue a main-agent (General) turn. Backward-compatible alias.
 */
export function enqueueMainAgentTurn<T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueueAgentTurn('general', label, task);
}

// ─── Per-conversation last-turn exact token count ──────────────────────
// The Bedrock API returns the EXACT input-token count (system + tools +
// messages, incl. cache) on every successful call. That is the only
// trustworthy size signal — our offline estimator (estimateFullPayload, built
// on @anthropic-ai/tokenizer / Claude-2 BPE) systematically undercounts
// Claude 3+ payloads by ~35%, which made the triage 0.92 bail check never fire
// (it estimated ~760K for a real ~1.03M-token history and sailed under the
// 920K threshold). We cache the last real count per conversation so the next
// turn's pre-check can reason in real-token space instead of estimate space.
const lastTurnExactTokens = new Map<string, number>();

/** Record the exact input-token count reported by the API for a conversation's last turn. */
export function recordLastTurnTokens(conversationId: string, exactInputTokens: number): void {
  if (exactInputTokens > 0) lastTurnExactTokens.set(conversationId, exactInputTokens);
}

/** Get the exact input-token count from the conversation's last successful turn, if known. */
export function getLastTurnTokens(conversationId: string): number | undefined {
  return lastTurnExactTokens.get(conversationId);
}

/**
 * Get the current queue status for a specific agent (or all agents).
 */
export function getQueueStatus(agentId?: string): { active: number; queued: number } {
  if (agentId) {
    const q = queues.get(agentId);
    return q ? { active: q.active, queued: q.queue.length } : { active: 0, queued: 0 };
  }
  // Aggregate across all agents
  let active = 0;
  let queued = 0;
  for (const q of queues.values()) {
    active += q.active;
    queued += q.queue.length;
  }
  return { active, queued };
}

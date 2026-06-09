/**
 * Conversation distill — periodically extract durable knowledge from a
 * conversation's messages into the agent's MEMORY.md (Opus model).
 *
 * Mental model: a conversation is disposable; MEMORY.md is the agent's lasting
 * brain. Distill mines a conversation for facts/preferences/decisions worth
 * keeping, then APPENDS a dated section to MEMORY.md. Runs on a timer (X hours
 * after creation + periodic) and on delete.
 *
 * Cost guard: at most ONE Opus distill runs at a time (module mutex); the sweep
 * processes ONE conversation per tick. Dedup: skip if no new messages since the
 * last distill (lastDistilledMessageCount) and respect age thresholds.
 *
 * SIMPLEST CORRECT APPROACH (per contract §8): we do NOT rely on the `memory`
 * tool (whose agent-scoping is implicit). Instead we run a tool-less Opus loop
 * that returns plain-text bullets, then append them to the AGENT's MEMORY.md via
 * memory-file.ts — deterministic and correctly agent-scoped.
 */

import { log } from '../logging/index.js';
import { listConversations, markDistilled } from './conversations.js';
import { getMemoryFile, updateMemoryFile, ensureMemoryFile } from './memory-file.js';
import * as chatHistory from './chat-history.js';
import type { MessageParam } from '../agent/model.js';
import type { ChatEntry } from './types.js';

const DISTILL_MIN_MESSAGES = 4;                 // need at least this many logical msgs
const DISTILL_FIRST_DELAY_MS = 2 * 3600_000;    // 2h after creation before first distill
const DISTILL_INTERVAL_MS = 6 * 3600_000;       // re-distill every 6h if new messages

// Module-level mutex: at most ONE distill at a time (Opus cost guard).
let distilling = false;

const NOTHING_TO_PERSIST = 'Nothing to persist.';

/** Minimal system prompt — the full butler prompt is irrelevant for a tool-less
 *  text extraction and would inflate every (uncached) distill call with ~120K of
 *  tools/persona. Keep the model on-task and cheap. */
const DISTILL_SYSTEM = 'You are a knowledge distiller. Extract durable facts from a conversation into concise memory bullets. Do nothing else.';

/**
 * Flatten display entries (+ any compaction summary) into a compact MessageParam[]
 * of plain text for the extraction loop. We use DISPLAY entries (not model context)
 * so compacted turns still contribute — their gist survives as the prepended
 * compaction summary, and recent turns as their display text. Tool-call/result
 * noise is dropped; only human-meaningful text is kept (that's all distill needs).
 */
function displayEntriesToDistillInput(entries: ChatEntry[], summary: string | null): MessageParam[] {
  const msgs: MessageParam[] = [];
  if (summary) {
    msgs.push({ role: 'user', content: `[Earlier conversation summary]\n${summary}` } as MessageParam);
  }
  for (const e of entries) {
    let text = '';
    if (typeof e.content === 'string') text = e.content;
    else if (e.tag === 'ai' && e.displayText) text = e.displayText;
    else if (Array.isArray(e.content)) {
      text = (e.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
    }
    text = text.trim();
    if (!text) continue;
    msgs.push({ role: e.role === 'assistant' ? 'assistant' : 'user', content: text } as MessageParam);
  }
  return msgs;
}

/** Build the plain-text extraction prompt. */
function buildDistillMessage(agentName: string, existingMemory: string): string {
  return `You are distilling a conversation into durable memory for the "${agentName}" agent.
Review the conversation. Extract ONLY knowledge worth remembering long-term:
- Facts/preferences the user revealed about themselves or this topic
- Decisions made that affect future interactions
- Stable domain knowledge

DO NOT extract: greetings, ephemeral requests, one-off task details, things already
in the agent's existing memory (shown below).

<existing-memory>
${existingMemory}
</existing-memory>

Output 0-8 concise bullet points (markdown "- "), each a self-contained fact.
If there is nothing new worth saving, output exactly: ${NOTHING_TO_PERSIST}`;
}

/**
 * Distill a single conversation into the agent's MEMORY.md.
 * Returns true if knowledge was persisted, false if skipped (dedup / too short /
 * nothing new).
 */
export async function distillConversation(agentId: string, conversationId: string): Promise<boolean> {
  // 1. Read meta + conversation messages.
  const conversations = await listConversations(agentId);
  const meta = conversations.find((c) => c.id === conversationId);
  if (!meta) {
    log.agent.debug('distill: conversation not found', { agentId, conversationId });
    return false;
  }

  // Distill from the FULL display history (includes compacted entries' text),
  // not getModelContext — the latter drops compacted entries and the compaction
  // summary, so a long/auto-compacted conversation (exactly the ones most worth
  // distilling) would otherwise be near-empty here while dedup below still
  // records meta.messageCount, permanently suppressing future distills.
  const { messages: displayEntries } = await chatHistory.getDisplayEntries(1, Number.MAX_SAFE_INTEGER, agentId, conversationId);
  const summary = await chatHistory.getCompactionSummary(agentId, conversationId);
  const messages = displayEntriesToDistillInput(displayEntries, summary);

  // 2. Dedup: nothing new since last distill.
  if (meta.messageCount <= meta.lastDistilledMessageCount) {
    log.agent.debug('distill: no new messages since last distill', {
      agentId, conversationId, messageCount: meta.messageCount, lastDistilled: meta.lastDistilledMessageCount,
    });
    return false;
  }

  // 3. Not enough content to be worth distilling.
  if (meta.messageCount < DISTILL_MIN_MESSAGES || messages.length < 2) {
    log.agent.debug('distill: too few messages', { agentId, conversationId, messageCount: meta.messageCount });
    return false;
  }

  // 4. Read existing MEMORY.md to pass as "already known".
  ensureMemoryFile(agentId);
  const memFile = getMemoryFile(agentId);
  const existingMemory = memFile?.content ?? '(empty)';

  // 5. Run a tool-less Opus loop: plain-text bullet extraction.
  const { runAgentLoop } = await import('../agent/loop.js');
  const { getConfig } = await import('./config-manager.js');
  const { getConsoleAgent } = await import('./agent-registry.js');
  const config = await getConfig();
  // Use the agent's real display name (not the raw slug) in the prompt.
  const agentDef = await getConsoleAgent(agentId);
  const agentName = agentDef?.name ?? (meta.agentId === 'general' ? 'Walnut' : meta.agentId);

  const distillMessage = buildDistillMessage(agentName, existingMemory);
  const result = await runAgentLoop(distillMessage, messages, {
    onTextDelta: () => {},
  }, {
    source: 'conversation-distill',
    system: DISTILL_SYSTEM,
    // Main model is Opus in this deployment; pass it explicitly to force Opus.
    modelConfig: { model: config.agent?.main_model },
    tools: [],
    maxToolRounds: 1,
  });

  const bullets = (result.response ?? '').trim();
  if (!bullets || bullets === NOTHING_TO_PERSIST || /^nothing to persist\b/i.test(bullets)) {
    log.agent.info('distill: nothing new to persist', { agentId, conversationId });
    // Still mark distilled so we don't re-run on the same (unchanged) messages.
    await markDistilled(agentId, conversationId, meta.messageCount);
    return false;
  }

  // 6. Append a dated section to the agent's MEMORY.md.
  // Retry the read-modify-write on hash conflict: the agent's own `memory` tool
  // may write MEMORY.md concurrently (during a live turn). updateMemoryFile throws
  // on a stale hash; swallowing that would silently drop the distilled knowledge
  // AND skip markDistilled below, so we'd re-spend Opus next sweep. Re-read and
  // re-append instead so both writers' content survives.
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n\n## Distilled from conversation (${meta.title}, ${date})\n${bullets}\n`;
  let appended = false;
  for (let attempt = 0; attempt < 3 && !appended; attempt++) {
    const current = getMemoryFile(agentId);
    const base = current?.content ?? existingMemory;
    try {
      await updateMemoryFile(base + section, current?.contentHash, agentId);
      appended = true;
    } catch (err) {
      log.agent.debug('distill: MEMORY.md write conflict, retrying', {
        agentId, conversationId, attempt, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!appended) {
    log.agent.warn('distill: MEMORY.md append failed after retries', { agentId, conversationId });
    return false; // leave un-marked so a later sweep retries
  }
  log.agent.info('distill: appended to MEMORY.md', { agentId, conversationId, bulletsLength: bullets.length });

  // 7. Record the distill.
  await markDistilled(agentId, conversationId, meta.messageCount);
  return true;
}

/**
 * Run a distill with the module mutex.
 * - timer reason: skip if a distill is already running (don't queue up Opus calls).
 * - delete reason: distill before deletion to capture knowledge, but skip if a
 *   distill is already running — blocking the HTTP delete on a slow in-flight Opus
 *   call is worse than the rare knowledge loss. (awaitIt is accepted for caller
 *   intent/back-compat but no longer spin-waits; the synchronous mutex claim below
 *   is what guarantees the one-at-a-time cost guard.)
 * Errors are swallowed (logged) — distill must never break the chat/delete flow.
 */
export async function triggerConversationDistill(
  agentId: string,
  conversationId: string,
  opts: { reason: 'delete' | 'timer'; awaitIt?: boolean },
): Promise<void> {
  // Claim the mutex SYNCHRONOUSLY (no await between check and set) so two callers
  // — e.g. the 30-min sweep firing while a DELETE distill runs — can't both pass.
  // The whole cost guard ("at most one Opus distill at a time") depends on this
  // being atomic; an async check-then-set would let both proceed and the first
  // finally{} would clear the flag out from under the second. Mirrors the
  // synchronous slot-claim in background-compaction.ts.
  if (distilling) {
    if (opts.reason === 'timer') {
      log.agent.debug('distill skipped — another distill in progress', { agentId, conversationId });
      return;
    }
    // delete path: knowledge would be lost on delete, but blocking the HTTP
    // delete on a (possibly slow) in-flight Opus call is worse. Skip + log.
    log.agent.info('distill on delete skipped — another distill in progress', { agentId, conversationId });
    return;
  }
  distilling = true;

  try {
    await distillConversation(agentId, conversationId);
  } catch (err) {
    log.agent.warn('conversation distill failed', {
      agentId, conversationId, reason: opts.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    distilling = false;
  }
}

/**
 * Sweep all console agents' conversations and distill the FIRST eligible one
 * (one per tick — cost guard). Eligible = has new messages AND past the relevant
 * age threshold (first distill: 2h after creation; subsequent: 6h since last).
 */
export async function distillSweep(): Promise<void> {
  if (distilling) return; // a distill is already running this cycle

  const { getConsoleAgents } = await import('./agent-registry.js');
  const agents = await getConsoleAgents();
  const now = Date.now();

  for (const agent of agents) {
    let conversations;
    try {
      conversations = await listConversations(agent.id);
    } catch (err) {
      log.agent.debug('distill sweep: listConversations failed', {
        agentId: agent.id, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const conv of conversations) {
      if (conv.messageCount <= conv.lastDistilledMessageCount) continue;
      const eligible = conv.lastDistilledAt == null
        ? (now - new Date(conv.createdAt).getTime()) > DISTILL_FIRST_DELAY_MS
        : (now - new Date(conv.lastDistilledAt).getTime()) > DISTILL_INTERVAL_MS;
      if (!eligible) continue;

      log.agent.info('distill sweep: distilling eligible conversation', {
        agentId: agent.id, conversationId: conv.id, messageCount: conv.messageCount,
      });
      await triggerConversationDistill(agent.id, conv.id, { reason: 'timer' });
      return; // ONE conversation per sweep
    }
  }
}

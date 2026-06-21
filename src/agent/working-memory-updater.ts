/**
 * Working Memory Updater — post-sampling hook that maintains working-memory.md.
 *
 * Inspired by Claude Code's sessionMemory.ts:
 * - Trigger: 10K tokens initial + 5K token growth + 3 tool calls
 * - Method: Forked agent turn with file_edit restricted to working-memory.md
 * - Uses main model for prompt cache sharing
 */
import {
  getWorkingMemory,
  getWorkingMemoryPath,
  ensureWorkingMemory,
  getWorkingMemorySectionSizes,
  MAX_SECTION_TOKENS,
  MAX_TOTAL_WORKING_MEMORY_TOKENS,
  WORKING_MEMORY_TEMPLATE,
} from '../core/working-memory.js';
import { estimateTokens } from '../core/daily-log.js';
import { log } from '../logging/index.js';

// Thresholds borrowed from Claude Code's sessionMemory.ts. 10K initial ensures enough
// conversation context before first extraction. 5K growth + 3 tool calls ensures
// meaningful new content (prevents updating on idle/chat-only turns).
const INITIALIZATION_THRESHOLD = 10_000; // tokens before first update
const UPDATE_THRESHOLD = 5_000;          // token growth between updates
const TOOL_CALL_THRESHOLD = 3;           // min tool calls since last update

// ── State tracking (per conversation) ──
// Each conversation tracks its own update cadence. A single global object would
// let one busy conversation's tool-call/token counters suppress or wrongly trigger
// another conversation's working-memory update (cross-talk).
interface UpdaterState {
  lastMessageUuid: string | null;
  tokensAtLastExtraction: number;
  toolCallsSinceLastExtraction: number;
  extractionStartedAt: number | null;
  isCompacting: boolean;
}

function freshUpdaterState(): UpdaterState {
  return {
    lastMessageUuid: null,
    tokensAtLastExtraction: 0,
    toolCallsSinceLastExtraction: 0,
    extractionStartedAt: null,
    isCompacting: false,
  };
}

const stateByConversation = new Map<string, UpdaterState>();

function stateKey(agentId?: string, conversationId?: string): string {
  return `${agentId || 'general'}:${conversationId || '_'}`;
}

function getState(agentId?: string, conversationId?: string): UpdaterState {
  const key = stateKey(agentId, conversationId);
  let s = stateByConversation.get(key);
  if (!s) { s = freshUpdaterState(); stateByConversation.set(key, s); }
  return s;
}

/**
 * Reset updater state. With no args (server startup) clears ALL conversations'
 * state; with a conversation pair resets just that one.
 */
export function resetUpdaterState(agentId?: string, conversationId?: string): void {
  if (agentId === undefined && conversationId === undefined) {
    stateByConversation.clear();
    return;
  }
  stateByConversation.set(stateKey(agentId, conversationId), freshUpdaterState());
}

/** Mark compaction in progress (skip updates during compaction) for a conversation. */
export function setCompacting(value: boolean, agentId?: string, conversationId?: string): void {
  getState(agentId, conversationId).isCompacting = value;
}

/** Track tool call count for trigger threshold for a conversation. */
export function trackToolCall(agentId?: string, conversationId?: string): void {
  getState(agentId, conversationId).toolCallsSinceLastExtraction++;
}

/**
 * Check if working memory update should trigger for a conversation.
 * Called after each AI response in the agent loop.
 */
export function shouldUpdateWorkingMemory(currentTokens: number, agentId?: string, conversationId?: string): boolean {
  const state = getState(agentId, conversationId);
  if (state.isCompacting) return false;

  // 15s: normal update should complete within this window (single LLM call + file edit).
  // 60s: if extraction is stuck (LLM timeout, hung tool), treat as stale and allow retry.
  if (state.extractionStartedAt) {
    const elapsed = Date.now() - state.extractionStartedAt;
    if (elapsed < 15_000) return false; // still running
    if (elapsed > 60_000) {
      log.agent.warn('Working memory extraction stale, resetting');
      state.extractionStartedAt = null;
    } else {
      return false;
    }
  }

  const tokenGrowth = currentTokens - state.tokensAtLastExtraction;
  const hasEnoughToolCalls = state.toolCallsSinceLastExtraction >= TOOL_CALL_THRESHOLD;

  // First update: needs initialization threshold
  if (state.tokensAtLastExtraction === 0) {
    return currentTokens >= INITIALIZATION_THRESHOLD && hasEnoughToolCalls;
  }

  // Subsequent updates: needs token growth + tool calls
  const hasEnoughTokenGrowth = tokenGrowth >= UPDATE_THRESHOLD;
  return hasEnoughTokenGrowth && hasEnoughToolCalls;
}

/**
 * Build the update prompt for the forked agent.
 * Injected as a system message with the current working memory content.
 */
export function buildWorkingMemoryUpdatePrompt(agentId?: string, conversationId?: string): string {
  ensureWorkingMemory(agentId, conversationId);
  const current = getWorkingMemory(agentId, conversationId) ?? WORKING_MEMORY_TEMPLATE;
  const workingMemoryPath = getWorkingMemoryPath(agentId, conversationId);
  const sectionSizes = getWorkingMemorySectionSizes(current);
  const totalTokens = estimateTokens(current);

  // Build size warnings
  const warnings: string[] = [];
  for (const [section, tokens] of sectionSizes) {
    if (tokens > MAX_SECTION_TOKENS) {
      warnings.push(`WARNING: "${section}" is ${tokens} tokens (limit: ${MAX_SECTION_TOKENS}). Condense aggressively.`);
    }
  }
  if (totalTokens > MAX_TOTAL_WORKING_MEMORY_TOKENS) {
    warnings.push(`WARNING: Total working memory is ${totalTokens} tokens (limit: ${MAX_TOTAL_WORKING_MEMORY_TOKENS}). Condense all sections.`);
  }

  const warningBlock = warnings.length > 0 ? `\n\n${warnings.join('\n')}` : '';

  return `You are updating the working memory notes file at: ${workingMemoryPath}

<current_working_memory>
${current}
</current_working_memory>
${warningBlock}

## Instructions

Use the file_edit tool to update the notes file. You may make multiple edit calls in parallel.

Rules:
1. NEVER modify section headers (lines starting with "# ") or the italic descriptions.
2. Replace the italic placeholder text with actual content under each section.
3. Use Edit (find-and-replace) to update sections — do NOT rewrite the entire file.
4. Keep each section under ~${MAX_SECTION_TOKENS} tokens. Be concise: bullet points, not prose.
5. ALWAYS update "Active Focus" — it must reflect the current state.
6. Include task IDs, session IDs, and specific names — not vague descriptions.
7. Remove information that is no longer relevant (old completed tasks, resolved issues).
8. Do NOT duplicate information across sections.

Think about what happened since the last update:
- What is the user currently focused on?
- What did they ask for?
- What decisions were made and why?
- What went wrong or was surprising?
- What sessions are running?
- What's still open/unresolved?
- What patterns or lessons emerged?`;
}

/**
 * Execute the working memory update.
 * This should be called as a fire-and-forget from the agent loop's post-sampling hook.
 *
 * @param runForkedTurn - Function to run a forked agent turn (provided by the agent loop)
 * @param currentTokens - Current token count for state tracking
 */
export async function executeWorkingMemoryUpdate(
  runForkedTurn: (prompt: string) => Promise<void>,
  currentTokens: number,
  agentId?: string,
  conversationId?: string,
): Promise<void> {
  const state = getState(agentId, conversationId);
  state.extractionStartedAt = Date.now();

  try {
    const prompt = buildWorkingMemoryUpdatePrompt(agentId, conversationId);
    await runForkedTurn(prompt);

    // Update state after successful extraction
    state.tokensAtLastExtraction = currentTokens;
    state.toolCallsSinceLastExtraction = 0;
    state.lastMessageUuid = null;

    log.agent.info('Working memory updated', {
      tokens: currentTokens,
      agentId: agentId || 'general',
      conversationId,
    });
  } catch (err) {
    log.agent.warn('Working memory update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.extractionStartedAt = null;
  }
}

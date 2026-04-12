/**
 * Working Memory Updater — post-sampling hook that maintains working-memory.md.
 *
 * Inspired by Claude Code's sessionMemory.ts:
 * - Trigger: 10K tokens initial + 5K token growth + 3 tool calls
 * - Method: Forked agent turn with files_edit restricted to working-memory.md
 * - Uses main model for prompt cache sharing
 */
import {
  getWorkingMemory,
  ensureWorkingMemory,
  isWorkingMemoryEmpty,
  getWorkingMemorySectionSizes,
  MAX_SECTION_TOKENS,
  MAX_TOTAL_WORKING_MEMORY_TOKENS,
  WORKING_MEMORY_TEMPLATE,
} from '../core/working-memory.js';
import { WORKING_MEMORY_FILE } from '../constants.js';
import { estimateTokens } from '../core/daily-log.js';
import { log } from '../logging/index.js';

// ── Thresholds (from Claude Code) ──
const INITIALIZATION_THRESHOLD = 10_000; // tokens before first update
const UPDATE_THRESHOLD = 5_000;          // token growth between updates
const TOOL_CALL_THRESHOLD = 3;           // min tool calls since last update

// ── State tracking ──
interface UpdaterState {
  lastMessageUuid: string | null;
  tokensAtLastExtraction: number;
  toolCallsSinceLastExtraction: number;
  extractionStartedAt: number | null;
  isCompacting: boolean;
}

const state: UpdaterState = {
  lastMessageUuid: null,
  tokensAtLastExtraction: 0,
  toolCallsSinceLastExtraction: 0,
  extractionStartedAt: null,
  isCompacting: false,
};

/** Reset state (e.g., on session start). */
export function resetUpdaterState(): void {
  state.lastMessageUuid = null;
  state.tokensAtLastExtraction = 0;
  state.toolCallsSinceLastExtraction = 0;
  state.extractionStartedAt = null;
  state.isCompacting = false;
}

/** Mark compaction in progress (skip updates during compaction). */
export function setCompacting(value: boolean): void {
  state.isCompacting = value;
}

/** Track tool call count for trigger threshold. */
export function trackToolCall(): void {
  state.toolCallsSinceLastExtraction++;
}

/**
 * Check if working memory update should trigger.
 * Called after each AI response in the agent loop.
 */
export function shouldUpdateWorkingMemory(currentTokens: number): boolean {
  if (state.isCompacting) return false;

  // Guard against concurrent extraction (15s timeout, 1min stale)
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
export function buildWorkingMemoryUpdatePrompt(): string {
  ensureWorkingMemory();
  const current = getWorkingMemory() ?? WORKING_MEMORY_TEMPLATE;
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

  return `You are updating the working memory notes file at: ${WORKING_MEMORY_FILE}

<current_working_memory>
${current}
</current_working_memory>
${warningBlock}

## Instructions

Use the files_edit tool to update the notes file. You may make multiple edit calls in parallel.

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
): Promise<void> {
  state.extractionStartedAt = Date.now();

  try {
    const prompt = buildWorkingMemoryUpdatePrompt();
    await runForkedTurn(prompt);

    // Update state after successful extraction
    state.tokensAtLastExtraction = currentTokens;
    state.toolCallsSinceLastExtraction = 0;
    state.lastMessageUuid = null;

    log.agent.info('Working memory updated', {
      tokens: currentTokens,
    });
  } catch (err) {
    log.agent.warn('Working memory update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.extractionStartedAt = null;
  }
}

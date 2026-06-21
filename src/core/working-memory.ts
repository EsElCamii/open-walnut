/**
 * Working Memory — real-time scratchpad for the active conversation.
 * Claude Code-style: Edit overwrite (not append), structured sections, <=12K tokens.
 *
 * Used during compaction to replace traditional LLM summarization.
 * Injected on resume/new conversation/subagent startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORKING_MEMORY_FILE, COMPACTION_DIR, workingMemoryFile } from '../constants.js';
import { estimateTokens, formatDateKey } from './daily-log.js';
import { log } from '../logging/index.js';

/**
 * Resolve the working-memory file for a conversation.
 *
 * Per-conversation scratchpad lives beside the conversation's chat file. When a
 * conversationId is given we use that path; on first access we lazily migrate the
 * deprecated global working-memory.md into it ONCE (then retire the global file),
 * so an existing user's main conversation keeps its scratchpad.
 *
 * conversationId omitted → fall back to the global file. After Phase 1/2 the only
 * remaining no-conversationId caller is the deprecated global path; new callers
 * always pass the pair.
 */
function resolveWorkingMemoryPath(agentId?: string, conversationId?: string): string {
  if (!conversationId) return WORKING_MEMORY_FILE;
  const perConv = workingMemoryFile(agentId || 'general', conversationId);
  // Lazy one-time migration: if this conversation has no scratchpad yet but a
  // legacy global one exists with real content, seed from it and retire the global.
  if (!fs.existsSync(perConv) && fs.existsSync(WORKING_MEMORY_FILE)) {
    try {
      const legacy = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
      if (!isWorkingMemoryEmpty(legacy)) {
        fs.mkdirSync(path.dirname(perConv), { recursive: true });
        fs.writeFileSync(perConv, legacy, 'utf-8');
        fs.renameSync(WORKING_MEMORY_FILE, `${WORKING_MEMORY_FILE}.migrated`);
        log.agent.info('working memory migrated to conversation', { agentId: agentId || 'general', conversationId });
      }
    } catch (err) {
      log.agent.warn('working memory migration failed (non-critical)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return perConv;
}

export const MAX_SECTION_TOKENS = 2000;
export const MAX_TOTAL_WORKING_MEMORY_TOKENS = 12000;

export const WORKING_MEMORY_TEMPLATE = `# Active Focus
_What is the user currently working on? Active tasks, their IDs, and status._

# User Requests
_What did the user ask for recently? Their original words, not paraphrased. Include task IDs._

# Decisions & Rationale
_Important decisions made and WHY. Trade-offs considered. What alternatives were rejected._

# Struggles & Breakthroughs
_What blocked progress? How was it resolved? Root causes discovered. User corrections._

# Session Status
_Running sessions: what each is doing, blockers, any issues. Include session IDs._

# Open Threads
_Unresolved questions, pending items, things to follow up on._

# Learnings
_What worked well? What failed? Patterns noticed. Do not duplicate other sections._
`;

/** Get the working memory template string. */
export function getWorkingMemoryTemplate(): string {
  return WORKING_MEMORY_TEMPLATE;
}

const SECTION_HEADERS = [
  '# Active Focus',
  '# User Requests',
  '# Decisions & Rationale',
  '# Struggles & Breakthroughs',
  '# Session Status',
  '# Open Threads',
  '# Learnings',
];

/** Ensure the conversation's working-memory file exists with the template. */
export function ensureWorkingMemory(agentId?: string, conversationId?: string): void {
  const file = resolveWorkingMemoryPath(agentId, conversationId);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, WORKING_MEMORY_TEMPLATE, 'utf-8');
  }
}

/** Read a conversation's working memory content. Returns null if file doesn't exist. */
export function getWorkingMemory(agentId?: string, conversationId?: string): string | null {
  try {
    return fs.readFileSync(resolveWorkingMemoryPath(agentId, conversationId), 'utf-8');
  } catch {
    return null;
  }
}

/** Absolute path to a conversation's working-memory file (for prompts that name it). */
export function getWorkingMemoryPath(agentId?: string, conversationId?: string): string {
  return resolveWorkingMemoryPath(agentId, conversationId);
}

/** Check if working memory is empty (only template, no real content). */
export function isWorkingMemoryEmpty(content: string | null): boolean {
  if (!content) return true;
  // Strip all section headers and italic descriptions, check if anything meaningful remains
  let stripped = content;
  for (const header of SECTION_HEADERS) {
    stripped = stripped.replace(header, '');
  }
  // Remove italic placeholder lines
  stripped = stripped.replace(/_[^_]+_/g, '');
  // Remove whitespace
  stripped = stripped.replace(/\s+/g, '').trim();
  return stripped.length === 0;
}

/** Parse sections and return token sizes per section. */
export function getWorkingMemorySectionSizes(content: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const sections = content.split(/^(?=# )/m);

  for (const section of sections) {
    const headerMatch = section.match(/^# (.+)/);
    if (headerMatch) {
      sizes.set(headerMatch[1].trim(), estimateTokens(section));
    }
  }

  return sizes;
}

/**
 * Truncate working memory for compaction injection.
 * Keeps all section headers but truncates oversized sections.
 * After per-section truncation, enforces a total token budget.
 */
export function truncateWorkingMemoryForCompact(content: string, maxTokens: number = 8000): string {
  const sections = content.split(/^(?=# )/m);
  const truncated: string[] = [];

  for (const section of sections) {
    const tokens = estimateTokens(section);
    if (tokens <= MAX_SECTION_TOKENS) {
      truncated.push(section);
    } else {
      // Keep header + truncate content
      const lines = section.split('\n');
      const header = lines[0];
      const body = lines.slice(1).join('\n');
      const charBudget = MAX_SECTION_TOKENS * 4; // rough char estimate
      const truncBody = body.slice(0, charBudget) + '\n[...truncated]';
      truncated.push(`${header}\n${truncBody}`);
    }
  }

  let result = truncated.join('\n');

  // Enforce total token budget
  if (estimateTokens(result) > maxTokens) {
    const charBudget = maxTokens * 4;
    result = result.slice(0, charBudget) + '\n\n[...truncated for compaction]';
  }

  return result;
}

/**
 * Snapshot working memory to compaction archive.
 * Creates memory/compaction/YYYY-MM-DD-HHMM.md.
 */
export function snapshotWorkingMemory(agentId?: string, conversationId?: string): string | null {
  const content = getWorkingMemory(agentId, conversationId);
  if (!content || isWorkingMemoryEmpty(content)) return null;

  fs.mkdirSync(COMPACTION_DIR, { recursive: true });
  const now = new Date();
  const dateKey = formatDateKey(now);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const filename = `${dateKey}-${hours}${minutes}.md`;
  const filepath = path.join(COMPACTION_DIR, filename);

  fs.writeFileSync(
    filepath,
    `---\nsource: working-memory-snapshot\ndate: ${now.toISOString()}\n---\n\n${content}`,
    'utf-8',
  );

  return filepath;
}

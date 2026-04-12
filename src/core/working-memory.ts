/**
 * Working Memory — real-time scratchpad for the active conversation.
 * Claude Code-style: Edit overwrite (not append), structured sections, <=12K tokens.
 *
 * Used during compaction to replace traditional LLM summarization.
 * Injected on resume/new conversation/subagent startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORKING_MEMORY_FILE, COMPACTION_DIR } from '../constants.js';
import { estimateTokens, formatDateKey } from './daily-log.js';

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

const SECTION_HEADERS = [
  '# Active Focus',
  '# User Requests',
  '# Decisions & Rationale',
  '# Struggles & Breakthroughs',
  '# Session Status',
  '# Open Threads',
  '# Learnings',
];

/** Ensure working-memory.md exists with the template. */
export function ensureWorkingMemory(): void {
  if (!fs.existsSync(WORKING_MEMORY_FILE)) {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');
  }
}

/** Read the current working memory content. Returns null if file doesn't exist. */
export function getWorkingMemory(): string | null {
  try {
    return fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
  } catch {
    return null;
  }
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
 */
export function truncateWorkingMemoryForCompact(content: string): string {
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

  return truncated.join('\n');
}

/**
 * Snapshot working memory to compaction archive.
 * Creates memory/compaction/YYYY-MM-DD-HHMM.md.
 */
export function snapshotWorkingMemory(): string | null {
  const content = getWorkingMemory();
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

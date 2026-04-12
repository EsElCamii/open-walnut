import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logging/index.js';
import { MEMORY_FILE, agentMemoryDir } from '../constants.js';
import { computeContentHash, editFileContent, writeFileChecked } from '../utils/file-ops.js';

const DEFAULT_TEMPLATE = `---
name: Global Memory
description: >
  Curated knowledge and preferences. Updated by the agent as it learns.
---
`;

export interface MemoryFileResult {
  content: string;
  contentHash: string;
}

/** Resolve the MEMORY.md path for a console agent. */
function resolveMemoryPath(agentId?: string): string {
  if (!agentId || agentId === 'general') return MEMORY_FILE;
  return path.join(agentMemoryDir(agentId), 'MEMORY.md');
}

/**
 * Read the global MEMORY.md file (or an agent-specific one).
 * Returns content + contentHash for stale-check support.
 */
export function getMemoryFile(agentId?: string): MemoryFileResult | null {
  const filePath = resolveMemoryPath(agentId);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, contentHash: computeContentHash(content) };
  } catch (err) {
    log.memory.debug('memory-file: MEMORY.md not found or unreadable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Full replacement write of the global MEMORY.md file.
 * @param expectedHash — if provided, validates against current content hash before writing.
 */
export async function updateMemoryFile(
  content: string,
  expectedHash?: string,
  agentId?: string,
): Promise<{ contentHash: string }> {
  const filePath = resolveMemoryPath(agentId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const result = await writeFileChecked(filePath, content, {
    expectedHash,
  });
  return { contentHash: result.contentHash };
}

/**
 * Edit the global MEMORY.md by exact string replacement.
 * @param expectedHash — validates against current content hash before editing.
 */
export async function editMemoryFile(
  oldContent: string,
  newContent: string,
  expectedHash: string,
  replaceAll?: boolean,
  agentId?: string,
): Promise<{ replacements: number; contentHash: string }> {
  const filePath = resolveMemoryPath(agentId);
  return editFileContent(filePath, oldContent, newContent, {
    expectedHash,
    replaceAll,
  });
}

/**
 * Create MEMORY.md with a default template if it doesn't exist.
 */
export function ensureMemoryFile(agentId?: string): void {
  const filePath = resolveMemoryPath(agentId);
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, DEFAULT_TEMPLATE, 'utf-8');
}

/**
 * Inject a synthetic compact_boundary + summary into a Claude Code session JSONL.
 *
 * This allows "clear context but reuse session" — the same effect as Claude Code's
 * interactive /clear, but for headless -p mode sessions managed by Walnut.
 *
 * How it works:
 *   1. Reads the JSONL to extract session metadata (sessionId, slug, cwd, etc.)
 *   2. Appends a compact_boundary entry (parentUuid=null — breaks the chain walk)
 *   3. Appends a summary user message (parentUuid=boundary — new chain root)
 *   4. On next --resume, buildConversationChain() only sees post-boundary messages
 *   5. getMessagesAfterCompactBoundary() provides a second layer of filtering
 *
 * Tested: V3 approach — summary timestamp must be LATER than boundary,
 * and isVisibleInTranscriptOnly must NOT be set.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { log } from '../logging/index.js';

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  slug?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
}

/**
 * Extract session metadata from a JSONL file by reading the last transcript message.
 */
export async function extractSessionMeta(jsonlPath: string): Promise<SessionMeta | null> {
  const content = await fsp.readFile(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  // Walk backward to find the last transcript message with session info
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.uuid && entry.sessionId && ['user', 'assistant', 'system'].includes(entry.type)) {
        return {
          sessionId: entry.sessionId,
          cwd: entry.cwd ?? '/tmp',
          slug: entry.slug ?? undefined,
          version: entry.version ?? 'unknown',
          gitBranch: entry.gitBranch ?? undefined,
          userType: entry.userType ?? 'external',
          entrypoint: entry.entrypoint ?? 'sdk-cli',
        };
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return null;
}

/**
 * Find the UUID of the last transcript message in the JSONL.
 */
function findLastMessageUuid(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.uuid && ['user', 'assistant', 'system'].includes(entry.type)) {
        return entry.uuid;
      }
    } catch {
      // Skip
    }
  }
  return null;
}

/**
 * Inject a compact boundary + summary into a session's JSONL file.
 *
 * @param jsonlPath   Path to the session's .jsonl file
 * @param summary     The summary text to inject (typically includes plan content)
 * @param meta        Optional pre-extracted session metadata (extracted from JSONL if not provided)
 * @returns           The boundary and summary UUIDs, or null on failure
 */
export async function injectCompactBoundary(
  jsonlPath: string,
  summary: string,
  meta?: SessionMeta,
): Promise<{ boundaryUuid: string; summaryUuid: string } | null> {
  // Read file and extract metadata if not provided
  const content = await fsp.readFile(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  if (!meta) {
    const extracted = await extractSessionMeta(jsonlPath);
    if (!extracted) {
      log.session.error('Could not extract session metadata from JSONL', { jsonlPath });
      return null;
    }
    meta = extracted;
  }

  const lastMsgUuid = findLastMessageUuid(lines);
  if (!lastMsgUuid) {
    log.session.error('Could not find last message UUID in JSONL', { jsonlPath });
    return null;
  }

  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const now = new Date();
  const boundaryTs = now.toISOString();
  // Summary must be LATER — findLatestMessage uses strict > comparison
  const summaryTs = new Date(now.getTime() + 1000).toISOString();

  const baseFields = {
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    version: meta.version ?? 'unknown',
    gitBranch: meta.gitBranch,
    userType: meta.userType ?? 'external',
    entrypoint: meta.entrypoint ?? 'sdk-cli',
    ...(meta.slug ? { slug: meta.slug } : {}),
  };

  const boundaryEntry = {
    parentUuid: null,
    logicalParentUuid: lastMsgUuid,
    isSidechain: false,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: boundaryTs,
    uuid: boundaryUuid,
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 0,
      messagesSummarized: lines.length,
    },
    ...baseFields,
  };

  const summaryEntry = {
    parentUuid: boundaryUuid,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: summary,
    },
    isCompactSummary: true,
    uuid: summaryUuid,
    timestamp: summaryTs,
    ...baseFields,
  };

  // Append both entries to the JSONL
  const appendData = JSON.stringify(boundaryEntry) + '\n' + JSON.stringify(summaryEntry) + '\n';
  await fsp.appendFile(jsonlPath, appendData);

  log.session.info('Injected compact boundary into session JSONL', {
    jsonlPath,
    sessionId: meta.sessionId,
    slug: meta.slug,
    boundaryUuid,
    summaryUuid,
    summaryLength: summary.length,
  });

  return { boundaryUuid, summaryUuid };
}

/**
 * Build a compact summary that includes plan content and execution instructions.
 * This becomes the "starting context" after the boundary clears old messages.
 */
export function buildCompactSummary(planContent: string, planFilePath: string): string {
  return [
    'This session is being continued from a previous conversation that has been compacted for context efficiency.',
    'The previous conversation was a planning session that produced the following plan.',
    '',
    `Plan file: ${planFilePath}`,
    'IMPORTANT: If your context is ever compacted or summarized, re-read the plan from the file path above.',
    '',
    '---',
    '',
    planContent,
  ].join('\n');
}

import { log } from '../logging/index.js';
import { listTasks } from './task-manager.js';
import type { Task } from './types.js';

export interface SearchResult {
  type: 'task' | 'memory' | 'session';
  title: string;
  snippet: string;
  path?: string;
  taskId?: string;
  sessionId?: string;
  parentTaskId?: string;  // populated for child tasks
  isAutoExpanded?: boolean; // true if included because parent matched (not direct hit)
  score: number;        // combined normalized score
  matchField: string;   // field name of best keyword match
  keywordScore?: number;  // normalized BM25 contribution [0,1], undefined if no keyword match
  semanticScore?: number; // normalized cosine contribution [0,1], undefined if no vector match
}

export interface SearchOptions {
  limit?: number;
  types?: ('task' | 'memory' | 'session')[];
  category?: string;
}

export function extractSnippet(
  content: string,
  query: string,
  contextChars: number = 40,
): string {
  const lower = content.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let firstIndex = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
      firstIndex = idx;
    }
  }

  if (firstIndex === -1) {
    const plain = content.replace(/\n/g, ' ').trim();
    return plain.length > contextChars * 2
      ? plain.slice(0, contextChars * 2) + '...'
      : plain;
  }

  let start = Math.max(0, firstIndex - contextChars);
  let end = Math.min(content.length, firstIndex + contextChars);

  // Expand to word boundaries
  if (start > 0) {
    const spaceAfter = content.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < firstIndex) {
      start = spaceAfter + 1;
    }
  }
  if (end < content.length) {
    const spaceBefore = content.lastIndexOf(' ', end);
    if (spaceBefore > firstIndex) {
      end = spaceBefore;
    }
  }

  let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

export function scoreMatch(text: string, query: string, weight: number): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return 0;

  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += weight;
      // Bonus for exact word boundary match
      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i');
      if (regex.test(text)) {
        score += weight * 0.5;
      }
      // TF bonus: multiple occurrences signal stronger relevance.
      // log(count) dampens: 8 hits ≈ 2× single hit, not 8×.
      const count = countOccurrences(lower, term);
      if (count > 1) {
        score += weight * 0.3 * Math.log(count);
      }
    }
  }
  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Reciprocal Rank Fusion (kept for backward compatibility — used by tests) ──

/**
 * Merge two ranked result lists using normalized weighted average.
 * alpha = BM25 weight (0-1).
 * @deprecated No longer used in search(). Kept for test backward compatibility.
 */
export function normalizedFuse(
  bm25Results: SearchResult[],
  vectorResults: SearchResult[],
  alpha: number = 0.4,
): SearchResult[] {
  // Build score maps
  const bm25Scores = new Map(bm25Results.map((r) => [resultKey(r), r.score]));
  const vecScores = new Map(vectorResults.map((r) => [resultKey(r), r.score]));

  // Min-max normalize BM25 scores to [0, 1]
  const bm25Vals = [...bm25Scores.values()];
  const bm25Min = Math.min(...bm25Vals);
  const bm25Max = Math.max(...bm25Vals);
  const bm25Range = bm25Max - bm25Min || 1;
  const bm25Norm = new Map<string, number>();
  for (const [k, v] of bm25Scores) {
    bm25Norm.set(k, bm25Vals.length === 1 ? 1.0 : (v - bm25Min) / bm25Range);
  }

  // Min-max normalize cosine scores to [0, 1] using result set min/max
  const vecVals = [...vecScores.values()];
  const vecMin = Math.min(...vecVals);
  const vecMax = Math.max(...vecVals);
  const vecRange = vecMax - vecMin || 1;
  const vecNorm = new Map<string, number>();
  for (const [k, v] of vecScores) {
    vecNorm.set(k, vecVals.length === 1 ? 1.0 : (v - vecMin) / vecRange);
  }

  // Collect all unique results; prefer BM25 object (richer snippets from keyword match)
  const allKeys = new Set([...bm25Scores.keys(), ...vecScores.keys()]);
  const resultMap = new Map<string, SearchResult>();
  for (const r of bm25Results) resultMap.set(resultKey(r), r);
  for (const r of vectorResults) {
    if (!resultMap.has(resultKey(r))) resultMap.set(resultKey(r), r);
  }

  // Weighted average: both lists contribute their normalized score
  const scored: Array<{ key: string; score: number; bn?: number; vn?: number }> = [];
  for (const key of allKeys) {
    const bn = bm25Norm.get(key);
    const vn = vecNorm.get(key);
    let score: number;
    if (bn != null && vn != null) {
      score = alpha * bn + (1 - alpha) * vn;
    } else if (bn != null) {
      score = alpha * bn;
    } else {
      score = (1 - alpha) * vn!;
    }
    scored.push({ key, score, bn, vn });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => {
    const result = resultMap.get(s.key)!;
    return {
      ...result,
      score: s.score,
      keywordScore: s.bn != null ? Math.round(s.bn * 1000) / 1000 : undefined,
      semanticScore: s.vn != null ? Math.round(s.vn * 1000) / 1000 : undefined,
    };
  });
}

function resultKey(r: SearchResult): string {
  return r.taskId ?? r.path ?? r.title;
}

// ── BM25 keyword scoring — fallback when QMD task store is unavailable ──

export function bm25ScoreTasks(tasks: Task[], query: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const task of tasks) {
    let bestScore = 0;
    let matchField = '';

    const titleScore = scoreMatch(task.title, query, 3);
    if (titleScore > bestScore) { bestScore = titleScore; matchField = 'title'; }

    if (task.description) {
      const descScore = scoreMatch(task.description, query, 2.5);
      if (descScore > bestScore) { bestScore = descScore; matchField = 'description'; }
    }

    if (task.summary) {
      const sumScore = scoreMatch(task.summary, query, 2);
      if (sumScore > bestScore) { bestScore = sumScore; matchField = 'summary'; }
    }

    if (task.note) {
      const noteScore = scoreMatch(task.note, query, 1.5);
      if (noteScore > bestScore) { bestScore = noteScore; matchField = 'note'; }
    }

    const catScore = scoreMatch(task.category, query, 1);
    if (catScore > bestScore) { bestScore = catScore; matchField = 'category'; }

    const projScore = scoreMatch(task.project, query, 1);
    if (projScore > bestScore) { bestScore = projScore; matchField = 'project'; }

    if (task.tags?.length) {
      const tagsText = task.tags.join(' ');
      const tagScore = scoreMatch(tagsText, query, 2);
      if (tagScore > bestScore) { bestScore = tagScore; matchField = 'tags'; }
    }

    // Searchable IDs and links — exact-match friendly with high weight
    const idScore = scoreMatch(task.id, query, 3);
    if (idScore > bestScore) { bestScore = idScore; matchField = 'id'; }

    if (task.session_id) {
      const sessionScore = scoreMatch(task.session_id, query, 3);
      if (sessionScore > bestScore) { bestScore = sessionScore; matchField = 'session_id'; }
    }

    // Legacy session_ids array — may still hold older session IDs
    if (task.session_ids?.length) {
      const legacyText = task.session_ids.join(' ');
      const legacyScore = scoreMatch(legacyText, query, 3);
      if (legacyScore > bestScore) { bestScore = legacyScore; matchField = 'session_id'; }
    }

    if (task.external_url) {
      const extScore = scoreMatch(task.external_url, query, 2);
      if (extScore > bestScore) { bestScore = extScore; matchField = 'external_url'; }
    }

    if (bestScore > 0) {
      const snippetSource =
        matchField === 'description' ? task.description
        : matchField === 'summary' ? task.summary
        : matchField === 'note' ? task.note
        : matchField === 'tags' ? (task.tags ?? []).join(', ')
        : matchField === 'id' ? task.id
        : matchField === 'session_id' ? (task.session_id ?? (task.session_ids ?? []).join(', '))
        : matchField === 'external_url' ? task.external_url!
        : task.title;
      results.push({
        type: 'task',
        title: task.title,
        snippet: extractSnippet(snippetSource, query),
        taskId: task.id,
        parentTaskId: task.parent_task_id,
        score: bestScore,
        matchField,
      });
    }
  }
  return results;
}

// ── Main search function ──

export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 20;
  const types = options.types ?? ['task', 'memory'];

  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];

  const results: SearchResult[] = [];

  // Tasks loaded lazily — only when needed for BM25 fallback or child expansion
  let tasks: Task[] | null = null;
  async function getTasks(): Promise<Task[]> {
    if (!tasks) tasks = await listTasks();
    return tasks;
  }

  // Task search: fully delegated to QMD (BM25 + vector + reranking internally)
  if (types.includes('task')) {
    try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(normalizedQuery, ['task'], limit);
      for (const r of qmdResults) {
        results.push({
          type: 'task',
          title: r.title,
          snippet: r.snippet,
          taskId: r.taskId,
          score: r.finalScore,
          matchField: 'task',
        });
      }
    } catch (err) {
      // QMD task search failed — fall back to BM25 keyword search.
      // This should not happen in normal operation (sanitizeForVec + model mismatch
      // detection at startup prevent the known failure modes). If this fires,
      // investigate the root cause rather than relying on the fallback.
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD task search failed — falling back to BM25 keyword search', { query: normalizedQuery, error: msg });
      const allTasks = await getTasks();
      results.push(...bm25ScoreTasks(allTasks, normalizedQuery));
    }
  }

  // Session search: delegate to QMD
  if (types.includes('session')) {
    try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(normalizedQuery, ['session'], limit);
      for (const r of qmdResults) {
        results.push({
          type: 'session',
          title: r.title,
          snippet: r.snippet,
          sessionId: r.sessionId,
          score: r.finalScore,
          matchField: r.source,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD session search failed — no session results', { query: normalizedQuery, error: msg });
    }
  }

  // Memory search: delegate to QMD
  if (types.includes('memory')) {
    try {
      const { memoryNotesSearch } = await import('./memory-search.js');
      const qmdResults = await memoryNotesSearch(normalizedQuery, undefined, limit);
      for (const r of qmdResults) {
        results.push({
          type: 'memory',
          title: r.title,
          snippet: r.snippet,
          path: r.filepath,
          score: r.finalScore,
          matchField: r.source,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.warn('QMD memory search failed — no memory results', { query: normalizedQuery, error: msg });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const sliced = results.slice(0, limit);

  // Keep child task expansion for task results (lazy-loads tasks only if needed)
  if (types.includes('task')) {
    const allTasks = await getTasks();
    return expandChildTasks(sliced, allTasks);
  }
  return sliced;
}

/**
 * Auto-expand child tasks for matched parents.
 * For each parent task in results, inserts its children right after it
 * (if not already present). Children are marked with isAutoExpanded=true.
 * Accepts pre-loaded tasks to avoid redundant disk reads.
 */
export function expandChildTasks(results: SearchResult[], allTasks: Task[]): SearchResult[] {
  // Collect parent task IDs (tasks that are NOT children themselves)
  const taskResults = results.filter((r) => r.type === 'task' && !r.parentTaskId);
  if (taskResults.length === 0) return results;

  const parentFullIds = taskResults.map((r) => r.taskId!);
  const existingIds = new Set(results.filter((r) => r.taskId).map((r) => r.taskId!));

  // parent_task_id may be a prefix — resolve to full parent ID via prefix match
  const childrenByParent = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
    if (!task.parent_task_id || existingIds.has(task.id)) continue;
    // Match: task.parent_task_id is a prefix of one of our parent full IDs
    const matchedParent = parentFullIds.find((pid) => pid.startsWith(task.parent_task_id!));
    if (matchedParent) {
      const children = childrenByParent.get(matchedParent) ?? [];
      children.push(task);
      childrenByParent.set(matchedParent, children);
    }
  }

  if (childrenByParent.size === 0) return results;

  // Insert children after their parent
  const expanded: SearchResult[] = [];
  for (const result of results) {
    expanded.push(result);
    if (result.type === 'task' && result.taskId && childrenByParent.has(result.taskId)) {
      const children = childrenByParent.get(result.taskId)!;
      for (const child of children) {
        expanded.push({
          type: 'task',
          title: child.title,
          snippet: '',
          taskId: child.id,
          parentTaskId: child.parent_task_id,
          isAutoExpanded: true,
          score: result.score * 0.9,
          matchField: 'child',
        });
      }
    }
  }

  return expanded;
}

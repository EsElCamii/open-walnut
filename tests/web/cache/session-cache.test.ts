/**
 * Tests for web/src/cache/session-cache.ts
 *
 * The session cache is the core of instant session switching. It:
 *   - Maintains an LRU history cache for completed turns
 *   - Maintains a streaming state cache for in-progress turns
 *   - Registers global WS listeners that accumulate events for all tracked sessions
 *   - Handles batch-completed (turn finish) by clearing stream + bg-updating history
 *   - Handles WS reconnect by refreshing all tracked sessions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (vi.hoisted ensures these exist before vi.mock factories run) ─────

const { wsListeners, mockOnEvent, mockSendRpc, mockFetchHistory } = vi.hoisted(() => {
  const wsListeners = new Map<string, Set<(data: unknown) => void>>();
  const mockOnEvent = vi.fn((name: string, cb: (data: unknown) => void) => {
    let set = wsListeners.get(name);
    if (!set) { set = new Set(); wsListeners.set(name, set); }
    set.add(cb);
  });
  const mockSendRpc = vi.fn();
  const mockFetchHistory = vi.fn();
  return { wsListeners, mockOnEvent, mockSendRpc, mockFetchHistory };
});

vi.mock('@/api/ws', () => ({
  wsClient: { onEvent: mockOnEvent, sendRpc: mockSendRpc },
}));

vi.mock('@/api/sessions', () => ({
  fetchSessionHistory: mockFetchHistory,
}));

vi.mock('@/api/chat', () => ({
  isToolResultError: (result: string | undefined) => {
    if (!result) return false;
    return result.trimStart().startsWith('Error:');
  },
}));

vi.mock('@/utils/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import SUT after mocks are set up ───────────────────────────────────────

import {
  trackSession,
  getHistoryCache,
  setHistoryCache,
  getStreamState,
  clearStreamState,
  initStreamState,
  __resetForTesting,
  type CachedHistory,
} from '@/cache/session-cache';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Fire a WS event by name, simulating the server broadcast. */
function fireEvent(name: string, data: unknown): void {
  const cbs = wsListeners.get(name);
  if (cbs) for (const cb of cbs) cb(data);
}

function makeSid(n: number): string {
  return `sid-${String(n).padStart(4, '0')}-0000-0000-000000000000`;
}

function makeHistory(msgCount: number): CachedHistory {
  return {
    messages: Array.from({ length: msgCount }, (_, i) => ({
      role: i % 2 === 0 ? 'human' : 'assistant',
      content: `message-${i}`,
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    })),
    msgCount,
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  __resetForTesting();
  vi.clearAllMocks();
  // Default: sendRpc resolves with null (no snapshot)
  mockSendRpc.mockResolvedValue(null);
  mockFetchHistory.mockResolvedValue({ messages: [], forkBoundaryIndex: undefined });
});

afterEach(() => {
  __resetForTesting();
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: Global WS Listener Registration
// ═══════════════════════════════════════════════════════════════════════════

describe('global WS listener registration', () => {
  it('registers listeners for all required events', () => {
    const expected = [
      'session:text-delta',
      'session:tool-use',
      'session:tool-result',
      'session:system-event',
      'session:result',
      'session:error',
      'session:batch-completed',
      '_ws:reconnected',
    ];
    for (const name of expected) {
      expect(wsListeners.has(name), `listener for "${name}" should be registered`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: History Cache (LRU)
// ═══════════════════════════════════════════════════════════════════════════

describe('history cache', () => {
  it('returns undefined for unknown session', () => {
    expect(getHistoryCache('unknown-sid')).toBeUndefined();
  });

  it('roundtrip: set then get', () => {
    const data = makeHistory(5);
    setHistoryCache('sid-a', data);
    const cached = getHistoryCache('sid-a');
    expect(cached).toBeDefined();
    expect(cached!.messages).toHaveLength(5);
    expect(cached!.msgCount).toBe(5);
  });

  it('overwrites existing entry', () => {
    setHistoryCache('sid-a', makeHistory(3));
    setHistoryCache('sid-a', makeHistory(7));
    expect(getHistoryCache('sid-a')!.msgCount).toBe(7);
  });

  it('preserves forkBoundaryIndex', () => {
    setHistoryCache('sid-a', { ...makeHistory(5), forkBoundaryIndex: 2 });
    expect(getHistoryCache('sid-a')!.forkBoundaryIndex).toBe(2);
  });

  it('evicts oldest entry when exceeding MAX_CACHED (20)', () => {
    // Fill 20 entries
    for (let i = 0; i < 20; i++) {
      setHistoryCache(makeSid(i), makeHistory(i + 1));
    }
    // All 20 should be present
    for (let i = 0; i < 20; i++) {
      expect(getHistoryCache(makeSid(i)), `sid ${i} should exist`).toBeDefined();
    }
    // Add 21st — should evict the oldest (sid-0)
    setHistoryCache(makeSid(20), makeHistory(21));
    expect(getHistoryCache(makeSid(0))).toBeUndefined();
    expect(getHistoryCache(makeSid(20))).toBeDefined();
    // sid-1 through sid-20 still exist
    for (let i = 1; i <= 20; i++) {
      expect(getHistoryCache(makeSid(i)), `sid ${i} should survive`).toBeDefined();
    }
  });

  it('re-insert moves entry to end (LRU refresh)', () => {
    setHistoryCache(makeSid(0), makeHistory(1));
    setHistoryCache(makeSid(1), makeHistory(2));
    setHistoryCache(makeSid(2), makeHistory(3));
    // Re-insert sid-0 → moves it to the end
    setHistoryCache(makeSid(0), makeHistory(10));
    // Now the order is: sid-1, sid-2, sid-0
    // Fill up to 20 more to cause eviction
    for (let i = 3; i < 20; i++) {
      setHistoryCache(makeSid(i), makeHistory(i));
    }
    // 20 entries: sid-1, sid-2, sid-0, sid-3..sid-19
    // Add one more — should evict sid-1 (oldest)
    setHistoryCache(makeSid(100), makeHistory(100));
    expect(getHistoryCache(makeSid(1))).toBeUndefined();
    // sid-0 should survive (was re-inserted later)
    expect(getHistoryCache(makeSid(0))).toBeDefined();
    expect(getHistoryCache(makeSid(0))!.msgCount).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: Stream State Cache
// ═══════════════════════════════════════════════════════════════════════════

describe('stream state', () => {
  it('returns undefined for unknown session', () => {
    expect(getStreamState('unknown')).toBeUndefined();
  });

  it('initStreamState seeds from server snapshot', () => {
    const blocks = [
      { type: 'text' as const, content: 'hello world' },
      { type: 'tool_call' as const, toolUseId: 'tu-1', name: 'Read', status: 'done' as const },
    ];
    initStreamState('sid-x', blocks, true);
    const state = getStreamState('sid-x');
    expect(state).toBeDefined();
    expect(state!.blocks).toHaveLength(2);
    expect(state!.isStreaming).toBe(true);
    // textBuffer should be the content of the last text block
    expect(state!.textBuffer).toBe('hello world');
  });

  it('initStreamState with no text blocks → empty textBuffer', () => {
    initStreamState('sid-x', [{ type: 'tool_call' as const, toolUseId: 'tu-1', name: 'Read', status: 'done' as const }], false);
    expect(getStreamState('sid-x')!.textBuffer).toBe('');
  });

  it('initStreamState deep-copies blocks', () => {
    const original = [{ type: 'text' as const, content: 'original' }];
    initStreamState('sid-x', original, false);
    // Mutate original — should not affect cache
    original[0] = { type: 'text', content: 'mutated' };
    expect(getStreamState('sid-x')!.blocks[0]).toEqual({ type: 'text', content: 'original' });
  });

  it('clearStreamState removes state', () => {
    initStreamState('sid-x', [], true);
    expect(getStreamState('sid-x')).toBeDefined();
    clearStreamState('sid-x');
    expect(getStreamState('sid-x')).toBeUndefined();
  });

  it('clearStreamState on nonexistent session is no-op', () => {
    expect(() => clearStreamState('nonexistent')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: trackSession
// ═══════════════════════════════════════════════════════════════════════════

describe('trackSession', () => {
  it('tracked session receives WS events, untracked does not', () => {
    trackSession('tracked');
    // Do NOT track 'untracked'
    fireEvent('session:text-delta', { sessionId: 'tracked', delta: 'hello' });
    fireEvent('session:text-delta', { sessionId: 'untracked', delta: 'world' });
    expect(getStreamState('tracked')).toBeDefined();
    expect(getStreamState('untracked')).toBeUndefined();
  });

  it('evicts oldest tracked session when exceeding MAX_CACHED', () => {
    // Track 20 sessions
    for (let i = 0; i < 20; i++) {
      trackSession(makeSid(i));
      setHistoryCache(makeSid(i), makeHistory(1));
      initStreamState(makeSid(i), [], false);
    }
    // Track 21st — should evict sid-0
    trackSession(makeSid(20));
    // sid-0's data should be cleaned up
    expect(getHistoryCache(makeSid(0))).toBeUndefined();
    expect(getStreamState(makeSid(0))).toBeUndefined();
    // sid-1 and sid-20 should exist
    expect(getHistoryCache(makeSid(1))).toBeDefined();
    expect(getStreamState(makeSid(20))).toBeUndefined(); // not initialized, but tracked
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: WS Event Handlers — text-delta
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:text-delta', () => {
  it('accumulates text into a text block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'Hello' });
    fireEvent('session:text-delta', { sessionId: 'sid', delta: ' World' });

    const state = getStreamState('sid')!;
    expect(state.isStreaming).toBe(true);
    expect(state.textBuffer).toBe('Hello World');
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'Hello World' });
  });

  it('ignores events for untracked sessions', () => {
    fireEvent('session:text-delta', { sessionId: 'unknown', delta: 'test' });
    expect(getStreamState('unknown')).toBeUndefined();
  });

  it('ignores events with no sessionId', () => {
    fireEvent('session:text-delta', { delta: 'test' });
    // Should not throw or create phantom entries
  });

  it('creates state on first event (ensureState)', () => {
    trackSession('new-sid');
    expect(getStreamState('new-sid')).toBeUndefined();
    fireEvent('session:text-delta', { sessionId: 'new-sid', delta: 'hi' });
    expect(getStreamState('new-sid')).toBeDefined();
    expect(getStreamState('new-sid')!.blocks).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: WS Event Handlers — tool-use
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:tool-use', () => {
  it('flushes text and adds tool_call block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'thinking...' });
    fireEvent('session:tool-use', {
      sessionId: 'sid', toolName: 'Read', toolUseId: 'tu-1',
      input: { file_path: '/foo' },
    });

    const state = getStreamState('sid')!;
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'thinking...' });
    expect(state.blocks[1]).toMatchObject({
      type: 'tool_call', toolUseId: 'tu-1', name: 'Read', status: 'calling',
    });
    // textBuffer should be reset after tool-use
    expect(state.textBuffer).toBe('');
  });

  it('includes planContent and parentToolUseId when present', () => {
    trackSession('sid');
    fireEvent('session:tool-use', {
      sessionId: 'sid', toolName: 'EnterPlanMode', toolUseId: 'tu-2',
      planContent: '## Plan\n...', parentToolUseId: 'tu-parent',
    });

    const block = getStreamState('sid')!.blocks[0] as any;
    expect(block.planContent).toBe('## Plan\n...');
    expect(block.parentToolUseId).toBe('tu-parent');
  });

  it('omits planContent and parentToolUseId when absent', () => {
    trackSession('sid');
    fireEvent('session:tool-use', {
      sessionId: 'sid', toolName: 'Bash', toolUseId: 'tu-3',
    });

    const block = getStreamState('sid')!.blocks[0] as any;
    expect(block.planContent).toBeUndefined();
    expect(block.parentToolUseId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: WS Event Handlers — tool-result
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:tool-result', () => {
  it('updates tool_call status to done', () => {
    trackSession('sid');
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Read', toolUseId: 'tu-1' });
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-1', result: 'file contents here' });

    const block = getStreamState('sid')!.blocks[0] as any;
    expect(block.status).toBe('done');
    expect(block.result).toBe('file contents here');
  });

  it('updates tool_call status to error when result starts with Error:', () => {
    trackSession('sid');
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Bash', toolUseId: 'tu-2' });
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-2', result: 'Error: command failed' });

    const block = getStreamState('sid')!.blocks[0] as any;
    expect(block.status).toBe('error');
  });

  it('finds the correct block when multiple tool calls exist', () => {
    trackSession('sid');
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Read', toolUseId: 'tu-1' });
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Bash', toolUseId: 'tu-2' });
    // Complete tu-2 first (out of order)
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-2', result: 'ok' });

    const blocks = getStreamState('sid')!.blocks;
    expect((blocks[0] as any).status).toBe('calling'); // tu-1 still calling
    expect((blocks[1] as any).status).toBe('done');    // tu-2 done
  });

  it('no-op when toolUseId not found', () => {
    trackSession('sid');
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Read', toolUseId: 'tu-1' });
    // Wrong ID — should not throw or modify anything
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-nonexistent', result: 'ok' });

    expect((getStreamState('sid')!.blocks[0] as any).status).toBe('calling');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: WS Event Handlers — system-event
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:system-event', () => {
  it('flushes text and adds system block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'partial text' });
    fireEvent('session:system-event', {
      sessionId: 'sid', variant: 'compact', message: 'Context compacted', detail: '50% reduction',
    });

    const state = getStreamState('sid')!;
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'partial text' });
    expect(state.blocks[1]).toEqual({
      type: 'system', variant: 'compact', message: 'Context compacted', detail: '50% reduction',
    });
    expect(state.textBuffer).toBe('');
  });

  it('adds error variant system block', () => {
    trackSession('sid');
    fireEvent('session:system-event', {
      sessionId: 'sid', variant: 'error', message: 'API error',
    });
    expect((getStreamState('sid')!.blocks[0] as any).variant).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: WS Event Handlers — result (streaming done)
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:result', () => {
  it('marks isStreaming false and clears textBuffer', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'response text' });
    expect(getStreamState('sid')!.isStreaming).toBe(true);

    fireEvent('session:result', { sessionId: 'sid' });
    const state = getStreamState('sid')!;
    expect(state.isStreaming).toBe(false);
    expect(state.textBuffer).toBe('');
    // Blocks are preserved (not cleared — that happens on batch-completed)
    expect(state.blocks).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10: WS Event Handlers — error
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:error', () => {
  it('marks isStreaming false and adds error system block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'partial' });
    fireEvent('session:error', { sessionId: 'sid', error: 'Connection timeout' });

    const state = getStreamState('sid')!;
    expect(state.isStreaming).toBe(false);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]).toEqual({
      type: 'system', variant: 'error', message: 'Session error', detail: 'Connection timeout',
    });
  });

  it('truncates long error messages to 500 chars', () => {
    trackSession('sid');
    const longError = 'x'.repeat(600);
    fireEvent('session:error', { sessionId: 'sid', error: longError });

    const block = getStreamState('sid')!.blocks[0] as any;
    expect(block.detail.length).toBe(501); // 500 + '…'
    expect(block.detail).toMatch(/\u2026$/);
  });

  it('no error block when error is undefined', () => {
    trackSession('sid');
    fireEvent('session:error', { sessionId: 'sid' });
    // Still marks streaming false, but no system block
    expect(getStreamState('sid')!.isStreaming).toBe(false);
    expect(getStreamState('sid')!.blocks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11: WS Event Handlers — batch-completed
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: session:batch-completed', () => {
  it('clears stream state', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'text' });
    expect(getStreamState('sid')).toBeDefined();

    fireEvent('session:batch-completed', { sessionId: 'sid' });
    expect(getStreamState('sid')).toBeUndefined();
  });

  it('triggers background history fetch', async () => {
    trackSession('sid');
    mockFetchHistory.mockResolvedValue({
      messages: [{ role: 'human', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      forkBoundaryIndex: undefined,
    });

    fireEvent('session:batch-completed', { sessionId: 'sid' });
    expect(mockFetchHistory).toHaveBeenCalledWith('sid');

    // Wait for async fetch to complete
    await vi.waitFor(() => {
      const cached = getHistoryCache('sid');
      expect(cached).toBeDefined();
      expect(cached!.msgCount).toBe(2);
    });
  });

  it('ignores untracked sessions', () => {
    fireEvent('session:batch-completed', { sessionId: 'untracked' });
    expect(mockFetchHistory).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent fetches for same session', () => {
    trackSession('sid');
    // Make fetch hang (never resolves)
    mockFetchHistory.mockReturnValue(new Promise(() => {}));

    fireEvent('session:batch-completed', { sessionId: 'sid' });
    fireEvent('session:batch-completed', { sessionId: 'sid' });

    // Only one fetch should be made
    expect(mockFetchHistory).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12: WS Event Handlers — _ws:reconnected
// ═══════════════════════════════════════════════════════════════════════════

describe('WS: _ws:reconnected', () => {
  it('re-subscribes all tracked sessions via sendRpc', () => {
    trackSession('sid-a');
    trackSession('sid-b');

    fireEvent('_ws:reconnected', {});

    expect(mockSendRpc).toHaveBeenCalledWith('session:stream-subscribe', { sessionId: 'sid-a' });
    expect(mockSendRpc).toHaveBeenCalledWith('session:stream-subscribe', { sessionId: 'sid-b' });
  });

  it('fetches history for all tracked sessions', () => {
    trackSession('sid-a');
    trackSession('sid-b');

    fireEvent('_ws:reconnected', {});

    expect(mockFetchHistory).toHaveBeenCalledWith('sid-a');
    expect(mockFetchHistory).toHaveBeenCalledWith('sid-b');
  });

  it('updates stream state from server snapshot', async () => {
    trackSession('sid-a');
    const snapshot = {
      blocks: [{ type: 'text' as const, content: 'recovered text' }],
      isStreaming: true,
    };
    mockSendRpc.mockResolvedValue(snapshot);

    fireEvent('_ws:reconnected', {});

    await vi.waitFor(() => {
      const state = getStreamState('sid-a');
      expect(state).toBeDefined();
      expect(state!.blocks[0]).toEqual({ type: 'text', content: 'recovered text' });
      expect(state!.isStreaming).toBe(true);
    });
  });

  it('no-op when no sessions are tracked', () => {
    fireEvent('_ws:reconnected', {});
    expect(mockSendRpc).not.toHaveBeenCalled();
    expect(mockFetchHistory).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13: Full Streaming Turn — Integration Scenario
// ═══════════════════════════════════════════════════════════════════════════

describe('full streaming turn integration', () => {
  it('text → tool-use → tool-result → text → result → batch-completed', async () => {
    const sid = 'session-full-turn';
    trackSession(sid);
    mockFetchHistory.mockResolvedValue({
      messages: [
        { role: 'human', content: 'fix the bug' },
        { role: 'assistant', content: 'I will read the file.' },
      ],
      forkBoundaryIndex: undefined,
    });

    // Step 1: Text delta
    fireEvent('session:text-delta', { sessionId: sid, delta: 'Let me ' });
    fireEvent('session:text-delta', { sessionId: sid, delta: 'read the file.' });
    let state = getStreamState(sid)!;
    expect(state.isStreaming).toBe(true);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toEqual({ type: 'text', content: 'Let me read the file.' });

    // Step 2: Tool use
    fireEvent('session:tool-use', {
      sessionId: sid, toolName: 'Read', toolUseId: 'tu-abc',
      input: { file_path: '/src/bug.ts' },
    });
    state = getStreamState(sid)!;
    expect(state.blocks).toHaveLength(2);
    expect((state.blocks[1] as any).name).toBe('Read');
    expect((state.blocks[1] as any).status).toBe('calling');

    // Step 3: Tool result
    fireEvent('session:tool-result', { sessionId: sid, toolUseId: 'tu-abc', result: 'const x = 1;' });
    state = getStreamState(sid)!;
    expect((state.blocks[1] as any).status).toBe('done');
    expect((state.blocks[1] as any).result).toBe('const x = 1;');

    // Step 4: More text
    fireEvent('session:text-delta', { sessionId: sid, delta: 'I found the bug.' });
    state = getStreamState(sid)!;
    expect(state.blocks).toHaveLength(3);
    expect(state.blocks[2]).toEqual({ type: 'text', content: 'I found the bug.' });

    // Step 5: Result (streaming done)
    fireEvent('session:result', { sessionId: sid });
    state = getStreamState(sid)!;
    expect(state.isStreaming).toBe(false);
    expect(state.blocks).toHaveLength(3); // blocks preserved

    // Step 6: Batch completed (turn written to JSONL)
    fireEvent('session:batch-completed', { sessionId: sid });
    expect(getStreamState(sid)).toBeUndefined(); // stream state cleared

    // Wait for background history fetch
    await vi.waitFor(() => {
      const cached = getHistoryCache(sid);
      expect(cached).toBeDefined();
      expect(cached!.msgCount).toBe(2);
    });
  });

  it('multiple turns in sequence', async () => {
    const sid = 'session-multi-turn';
    trackSession(sid);

    let turnCount = 0;
    mockFetchHistory.mockImplementation(() => {
      turnCount++;
      return Promise.resolve({
        messages: Array.from({ length: turnCount * 2 }, (_, i) => ({
          role: i % 2 === 0 ? 'human' : 'assistant',
          content: `msg-${i}`,
        })),
        forkBoundaryIndex: undefined,
      });
    });

    // Turn 1
    fireEvent('session:text-delta', { sessionId: sid, delta: 'turn 1' });
    fireEvent('session:result', { sessionId: sid });
    fireEvent('session:batch-completed', { sessionId: sid });

    await vi.waitFor(() => {
      expect(getHistoryCache(sid)?.msgCount).toBe(2);
    });

    // Turn 2 — stream state was cleared, new one created
    fireEvent('session:text-delta', { sessionId: sid, delta: 'turn 2' });
    expect(getStreamState(sid)!.blocks[0]).toEqual({ type: 'text', content: 'turn 2' });

    fireEvent('session:result', { sessionId: sid });
    fireEvent('session:batch-completed', { sessionId: sid });

    await vi.waitFor(() => {
      expect(getHistoryCache(sid)?.msgCount).toBe(4); // 2 turns * 2 messages
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14: Multiple Sessions — Isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('multiple session isolation', () => {
  it('events for different sessions accumulate independently', () => {
    trackSession('sid-a');
    trackSession('sid-b');

    fireEvent('session:text-delta', { sessionId: 'sid-a', delta: 'hello from A' });
    fireEvent('session:text-delta', { sessionId: 'sid-b', delta: 'hello from B' });
    fireEvent('session:tool-use', { sessionId: 'sid-a', toolName: 'Read', toolUseId: 'a-tu' });

    const stateA = getStreamState('sid-a')!;
    const stateB = getStreamState('sid-b')!;

    expect(stateA.blocks).toHaveLength(2); // text + tool
    expect(stateB.blocks).toHaveLength(1); // text only
    expect(stateA.blocks[0]).toEqual({ type: 'text', content: 'hello from A' });
    expect(stateB.blocks[0]).toEqual({ type: 'text', content: 'hello from B' });
  });

  it('batch-completed for one session does not affect another', async () => {
    trackSession('sid-a');
    trackSession('sid-b');

    fireEvent('session:text-delta', { sessionId: 'sid-a', delta: 'A streaming' });
    fireEvent('session:text-delta', { sessionId: 'sid-b', delta: 'B streaming' });

    mockFetchHistory.mockResolvedValue({ messages: [{ role: 'assistant', content: 'done' }] });

    // Only A completes
    fireEvent('session:batch-completed', { sessionId: 'sid-a' });

    expect(getStreamState('sid-a')).toBeUndefined(); // cleared
    expect(getStreamState('sid-b')).toBeDefined();    // untouched
    expect(getStreamState('sid-b')!.blocks[0]).toEqual({ type: 'text', content: 'B streaming' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 15: Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('text-delta after tool-use starts new text block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'before' });
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Bash', toolUseId: 'tu' });
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'after' });

    const blocks = getStreamState('sid')!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', content: 'before' });
    expect((blocks[1] as any).type).toBe('tool_call');
    expect(blocks[2]).toEqual({ type: 'text', content: 'after' });
  });

  it('text-delta after system-event starts new text block', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'before' });
    fireEvent('session:system-event', { sessionId: 'sid', variant: 'info', message: 'note' });
    fireEvent('session:text-delta', { sessionId: 'sid', delta: 'after' });

    const blocks = getStreamState('sid')!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', content: 'before' });
    expect((blocks[1] as any).type).toBe('system');
    expect(blocks[2]).toEqual({ type: 'text', content: 'after' });
  });

  it('empty delta string is handled', () => {
    trackSession('sid');
    fireEvent('session:text-delta', { sessionId: 'sid', delta: '' });
    // Empty delta — should create state but textBuffer is empty
    const state = getStreamState('sid')!;
    expect(state.textBuffer).toBe('');
  });

  it('result without any prior events is handled', () => {
    trackSession('sid');
    fireEvent('session:result', { sessionId: 'sid' });
    const state = getStreamState('sid')!;
    expect(state.isStreaming).toBe(false);
    expect(state.blocks).toHaveLength(0);
  });

  it('batch-completed without prior streaming is handled', async () => {
    trackSession('sid');
    mockFetchHistory.mockResolvedValue({ messages: [], forkBoundaryIndex: undefined });

    fireEvent('session:batch-completed', { sessionId: 'sid' });
    // No stream state to clear — just fires fetch
    expect(mockFetchHistory).toHaveBeenCalledWith('sid');
  });

  it('rapid tool-use back-to-back (concurrent tools)', () => {
    trackSession('sid');
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Read', toolUseId: 'tu-1' });
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Grep', toolUseId: 'tu-2' });
    fireEvent('session:tool-use', { sessionId: 'sid', toolName: 'Glob', toolUseId: 'tu-3' });

    let state = getStreamState('sid')!;
    expect(state.blocks).toHaveLength(3);
    expect(state.blocks.map((b: any) => b.name)).toEqual(['Read', 'Grep', 'Glob']);
    expect(state.blocks.every((b: any) => b.status === 'calling')).toBe(true);

    // Complete out of order
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-3', result: 'ok' });
    fireEvent('session:tool-result', { sessionId: 'sid', toolUseId: 'tu-1', result: 'ok' });

    // tool-result creates new block objects via spread, so re-read from cache
    state = getStreamState('sid')!;
    expect((state.blocks[0] as any).status).toBe('done');   // tu-1 completed
    expect((state.blocks[1] as any).status).toBe('calling'); // tu-2 still pending
    expect((state.blocks[2] as any).status).toBe('done');   // tu-3 completed
  });
});

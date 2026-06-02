/**
 * Unit tests for session-content-indexer (src/core/session-content-indexer.ts).
 * Covers code-block collapsing, tool/thinking filtering, blob stripping,
 * size cap (tail-keep), turn headings, and empty input.
 */
import { describe, it, expect } from 'vitest';
import { buildIndexedContent } from '../../src/core/session-content-indexer.js';
import type { SessionHistoryMessage } from '../../src/core/session-history.js';

function msg(partial: Partial<SessionHistoryMessage> & { role: 'user' | 'assistant' }): SessionHistoryMessage {
  return { text: '', timestamp: '2026-05-05T10:00:00.000Z', ...partial };
}

describe('buildIndexedContent', () => {
  it('returns empty body for no messages', () => {
    const out = buildIndexedContent([]);
    expect(out.body).toBe('');
    expect(out.turnCount).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('injects a ## Turn heading per kept turn with short timestamp', () => {
    const out = buildIndexedContent([
      msg({ role: 'user', text: 'hello' }),
      msg({ role: 'assistant', text: 'hi there', timestamp: '2026-05-05T10:02:00.000Z' }),
    ]);
    expect(out.turnCount).toBe(2);
    expect(out.body).toContain('## Turn 1 (2026-05-05 10:00)');
    expect(out.body).toContain('## Turn 2 (2026-05-05 10:02)');
    expect(out.body).toContain('User: hello');
    expect(out.body).toContain('Assistant: hi there');
  });

  it('collapses code blocks longer than the threshold', () => {
    const bigCode = '```ts\n' + Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```';
    const out = buildIndexedContent([msg({ role: 'assistant', text: `Here is code:\n${bigCode}` })]);
    expect(out.body).toContain('lines omitted>');
    expect(out.body).toContain('lang=ts');
    expect(out.body).not.toContain('const x15 = 15;');
  });

  it('keeps small code blocks intact', () => {
    const smallCode = '```js\nconst a = 1;\nconst b = 2;\n```';
    const out = buildIndexedContent([msg({ role: 'assistant', text: smallCode })]);
    expect(out.body).toContain('const a = 1;');
    expect(out.body).not.toContain('lines omitted>');
  });

  it('drops tool inputs/results but keeps a deduped tool-name footer', () => {
    const out = buildIndexedContent([
      msg({
        role: 'assistant',
        text: 'Let me check that file.',
        tools: [
          { name: 'Bash', input: { command: 'cat /etc/passwd' }, result: 'root:x:0:0:secret' },
          { name: 'Read', input: { file_path: '/foo' }, result: 'file contents here' },
          { name: 'Bash', input: { command: 'ls' } },
        ],
      }),
    ]);
    expect(out.body).toContain('Tools: Bash, Read');
    expect(out.body).not.toContain('/etc/passwd');
    expect(out.body).not.toContain('root:x:0:0');
    expect(out.body).not.toContain('file contents here');
  });

  it('does not index thinking content', () => {
    const out = buildIndexedContent([
      msg({ role: 'assistant', text: 'visible answer', thinking: 'secret chain of thought reasoning' }),
    ]);
    expect(out.body).toContain('visible answer');
    expect(out.body).not.toContain('secret chain of thought');
  });

  it('strips base64 data URIs and long blobs', () => {
    const b64 = 'data:image/png;base64,' + 'A'.repeat(2000);
    const blob = 'Z'.repeat(800);
    const out = buildIndexedContent([msg({ role: 'user', text: `image ${b64} and ${blob} end` })]);
    expect(out.body).toContain('<blob omitted>');
    expect(out.body).not.toContain('AAAA');
    expect(out.body).not.toContain('ZZZZ');
  });

  it('skips turns with neither text nor tools', () => {
    const out = buildIndexedContent([
      msg({ role: 'user', text: '' }),
      msg({ role: 'assistant', text: 'real reply' }),
    ]);
    expect(out.turnCount).toBe(1);
    expect(out.body).toContain('## Turn 1');
    expect(out.body).not.toContain('## Turn 2');
  });

  it('truncates a single oversized turn mid-text', () => {
    const huge = 'word '.repeat(2_000); // spaced text — not caught by blob stripper
    const out = buildIndexedContent([msg({ role: 'user', text: huge })], { maxCharsPerTurn: 100 });
    expect(out.body).toContain('... [truncated]');
    expect(out.body.length).toBeLessThan(1_000);
  });

  it('enforces maxBytes via tail-keep, dropping oldest turns', () => {
    const turns: SessionHistoryMessage[] = [];
    for (let i = 0; i < 50; i++) {
      turns.push(msg({ role: 'user', text: `turn ${i} ` + 'word '.repeat(200) }));
    }
    const out = buildIndexedContent(turns, { maxBytes: 5_000 });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.body)).toBeLessThanOrEqual(5_000 + 100);
    expect(out.body).toContain('[...earlier turns omitted]');
    // Oldest turn dropped, newest retained
    expect(out.body).not.toContain('turn 0 ');
    expect(out.body).toContain('turn 49 ');
  });

  it('does not mark truncated when under cap', () => {
    const out = buildIndexedContent([msg({ role: 'user', text: 'short' })], { maxBytes: 50_000 });
    expect(out.truncated).toBe(false);
    expect(out.body).not.toContain('earlier turns omitted');
  });
});

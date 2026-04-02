/**
 * Unit test: SubagentPoller — local JSONL file polling with multi-file discovery.
 *
 * Tests:
 * B9.  pollLocalFile — reads new lines from offset, returns correct newOffset
 * B10. pollLocalFile — file does not exist, returns empty + original offset
 * B11. readFullFile — reads complete JSONL, parses all lines
 * B12. Multi-file poll — discovers new inbox delivery files
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mock constants → tmpdir ──
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('poller-test'));

// ── Imports (after mocks) ──
import { CLAUDE_HOME } from '../../src/constants.js';
import {
  readFullFile,
  parseJsonlLines,
  ActiveTabPoller,
} from '../../src/providers/subagent-poller.js';
import type { ParsedJsonlEvent } from '../../src/providers/subagent-poller.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';

// ── Helpers ──

let tmpDir: string;

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function systemInit(sessionId: string): string {
  return jsonlLine({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-4-6' });
}

function assistantText(text: string): string {
  return jsonlLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
}

function assistantToolUse(name: string, id: string, input: Record<string, unknown>): string {
  return jsonlLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
  });
}

function userToolResult(toolUseId: string, content: string): string {
  return jsonlLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

function userMessage(text: string): string {
  return jsonlLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `poller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ── Access pollLocalFile via internal import trick ──
// pollLocalFile is NOT exported, so we test it indirectly through ActiveTabPoller and readFullFile.
// However, we can test the core behavior: reading from byte offset.

describe('B. subagent-poller.ts', () => {
  describe('readFullFile + parseJsonlLines', () => {
    it('B9+B11. reads complete JSONL, parses all event types correctly', async () => {
      const filePath = path.join(tmpDir, 'test.jsonl');
      const content = [
        systemInit('test-session'),
        userMessage('Hello'),
        assistantText('World'),
        assistantToolUse('Read', 'tool-1', { file_path: '/tmp/test.ts' }),
        userToolResult('tool-1', 'file contents here'),
      ].join('\n') + '\n';

      await fs.writeFile(filePath, content);

      const { lines, offset } = readFullFile(filePath);
      expect(lines).toHaveLength(5);
      expect(offset).toBe(Buffer.byteLength(content));

      const events = parseJsonlLines(lines);

      // System event
      const sysEvents = events.filter(e => e.type === 'system');
      expect(sysEvents).toHaveLength(1);
      expect(sysEvents[0].subtype).toBe('init');
      expect(sysEvents[0].model).toBe('claude-opus-4-6');

      // Text event
      const textEvents = events.filter(e => e.type === 'text');
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].text).toBe('World');

      // Tool use event
      const toolUseEvents = events.filter(e => e.type === 'tool_use');
      expect(toolUseEvents).toHaveLength(1);
      expect(toolUseEvents[0].toolName).toBe('Read');
      expect(toolUseEvents[0].toolUseId).toBe('tool-1');
      expect(toolUseEvents[0].input).toEqual({ file_path: '/tmp/test.ts' });

      // Tool result event
      const toolResultEvents = events.filter(e => e.type === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].toolUseId).toBe('tool-1');
      expect(toolResultEvents[0].result).toBe('file contents here');
    });

    it('B10. readFullFile returns empty for non-existent file', () => {
      const { lines, offset } = readFullFile(path.join(tmpDir, 'nonexistent.jsonl'));
      expect(lines).toHaveLength(0);
      expect(offset).toBe(0);
    });
  });

  describe('parseJsonlLines edge cases', () => {
    it('skips malformed JSON lines gracefully', () => {
      const lines = [
        '{"type":"system","subtype":"init"}',
        '{ this is not valid json',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      ];

      const events = parseJsonlLines(lines);
      // Should parse 2 events (system + text), skip the malformed one
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('system');
      expect(events[1].type).toBe('text');
      expect(events[1].text).toBe('ok');
    });

    it('handles empty lines array', () => {
      const events = parseJsonlLines([]);
      expect(events).toHaveLength(0);
    });
  });

  describe('ActiveTabPoller', () => {
    it('B12. discovers new files when inbox delivery creates additional JSONL', async () => {
      // Setup: create a subagent directory structure
      const sessionId = 'poller-multi-test';
      const cwd = '/home/user/test-project';
      const encoded = encodeProjectPath(cwd);
      const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, sessionId, 'subagents');
      await fs.mkdir(subagentDir, { recursive: true });

      // Write initial agent file
      const mainContent = [
        jsonlLine({ type: 'system', subtype: 'init', session_id: 'agent-main', uuid: 'uuid-m1' }),
        jsonlLine({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '<teammate-message from="worker">\nDo the work\n</teammate-message>' }] },
        }),
        jsonlLine({
          type: 'assistant', uuid: 'uuid-m2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working...' }] },
        }),
      ].join('\n') + '\n';

      const mainPath = path.join(subagentDir, 'agent-main.jsonl');
      await fs.writeFile(mainPath, mainContent);

      // Collect events from poller
      const receivedEvents: Array<{ agent: string; events: ParsedJsonlEvent[] }> = [];
      const poller = new ActiveTabPoller((agent, events) => {
        receivedEvents.push({ agent, events });
      });

      // Subscribe with just the main file
      poller.subscribe('worker', {
        filePaths: [mainPath],
        discovery: {
          sessionId,
          cwd,
          agentName: 'worker',
          mainJsonlPath: mainPath,
        },
      });

      // Append new data to the main file (simulates ongoing agent activity)
      const newData = assistantText('Found something interesting!') + '\n';
      await fs.appendFile(mainPath, newData);

      // Wait for a poll cycle (2s + small margin)
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Should have received the new text event
      expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
      const allTextEvents = receivedEvents
        .flatMap(r => r.events)
        .filter(e => e.type === 'text');
      expect(allTextEvents.some(e => e.text === 'Found something interesting!')).toBe(true);

      // Now simulate inbox delivery: create a new JSONL file with parentUuid
      const inboxContent = [
        jsonlLine({ type: 'system', subtype: 'init', session_id: 'inbox-1', uuid: 'uuid-i1', parentUuid: 'uuid-m2' }),
        jsonlLine({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'New inbox message' }] },
        }),
        jsonlLine({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Processing inbox delivery' }] },
        }),
      ].join('\n') + '\n';

      const inboxPath = path.join(subagentDir, 'agent-inbox.jsonl');
      await fs.writeFile(inboxPath, inboxContent);

      // Wait for discovery interval (every 5 polls * 2s = 10s, give it 12s)
      await new Promise(resolve => setTimeout(resolve, 12000));

      // Should have discovered and read the inbox file
      const inboxTextEvents = receivedEvents
        .flatMap(r => r.events)
        .filter(e => e.type === 'text' && e.text === 'Processing inbox delivery');
      expect(inboxTextEvents.length).toBeGreaterThanOrEqual(1);

      poller.destroy();
    }, 20000);

    it('subscribe stops previous polling and tracks new agent', async () => {
      const poller = new ActiveTabPoller(() => {});

      // Create two temp files
      const file1 = path.join(tmpDir, 'agent-1.jsonl');
      const file2 = path.join(tmpDir, 'agent-2.jsonl');
      await fs.writeFile(file1, systemInit('s1') + '\n');
      await fs.writeFile(file2, systemInit('s2') + '\n');

      // Subscribe to agent-1
      poller.subscribe('agent-1', { filePaths: [file1] });
      expect(poller.activeAgent).toBe('agent-1');

      // Subscribe to agent-2 (should stop agent-1)
      poller.subscribe('agent-2', { filePaths: [file2] });
      expect(poller.activeAgent).toBe('agent-2');

      poller.destroy();
      expect(poller.activeAgent).toBeNull();
    });

    it('stop clears all state', async () => {
      const poller = new ActiveTabPoller(() => {});
      const file = path.join(tmpDir, 'agent.jsonl');
      await fs.writeFile(file, systemInit('s1') + '\n');

      poller.subscribe('test-agent', { filePaths: [file] });
      expect(poller.activeAgent).toBe('test-agent');

      poller.stop();
      expect(poller.activeAgent).toBeNull();

      poller.destroy();
    });
  });
});

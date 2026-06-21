/**
 * Tests for the side-question ("/btw") persistence store.
 * Verifies add/list/get/promote-mark/delete round-trips and per-session isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import {
  addSideQuestion,
  listSideQuestions,
  getSideQuestion,
  markPromoted,
  deleteSideQuestion,
} from '../../src/core/side-questions.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

describe('side-questions store', () => {
  it('adds and lists a side question for a session', async () => {
    const entry = await addSideQuestion('sess-1', 'what is hasPipe?', 'a FIFO flag');
    expect(entry.id.startsWith('bsq-')).toBe(true);
    expect(entry.question).toBe('what is hasPipe?');
    expect(entry.answer).toBe('a FIFO flag');

    const list = await listSideQuestions('sess-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);
  });

  it('isolates side questions per session', async () => {
    await addSideQuestion('sess-a', 'qA', 'aA');
    await addSideQuestion('sess-b', 'qB', 'aB');
    expect(await listSideQuestions('sess-a')).toHaveLength(1);
    expect((await listSideQuestions('sess-b'))[0]!.question).toBe('qB');
  });

  it('preserves order across multiple adds', async () => {
    await addSideQuestion('s', 'first', '1');
    await addSideQuestion('s', 'second', '2');
    const list = await listSideQuestions('s');
    expect(list.map((q) => q.question)).toEqual(['first', 'second']);
  });

  it('marks an entry as promoted', async () => {
    const e = await addSideQuestion('s', 'q', 'a');
    await markPromoted('s', e.id, 'task-123');
    const got = await getSideQuestion('s', e.id);
    expect(got?.promotedTaskId).toBe('task-123');
  });

  it('deletes an entry', async () => {
    const e = await addSideQuestion('s', 'q', 'a');
    expect(await deleteSideQuestion('s', e.id)).toBe(true);
    expect(await listSideQuestions('s')).toHaveLength(0);
    // Deleting again returns false (already gone).
    expect(await deleteSideQuestion('s', e.id)).toBe(false);
  });

  it('returns empty list for an unknown session', async () => {
    expect(await listSideQuestions('never-existed')).toEqual([]);
  });
});

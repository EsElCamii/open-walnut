/**
 * Fix #2 — near-duplicate task dedup safety net in addTask().
 *
 * Background: a context-trimmed triage turn re-called task_create with a
 * slightly-reworded title, breeding ~17 near-identical "CIS FE re-query …"
 * tasks under one parent within minutes. addTask() now collapses a same-scope,
 * near-identical, recently-created active task onto the existing one.
 *
 * These titles are the real reworded variants observed in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, listTasks, completeTask, updateTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// The real reworded variants that bred in production (same parent, minutes apart).
const CIS_VARIANTS = [
  'CIS FE re-query — DescribeClusterInsight unique accounts (IAD), plan first',
  'CIS FE — unique account of DescribeClusterInsight (IAD) — re-query plan',
  'CIS FE re-query — unique accounts of DescribeClusterInsight in IAD (plan first)',
  'CIS FE unique-account re-query — DescribeClusterInsight unique accounts (IAD)',
  'CIS FE re-query — unique accounts calling DescribeClusterInsight in IAD (plan first)',
];

describe('addTask near-duplicate dedup', () => {
  it('collapses reworded same-parent variants onto the first task', async () => {
    const { task: parent } = await addTask({ title: 'CIS umbrella', category: 'Work', project: 'EKS' });

    const { task: first } = await addTask({ title: CIS_VARIANTS[0], parent_task_id: parent.id });

    // Every reworded variant should return the SAME canonical task id, not a new one.
    for (const variant of CIS_VARIANTS.slice(1)) {
      const { task } = await addTask({ title: variant, parent_task_id: parent.id });
      expect(task.id).toBe(first.id);
    }

    // Only parent + the single canonical child exist.
    const children = (await listTasks()).filter((t) => t.parent_task_id === parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(first.id);
  });

  it('does NOT dedup genuinely different titles under the same parent', async () => {
    const { task: parent } = await addTask({ title: 'Umbrella', category: 'Work', project: 'EKS' });

    const { task: a } = await addTask({ title: 'CIS FE re-query DescribeClusterInsight accounts IAD', parent_task_id: parent.id });
    const { task: b } = await addTask({ title: 'CIS BE deploy pipeline wave 7 rollback', parent_task_id: parent.id });

    expect(b.id).not.toBe(a.id);
    const children = (await listTasks()).filter((t) => t.parent_task_id === parent.id);
    expect(children).toHaveLength(2);
  });

  it('does NOT dedup similar titles under DIFFERENT parents', async () => {
    const { task: p1 } = await addTask({ title: 'Frontend umbrella epic', category: 'Work', project: 'EKS' });
    const { task: p2 } = await addTask({ title: 'Backend deployment epic', category: 'Work', project: 'EKS' });

    const { task: a } = await addTask({ title: CIS_VARIANTS[0], parent_task_id: p1.id });
    const { task: b } = await addTask({ title: CIS_VARIANTS[1], parent_task_id: p2.id });

    expect(b.id).not.toBe(a.id);
  });

  it('dedups top-level tasks only within the same category+project', async () => {
    const { task: a } = await addTask({ title: CIS_VARIANTS[0], category: 'Work', project: 'EKS' });

    // Same list → deduped.
    const { task: same } = await addTask({ title: CIS_VARIANTS[2], category: 'Work', project: 'EKS' });
    expect(same.id).toBe(a.id);

    // Different project → not deduped.
    const { task: other } = await addTask({ title: CIS_VARIANTS[2], category: 'Work', project: 'Infra' });
    expect(other.id).not.toBe(a.id);
  });

  it('re-creating after the first task is COMPLETED is allowed (not breeding)', async () => {
    const { task: parent } = await addTask({ title: 'Umbrella', category: 'Work', project: 'EKS' });
    const { task: first } = await addTask({ title: CIS_VARIANTS[0], parent_task_id: parent.id });

    await completeTask(first.id);

    // After completion, the same request is a deliberate new task — should create.
    const { task: again } = await addTask({ title: CIS_VARIANTS[1], parent_task_id: parent.id });
    expect(again.id).not.toBe(first.id);
  });

  it('respects _skipDedup for internal batch callers', async () => {
    const { task: parent } = await addTask({ title: 'Umbrella', category: 'Work', project: 'EKS' });
    const { task: first } = await addTask({ title: CIS_VARIANTS[0], parent_task_id: parent.id });
    const { task: second } = await addTask({ title: CIS_VARIANTS[1], parent_task_id: parent.id, _skipDedup: true });

    expect(second.id).not.toBe(first.id);
  });
});

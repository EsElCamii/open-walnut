/**
 * Tests for the notification center API routes.
 * Covers GET /api/notifications (feed + unread) and POST /mark-read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { WALNUT_HOME } from '../../../src/constants.js';
import { notificationsRouter } from '../../../src/web/routes/notifications.js';
import { addNotification } from '../../../src/core/notifications/store.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('GET /api/notifications', () => {
  it('returns an empty feed with zero unread when none exist', async () => {
    const res = await request(createApp()).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.feed).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it('returns persisted notifications with unread count', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'Backup', dedupKey: 'cron:Backup:1' });
    await addNotification({ kind: 'permission', severity: 'warning', title: 'Bash', sessionId: 's1', dedupKey: 'perm:r1' });

    const res = await request(createApp()).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.feed).toHaveLength(2);
    expect(res.body.unreadCount).toBe(2);
  });
});

describe('POST /api/notifications/mark-read', () => {
  it('marks all read when no ids supplied', async () => {
    await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/mark-read').send({});
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('marks only the supplied ids read', async () => {
    const a = await addNotification({ kind: 'cron', severity: 'info', title: 'A', dedupKey: 'k:a' });
    await addNotification({ kind: 'cron', severity: 'info', title: 'B', dedupKey: 'k:b' });

    const res = await request(createApp()).post('/api/notifications/mark-read').send({ ids: [a.id] });
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
  });

  it('rejects a non-array ids payload', async () => {
    const res = await request(createApp()).post('/api/notifications/mark-read').send({ ids: 'nope' });
    expect(res.status).toBe(400);
  });
});

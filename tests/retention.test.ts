/**
 * Retention policy tests: notes persist across refresh until shared, and
 * are wiped after one week.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import * as db from '../src/storage/db';

const DB_NAME = 'door-knocking-notes';

/** Seed a block with one transcribed session + transcript at a given time. */
async function seedBlock(blockId: string, at: number): Promise<void> {
  await db.createSession({
    id: `${blockId}-s1`,
    blockId,
    startedAt: at,
    endedAt: at + 5000,
    durationMs: 5000,
    status: 'transcribed',
    whisperModel: 'test',
  });
  await db.putTranscript({
    sessionId: `${blockId}-s1`,
    text: 'a note',
    redactionCount: 0,
    createdAt: at,
  });
  // createBlock generates its own id, so write the block row directly.
  const raw = await openDB(DB_NAME, 4);
  await raw.put('sessionBlocks', { id: blockId, createdAt: at });
  raw.close();
}

beforeEach(async () => {
  await db.closeForTests();
  await deleteDB(DB_NAME);
});

describe('retention', () => {
  it('keeps recent notes through a purge (refresh-safe)', async () => {
    await seedBlock('recent', Date.now() - 60 * 1000);
    await db.purgeExpired();
    expect(await db.listSessions()).toHaveLength(1);
    expect(await db.getTranscript('recent-s1')).toBeDefined();
  });

  it('wipes notes older than one week', async () => {
    const old = Date.now() - db.RETENTION_MS - 60 * 1000;
    await seedBlock('old', old);
    await db.purgeExpired();
    expect(await db.listSessions()).toHaveLength(0);
    expect(await db.getTranscript('old-s1')).toBeUndefined();
    expect(await db.getBlock('old')).toBeUndefined();
  });

  it('wipes orphaned sessions older than one week', async () => {
    const old = Date.now() - db.RETENTION_MS - 60 * 1000;
    // Session whose block row is missing entirely.
    await db.createSession({
      id: 'orphan',
      blockId: 'missing-block',
      startedAt: old,
      endedAt: old + 5000,
      durationMs: 5000,
      status: 'transcribed',
      whisperModel: 'test',
    });
    await db.purgeExpired();
    expect(await db.getSession('orphan')).toBeUndefined();
  });
});

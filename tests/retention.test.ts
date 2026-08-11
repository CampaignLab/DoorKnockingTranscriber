/**
 * Retention policy tests: notes persist across refresh until shared, and
 * are wiped after one week.
 *
 * Also covers the audio-chunk buffer, which is the one place raw recordings
 * touch disk — audio must never outlive the note it produced.
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
    createdAt: at,
  });
  // createBlock generates its own id, so write the block row directly.
  const raw = await openDB(DB_NAME, 4);
  await raw.put('sessionBlocks', { id: blockId, createdAt: at });
  raw.close();
}

async function seedChunks(sessionId: string, count: number): Promise<void> {
  for (let sequence = 0; sequence < count; sequence++) {
    await db.putAudioChunk({
      sessionId,
      sequence,
      blob: new Blob([new Uint8Array([sequence])], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
  }
}

async function countChunks(): Promise<number> {
  const raw = await openDB(DB_NAME, 4);
  const count = await raw.count('audioChunks');
  raw.close();
  return count;
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

  it('deletes recordings and notes when a block is shared', async () => {
    // The privacy promise on the share screen: once notes are handed off,
    // nothing personal is left on the phone.
    await seedBlock('shared', Date.now());
    await seedChunks('shared-s1', 3);

    await db.deleteBlock('shared');

    expect(await db.getSession('shared-s1')).toBeUndefined();
    expect(await db.getTranscript('shared-s1')).toBeUndefined();
    expect(await countChunks()).toBe(0);
    expect(await db.getBlock('shared')).toBeUndefined();
  });
});

describe('audio chunk buffer', () => {
  it('lists chunk ids in recorded order past nine', async () => {
    // Ids are `${sessionId}:${sequence}`, so a plain string sort would put
    // chunk 10 before chunk 2 and scramble the note.
    await seedChunks('s', 12);
    const ids = await db.listAudioChunkIdsForSession('s');
    expect(ids).toHaveLength(12);
    expect(ids[9]).toBe('s:9');
    expect(ids[10]).toBe('s:10');
  });

  it('deletes a single chunk as it is consumed', async () => {
    await seedChunks('s', 3);
    await db.deleteAudioChunk('s:1');
    expect(await db.getAudioChunk('s:1')).toBeUndefined();
    expect(await countChunks()).toBe(2);
  });

  it('sweeps audio belonging to an already-written-up session', async () => {
    await db.createSession({
      id: 'done',
      blockId: 'b',
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 1000,
      status: 'transcribed',
      whisperModel: 'test',
    });
    await seedChunks('done', 2);

    await db.purgeOrphanAudioChunks();

    expect(await countChunks()).toBe(0);
  });

  it('sweeps audio whose session no longer exists', async () => {
    await seedChunks('vanished', 2);
    await db.purgeOrphanAudioChunks();
    expect(await countChunks()).toBe(0);
  });

  it('keeps audio for a session that still needs writing up', async () => {
    await db.createSession({
      id: 'pending',
      blockId: 'b',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      status: 'transcribing',
      whisperModel: 'test',
    });
    await seedChunks('pending', 2);

    await db.purgeOrphanAudioChunks();

    expect(await countChunks()).toBe(2);
  });
});

describe('crash recovery', () => {
  it('finds sessions interrupted before their audio was written up', async () => {
    for (const [id, status] of [
      ['interrupted', 'transcribing'],
      ['never-started', 'recorded'],
      ['finished', 'transcribed'],
    ] as const) {
      await db.createSession({
        id,
        blockId: 'b',
        startedAt: Date.now(),
        endedAt: null,
        durationMs: 0,
        status,
        whisperModel: 'test',
      });
      await seedChunks(id, 1);
    }

    const resumable = (await db.findResumableSessions()).map((s) => s.id);

    expect(resumable).toContain('interrupted');
    expect(resumable).toContain('never-started');
    expect(resumable).not.toContain('finished');
  });

  it('finds nothing when no audio is buffered', async () => {
    await seedBlock('clean', Date.now());
    expect(await db.findResumableSessions()).toHaveLength(0);
  });
});

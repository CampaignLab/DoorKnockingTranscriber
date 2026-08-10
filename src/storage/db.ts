/**
 * IndexedDB persistence layer.
 *
 * Privacy invariants enforced here:
 *  - `transcripts` only ever receives REDACTED text (callers must run
 *    privacy/redact.ts first; pipeline.ts does this before calling put).
 *  - `audioChunks` retention is off by default: audio lives only in memory
 *    and is deleted/discarded as soon as it has been transcribed.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type SessionStatus = 'recorded' | 'transcribed';

export interface SessionRecord {
  id: string;
  /** Block this session belongs to. */
  blockId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: SessionStatus;
  whisperModel: string;
  createdAt: number;
}

export interface SessionBlockRecord {
  id: string;
  createdAt: number;
}

export interface AudioChunkRecord {
  /** `${sessionId}:${sequence}` */
  id: string;
  sessionId: string;
  sequence: number;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  createdAt: number;
}

export interface TranscriptRecord {
  sessionId: string;
  /** REDACTED text only — never store raw transcripts. */
  text: string;
  /** Count of redactions applied, for the audit trail (not the PII itself). */
  redactionCount: number;
  createdAt: number;
}

export interface SettingRecord {
  key: string;
  value: string;
}

/** Well-known settings keys. */
export const SETTINGS_KEYS = {
  /** 'true' once the onboarding flow (model download) has completed. */
  onboarded: 'onboarded',
} as const;

interface DoorNotesDB extends DBSchema {
  sessionBlocks: { key: string; value: SessionBlockRecord };
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { 'by-startedAt': number; 'by-blockId': string };
  };
  audioChunks: {
    key: string;
    value: AudioChunkRecord;
    indexes: { 'by-sessionId': string };
  };
  transcripts: { key: string; value: TranscriptRecord };
  settings: { key: string; value: SettingRecord };
}

const DB_NAME = 'door-knocking-notes';
const DB_VERSION = 4;

let dbPromise: Promise<IDBPDatabase<DoorNotesDB>> | null = null;

function db(): Promise<IDBPDatabase<DoorNotesDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DoorNotesDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 2) {
          const sessions = database.createObjectStore('sessions', {
            keyPath: 'id',
          });
          sessions.createIndex('by-startedAt', 'startedAt');

          const chunks = database.createObjectStore('audioChunks', {
            keyPath: 'id',
          });
          chunks.createIndex('by-sessionId', 'sessionId');

          database.createObjectStore('transcripts', { keyPath: 'sessionId' });
          database.createObjectStore('settings', { keyPath: 'key' });
        }
        // v3: drop the legacy on-device LLM insights store.
        if (oldVersion < 3 && database.objectStoreNames.contains('insights' as never)) {
          database.deleteObjectStore('insights' as never);
        }
        // v4: add session blocks. The old sessions store lacks the blockId
        // index and its records have no blockId, so it is recreated empty —
        // v3 sessions without blocks are not migratable.
        if (oldVersion < 4) {
          if (database.objectStoreNames.contains('audioChunks')) {
            database.deleteObjectStore('audioChunks');
          }
          if (database.objectStoreNames.contains('transcripts')) {
            database.deleteObjectStore('transcripts');
          }
          if (database.objectStoreNames.contains('sessions')) {
            database.deleteObjectStore('sessions');
          }

          database.createObjectStore('sessionBlocks', { keyPath: 'id' });

          const sessions = database.createObjectStore('sessions', {
            keyPath: 'id',
          });
          sessions.createIndex('by-startedAt', 'startedAt');
          sessions.createIndex('by-blockId', 'blockId');

          const chunks = database.createObjectStore('audioChunks', {
            keyPath: 'id',
          });
          chunks.createIndex('by-sessionId', 'sessionId');

          database.createObjectStore('transcripts', { keyPath: 'sessionId' });
        }
      },
    });
  }
  return dbPromise;
}

// --- Settings ---

export async function getSetting(key: string): Promise<string | null> {
  const record = await (await db()).get('settings', key);
  return record?.value ?? null;
}

export async function putSetting(key: string, value: string): Promise<void> {
  await (await db()).put('settings', { key, value });
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

// --- Session blocks ---

export async function createBlock(): Promise<SessionBlockRecord> {
  const record: SessionBlockRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  await (await db()).put('sessionBlocks', record);
  return record;
}

export async function getBlock(
  id: string,
): Promise<SessionBlockRecord | undefined> {
  return (await db()).get('sessionBlocks', id);
}

export async function listSessionsForBlock(
  blockId: string,
): Promise<SessionRecord[]> {
  const sessions = await (await db())
    .getAllFromIndex('sessions', 'by-blockId', blockId);
  return sessions.sort((a, b) => a.startedAt - b.startedAt);
}

/** Delete a block and every session, transcript, and audio chunk in it. */
export async function deleteBlock(blockId: string): Promise<void> {
  const sessions = await listSessionsForBlock(blockId);
  for (const session of sessions) {
    await deleteSession(session.id);
  }
  await (await db()).delete('sessionBlocks', blockId);
}

// --- Sessions ---

export async function createSession(
  record: Omit<SessionRecord, 'createdAt'>,
): Promise<void> {
  await (await db()).put('sessions', { ...record, createdAt: Date.now() });
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<SessionRecord, 'id'>>,
): Promise<void> {
  const database = await db();
  const existing = await database.get('sessions', id);
  if (!existing) throw new Error(`Session ${id} not found`);
  await database.put('sessions', { ...existing, ...patch });
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return (await db()).get('sessions', id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  const all = await (await db()).getAll('sessions');
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteSession(id: string): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    ['sessions', 'audioChunks', 'transcripts'],
    'readwrite',
  );
  await tx.objectStore('sessions').delete(id);
  await tx.objectStore('transcripts').delete(id);
  const chunkKeys = await tx
    .objectStore('audioChunks')
    .index('by-sessionId')
    .getAllKeys(id);
  for (const key of chunkKeys) {
    await tx.objectStore('audioChunks').delete(key);
  }
  await tx.done;
}

// --- Audio chunks (optional retention) ---

export async function putAudioChunk(
  record: Omit<AudioChunkRecord, 'id' | 'createdAt'>,
): Promise<void> {
  await (await db()).put('audioChunks', {
    ...record,
    id: `${record.sessionId}:${record.sequence}`,
    createdAt: Date.now(),
  });
}

export async function deleteAudioChunksForSession(
  sessionId: string,
): Promise<void> {
  const database = await db();
  const keys = await database
    .transaction('audioChunks')
    .store.index('by-sessionId')
    .getAllKeys(sessionId);
  const tx = database.transaction('audioChunks', 'readwrite');
  for (const key of keys) await tx.store.delete(key);
  await tx.done;
}

// --- Transcripts (redacted only) ---

export async function putTranscript(record: TranscriptRecord): Promise<void> {
  await (await db()).put('transcripts', record);
}

export async function getTranscript(
  sessionId: string,
): Promise<TranscriptRecord | undefined> {
  return (await db()).get('transcripts', sessionId);
}

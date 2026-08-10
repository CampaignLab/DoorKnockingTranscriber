/**
 * IndexedDB persistence layer.
 *
 * Privacy invariants enforced here:
 *  - Everything stays on the device — nothing is ever uploaded.
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
  /** The transcript exactly as transcribed. */
  text: string;
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
  /** Id of the block currently being recorded into, so a refresh rejoins it. */
  currentBlockId: 'currentBlockId',
} as const;

/**
 * Crash watchdog flag (sessionStorage, so it survives a tab kill/reload
 * but not a fresh visit). Set before transcription starts and cleared on
 * success; if the page reloads and this is set, the previous session was
 * killed mid-transcription — almost always by the OS for using too much
 * memory on an older phone.
 */
export const WATCHDOG_KEY = 'transcribing';

export function setWatchdog(active: boolean): void {
  try {
    if (active) sessionStorage.setItem(WATCHDOG_KEY, '1');
    else sessionStorage.removeItem(WATCHDOG_KEY);
  } catch {
    // sessionStorage unavailable (private mode etc.) — watchdog just
    // won't fire; not worth surfacing.
  }
}

/** True if the previous page load died mid-transcription. */
export function consumeWatchdog(): boolean {
  try {
    const tripped = sessionStorage.getItem(WATCHDOG_KEY) === '1';
    if (tripped) sessionStorage.removeItem(WATCHDOG_KEY);
    return tripped;
  } catch {
    return false;
  }
}

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

/** Close and forget the cached connection (used by tests between runs). */
export async function closeForTests(): Promise<void> {
  const database = await dbPromise?.catch(() => null);
  database?.close();
  dbPromise = null;
}

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

// --- Retention ---

/** Notes are kept until shared, or for at most one week. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete blocks (and all their sessions/transcripts/chunks) older than the
 * retention window, plus any orphaned sessions. Runs once at app startup.
 */
export async function purgeExpired(now = Date.now()): Promise<void> {
  const cutoff = now - RETENTION_MS;
  const database = await db();
  const blocks = await database.getAll('sessionBlocks');
  const keepBlockIds = new Set<string>();
  for (const block of blocks) {
    if (block.createdAt >= cutoff) {
      keepBlockIds.add(block.id);
    } else {
      await deleteBlock(block.id);
    }
  }
  // Orphaned sessions (block deleted, e.g. mid-write crash) older than the
  // window are wiped too — nothing personal lingers.
  const sessions = await database.getAll('sessions');
  for (const session of sessions) {
    if (!keepBlockIds.has(session.blockId) && session.startedAt < cutoff) {
      await deleteSession(session.id);
    }
  }
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

// --- Transcripts ---

export async function putTranscript(record: TranscriptRecord): Promise<void> {
  await (await db()).put('transcripts', record);
}

export async function getTranscript(
  sessionId: string,
): Promise<TranscriptRecord | undefined> {
  return (await db()).get('transcripts', sessionId);
}

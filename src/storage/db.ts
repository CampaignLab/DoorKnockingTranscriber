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
import type { Insight } from '../llm/extractor';

export type SessionStatus = 'recorded' | 'transcribed' | 'analysed';

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  status: SessionStatus;
  whisperModel: string;
  llmModel: string | null;
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

export interface InsightRecord {
  sessionId: string;
  insight: Insight;
  createdAt: number;
}

export interface SettingRecord {
  key: string;
  value: string;
}

/** Well-known settings keys. */
export const SETTINGS_KEYS = {
  /** Email of the councillor/MP the user is campaigning for. */
  campaignEmail: 'campaignEmail',
  /** 'true' once the onboarding flow has completed. */
  onboarded: 'onboarded',
} as const;

interface DoorNotesDB extends DBSchema {
  sessions: {
    key: string;
    value: SessionRecord;
    indexes: { 'by-startedAt': number };
  };
  audioChunks: {
    key: string;
    value: AudioChunkRecord;
    indexes: { 'by-sessionId': string };
  };
  transcripts: { key: string; value: TranscriptRecord };
  insights: { key: string; value: InsightRecord };
  settings: { key: string; value: SettingRecord };
}

const DB_NAME = 'door-knocking-notes';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<DoorNotesDB>> | null = null;

function db(): Promise<IDBPDatabase<DoorNotesDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DoorNotesDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const sessions = database.createObjectStore('sessions', {
          keyPath: 'id',
        });
        sessions.createIndex('by-startedAt', 'startedAt');

        const chunks = database.createObjectStore('audioChunks', {
          keyPath: 'id',
        });
        chunks.createIndex('by-sessionId', 'sessionId');

        database.createObjectStore('transcripts', { keyPath: 'sessionId' });
        database.createObjectStore('insights', { keyPath: 'sessionId' });
        database.createObjectStore('settings', { keyPath: 'key' });
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
    ['sessions', 'audioChunks', 'transcripts', 'insights'],
    'readwrite',
  );
  await tx.objectStore('sessions').delete(id);
  await tx.objectStore('transcripts').delete(id);
  await tx.objectStore('insights').delete(id);
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

// --- Insights ---

export async function putInsight(record: InsightRecord): Promise<void> {
  await (await db()).put('insights', record);
}

export async function getInsight(
  sessionId: string,
): Promise<InsightRecord | undefined> {
  return (await db()).get('insights', sessionId);
}

export async function listInsights(): Promise<InsightRecord[]> {
  return (await db()).getAll('insights');
}

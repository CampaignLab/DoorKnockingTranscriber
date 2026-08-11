/**
 * The write-up phase: transcription now runs after recording rather than
 * alongside it, working through buffered chunks one at a time.
 *
 * What matters here is that a long session cannot strand audio on disk and
 * cannot be lost to a single bad chunk — the two ways the old concurrent
 * pipeline failed on slow phones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import * as db from '../src/storage/db';
import { SessionPipeline } from '../src/pipeline';

const DB_NAME = 'door-knocking-notes';

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(async (_audio: Float32Array) => 'hello'),
  load: vi.fn(async () => {}),
  dispose: vi.fn(),
  decode: vi.fn(async (_blob: Blob) => new Float32Array(16_000)),
}));

// Real capture and inference need MediaRecorder/WASM; neither exists here
// and neither is what these tests are about.
vi.mock('../src/audio/recorder', () => ({
  ChunkedRecorder: class {},
  decodeToMono16k: mocks.decode,
}));

vi.mock('../src/transcription/transcriber', () => ({
  Transcriber: class {
    isReady = true;
    load = mocks.load;
    transcribe = mocks.transcribe;
    dispose = mocks.dispose;
  },
}));

async function countChunks(): Promise<number> {
  const raw = await openDB(DB_NAME, 4);
  const count = await raw.count('audioChunks');
  raw.close();
  return count;
}

async function seedSession(id: string, chunks: number): Promise<void> {
  await db.createSession({
    id,
    blockId: 'block',
    startedAt: Date.now(),
    endedAt: Date.now(),
    durationMs: chunks * 30_000,
    status: 'transcribing',
    whisperModel: 'test',
  });
  for (let sequence = 0; sequence < chunks; sequence++) {
    await db.putAudioChunk({
      sessionId: id,
      sequence,
      blob: new Blob([new Uint8Array([sequence])], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 30_000,
    });
  }
}

function newPipeline(events = {}): SessionPipeline {
  // An explicit model keeps the device heuristic (and its navigator probing)
  // out of these tests.
  return new SessionPipeline(events, { whisperModel: 'Xenova/whisper-tiny.en' });
}

beforeEach(async () => {
  await db.closeForTests();
  await deleteDB(DB_NAME);
  vi.clearAllMocks();
  mocks.transcribe.mockImplementation(async () => 'hello');
  mocks.decode.mockImplementation(async () => new Float32Array(16_000));
});

describe('writing up a session', () => {
  it('joins every chunk into one transcript and leaves no audio behind', async () => {
    await seedSession('s', 4);

    await newPipeline().transcribeSession('s');

    expect((await db.getTranscript('s'))?.text).toBe('hello hello hello hello');
    expect((await db.getSession('s'))?.status).toBe('transcribed');
    expect(await countChunks()).toBe(0);
  });

  it('deletes each chunk as it is written up, not just at the end', async () => {
    // The buffer must shrink as it drains: on a long recording, holding
    // every chunk until the end is what the old pipeline got wrong.
    await seedSession('s', 4);
    const remaining: number[] = [];
    mocks.transcribe.mockImplementation(async () => {
      remaining.push(await countChunks());
      return 'x';
    });

    await newPipeline().transcribeSession('s');

    expect(remaining).toEqual([4, 3, 2, 1]);
  });

  it('saves the transcript after every chunk so a crash loses at most one', async () => {
    await seedSession('s', 3);
    const snapshots: (string | undefined)[] = [];
    mocks.transcribe.mockImplementation(async () => {
      snapshots.push((await db.getTranscript('s'))?.text);
      return 'x';
    });

    await newPipeline().transcribeSession('s');

    expect(snapshots).toEqual([undefined, 'x', 'x x']);
  });

  it('resumes an interrupted session on top of what was already written', async () => {
    await seedSession('s', 2);
    await db.putTranscript({
      sessionId: 's',
      text: 'earlier words',
      createdAt: Date.now(),
    });

    await newPipeline().transcribeSession('s');

    expect((await db.getTranscript('s'))?.text).toBe(
      'earlier words hello hello',
    );
  });

  it('keeps the rest of the note when one chunk fails outright', async () => {
    // transcribeWithRecovery retries once, so a chunk needs two failures
    // to be skipped.
    await seedSession('s', 3);
    const errors: string[] = [];
    let call = 0;
    mocks.transcribe.mockImplementation(async () => {
      call++;
      if (call === 2 || call === 3) throw new Error('worker died');
      return 'ok';
    });

    await newPipeline({ onError: (m: string) => errors.push(m) })
      .transcribeSession('s');

    expect((await db.getTranscript('s'))?.text).toBe('ok ok');
    expect(errors).toHaveLength(1);
    expect(await countChunks()).toBe(0);
    expect((await db.getSession('s'))?.status).toBe('transcribed');
  });

  it('reports progress across the whole session', async () => {
    await seedSession('s', 3);
    const seen: string[] = [];

    await newPipeline({
      onProgress: (done: number, total: number) => seen.push(`${done}/${total}`),
    }).transcribeSession('s');

    expect(seen).toEqual(['0/3', '1/3', '2/3', '3/3']);
  });

  it('never loads the model for a session with no audio', async () => {
    await seedSession('s', 0);

    await newPipeline().transcribeSession('s');

    expect(mocks.load).not.toHaveBeenCalled();
    expect((await db.getSession('s'))?.status).toBe('transcribed');
  });

  it('releases the worker even when the session fails', async () => {
    // The WASM heap must not stay open after a failure — the next session
    // would start already close to the device's limit.
    await seedSession('s', 1);
    mocks.decode.mockImplementation(async () => {
      throw new Error('unreadable audio');
    });

    await newPipeline().transcribeSession('s');

    expect(mocks.dispose).toHaveBeenCalled();
  });
});

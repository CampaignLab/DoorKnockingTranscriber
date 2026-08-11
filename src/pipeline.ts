/**
 * Pipeline orchestration, in two strictly separate phases:
 *
 *   1. record  — capture chunks straight to IndexedDB. No model, no decode,
 *                no inference.
 *   2. write up — after the user stops, load Whisper and work through the
 *                chunks one at a time, deleting each as its text is saved.
 *
 * Keeping the phases apart is what makes long recordings survive on older
 * phones: peak memory becomes the larger of the two phases instead of their
 * sum, and the CPU is not fighting the microphone while it transcribes.
 *
 * Privacy rules enforced here:
 *  - Transcripts and audio never leave the device.
 *  - A chunk exists only between being recorded and being written up; it is
 *    deleted the instant its text is saved, and any remainder is deleted
 *    when the session finishes.
 */

import { ChunkedRecorder, decodeToMono16k, type AudioChunk } from './audio/recorder';
import { Transcriber } from './transcription/transcriber';
import type { WhisperModelId } from './transcription/transcription-protocol';
import { LOW_MEMORY_MODEL, pickWhisperModel } from './transcription/device';
import * as db from './storage/db';

export interface PipelineEvents {
  /** Called with the running transcript whenever a new chunk is written up. */
  onTranscriptUpdate?: (sessionId: string, text: string) => void;
  onStatusChange?: (status: string) => void;
  /** Chunks written up so far, out of the total for this session. */
  onProgress?: (done: number, total: number) => void;
  onError?: (message: string) => void;
}

export interface PipelineOptions {
  whisperModel?: WhisperModelId;
}

export class SessionPipeline {
  readonly transcriber = new Transcriber();
  /** Mutable so views can attach handlers after construction. */
  readonly events: PipelineEvents;

  private recorder: ChunkedRecorder | null = null;
  private sessionId: string | null = null;
  private sessionStartedAt = 0;
  private whisperModel: WhisperModelId;
  /** Serialises chunk writes so they land in order. */
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private transcribing = false;

  constructor(events: PipelineEvents = {}, options: PipelineOptions = {}) {
    this.events = events;
    // Pick a model the device can actually hold in memory — Whisper Base
    // on WASM spikes past older phones' tab memory budget and the OS
    // kills (and reloads) the page mid-transcription.
    this.whisperModel = options.whisperModel ?? pickWhisperModel();
  }

  /** The model this pipeline will load/use. */
  get model(): WhisperModelId {
    return this.whisperModel;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get isRecording(): boolean {
    return this.recorder?.isRecording ?? false;
  }

  /** True while recording, saving audio, or writing a session up. */
  get isBusy(): boolean {
    return this.isRecording || this.pendingWrites > 0 || this.transcribing;
  }

  async startSession(blockId: string): Promise<string> {
    if (this.sessionId) throw new Error('A session is already active');

    const id = db.newSessionId();
    this.sessionId = id;
    this.sessionStartedAt = Date.now();
    this.pendingWrites = 0;
    this.writeQueue = Promise.resolve();

    await db.createSession({
      id,
      blockId,
      startedAt: this.sessionStartedAt,
      endedAt: null,
      durationMs: 0,
      status: 'recorded',
      whisperModel: this.whisperModel,
    });

    // Note there is deliberately no transcriber.load() here. The WASM heap
    // dwarfs everything else on the device, and holding it open alongside
    // the microphone is what pushed older phones over their budget.
    this.recorder = new ChunkedRecorder((chunk) => this.handleChunk(chunk));
    await this.recorder.start();
    this.events.onStatusChange?.('Recording…');
    return id;
  }

  /**
   * Buffer a chunk to disk. Nothing is decoded or transcribed while
   * recording, so this stays cheap however long the conversation runs.
   */
  private handleChunk(chunk: AudioChunk): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    this.pendingWrites++;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await db.putAudioChunk({
          sessionId,
          sequence: chunk.sequence,
          blob: chunk.blob,
          mimeType: chunk.mimeType,
          durationMs: chunk.durationMs,
        });
      } catch (err) {
        this.events.onError?.(
          err instanceof Error
            ? err.message
            : 'Could not save part of the recording.',
        );
      } finally {
        this.pendingWrites--;
      }
    });
  }

  /** Stop recording, then write the session up. */
  async endSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    const recorder = this.recorder;
    this.recorder = null;
    // stop() flushes a final ondataavailable, so the session id must still
    // be set here for handleChunk to accept it.
    await recorder?.stop();
    await this.writeQueue;
    this.sessionId = null;

    const endedAt = Date.now();
    await db.updateSession(sessionId, {
      endedAt,
      durationMs: endedAt - this.sessionStartedAt,
      status: 'transcribing',
    });

    await this.transcribeSession(sessionId);
  }

  /**
   * Write up every buffered chunk for a session, oldest first.
   *
   * Safe to call on a session interrupted by a crash: the transcript is
   * saved after each chunk and each chunk is deleted once consumed, so this
   * simply picks up wherever it left off.
   */
  async transcribeSession(sessionId: string): Promise<void> {
    if (this.transcribing) throw new Error('Already writing up a session');
    this.transcribing = true;

    try {
      const chunkIds = await db.listAudioChunkIdsForSession(sessionId);
      const total = chunkIds.length;
      // Resuming: keep whatever was already written up before the crash.
      let text = (await db.getTranscript(sessionId))?.text ?? '';

      if (total > 0) {
        this.events.onStatusChange?.('Preparing transcription…');
        // The model files are in Cache Storage, so this is fast and works
        // offline even though the worker was torn down.
        await this.transcriber.load(this.whisperModel);
      }

      let done = 0;
      this.events.onProgress?.(done, total);

      for (const chunkId of chunkIds) {
        // One blob in memory at a time — this is what lets a session run
        // for any length without the buffer growing in RAM.
        const chunk = await db.getAudioChunk(chunkId);
        if (chunk) {
          try {
            const chunkText = await this.transcribeWithRecovery(chunk.blob);
            if (chunkText) {
              text = text ? `${text} ${chunkText}` : chunkText;
              await db.putTranscript({
                sessionId,
                text,
                createdAt: Date.now(),
              });
              this.events.onTranscriptUpdate?.(sessionId, text);
            }
          } catch (err) {
            // One unreadable chunk must not cost the rest of the note.
            this.events.onError?.(
              err instanceof Error
                ? `Part of this note could not be written up: ${err.message}`
                : 'Part of this note could not be written up.',
            );
          }
        }

        // Deleted whether or not it transcribed: the audio has had its one
        // chance and must not linger on disk.
        await db.deleteAudioChunk(chunkId);
        done++;
        this.events.onProgress?.(done, total);
      }

      await db.putTranscript({ sessionId, text, createdAt: Date.now() });
      await db.updateSession(sessionId, { status: 'transcribed' });
      // Belt and braces — nothing should remain, but never leave audio behind.
      await db.deleteAudioChunksForSession(sessionId);
      this.events.onStatusChange?.('Session saved');
    } finally {
      this.transcribing = false;
      // Release the WASM heap (hundreds of MB on phones) between sessions.
      this.transcriber.dispose();
    }
  }

  /**
   * Transcribe one chunk, surviving a worker that died or timed out.
   *
   * A second failure propagates, so the caller can skip this chunk and
   * carry on with the rest of the session.
   */
  private async transcribeWithRecovery(blob: Blob): Promise<string> {
    try {
      if (!this.transcriber.isReady) {
        await this.transcriber.load(this.whisperModel);
      }
      return await this.transcriber.transcribe(await decodeToMono16k(blob));
    } catch {
      // Falling back to the small model for the remainder: if the big one
      // just got this device killed, it will do so again on the next chunk.
      this.transcriber.dispose();
      this.whisperModel = LOW_MEMORY_MODEL;
      await this.transcriber.load(this.whisperModel);
      return await this.transcriber.transcribe(await decodeToMono16k(blob));
    }
  }

  dispose(): void {
    this.transcriber.dispose();
  }
}

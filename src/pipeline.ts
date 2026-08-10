/**
 * Pipeline orchestration:
 *   record chunk → transcribe → REDACT → store transcript.
 *
 * Privacy rules enforced here:
 *  - Raw transcript text exists in memory only.
 *  - Audio chunks are kept in memory unless keepAudio is enabled, and are
 *    deleted after transcription when they were persisted.
 */

import { ChunkedRecorder, decodeToMono16k, type AudioChunk } from './audio/recorder';
import { Transcriber } from './transcription/transcriber';
import type { WhisperModelId } from './transcription/transcription-protocol';
import { pickWhisperModel } from './transcription/device';
import { redactPII } from './privacy/redact';
import * as db from './storage/db';

export interface PipelineEvents {
  /** Called with the running REDACTED transcript whenever a new chunk is transcribed. */
  onTranscriptUpdate?: (sessionId: string, text: string) => void;
  onStatusChange?: (status: string) => void;
  onError?: (message: string) => void;
}

export interface PipelineOptions {
  keepAudio?: boolean;
  whisperModel?: WhisperModelId;
}

export class SessionPipeline {
  readonly transcriber = new Transcriber();

  private recorder: ChunkedRecorder | null = null;
  private sessionId: string | null = null;
  private sessionStartedAt = 0;
  private redactedParts: string[] = [];
  private redactionCount = 0;
  private keepAudio: boolean;
  private whisperModel: WhisperModelId;
  private chunkQueue: Promise<void> = Promise.resolve();
  private pendingChunks = 0;
  private readonly events: PipelineEvents;

  constructor(events: PipelineEvents = {}, options: PipelineOptions = {}) {
    this.events = events;
    this.keepAudio = options.keepAudio ?? false;
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

  /** True while recording or while chunks are still being transcribed. */
  get isBusy(): boolean {
    return this.isRecording || this.pendingChunks > 0;
  }

  async startSession(blockId: string): Promise<string> {
    if (this.sessionId) throw new Error('A session is already active');
    // The worker is torn down between sessions to free the WASM heap, so
    // it may need reloading here. The model files are in Cache Storage,
    // making this reload fast and offline-safe.
    if (!this.transcriber.isReady) {
      this.events.onStatusChange?.('Preparing transcription…');
      await this.transcriber.load(this.whisperModel);
    }

    const id = db.newSessionId();
    this.sessionId = id;
    this.sessionStartedAt = Date.now();
    this.redactedParts = [];
    this.redactionCount = 0;
    this.pendingChunks = 0;
    this.chunkQueue = Promise.resolve();

    await db.createSession({
      id,
      blockId,
      startedAt: this.sessionStartedAt,
      endedAt: null,
      durationMs: 0,
      status: 'recorded',
      whisperModel: this.whisperModel,
    });

    this.recorder = new ChunkedRecorder((chunk) => this.handleChunk(chunk));
    await this.recorder.start();
    this.events.onStatusChange?.('Recording…');
    return id;
  }

  private handleChunk(chunk: AudioChunk): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    this.pendingChunks++;
    // Serialise chunk processing so transcripts append in order and the
    // worker is fed one chunk at a time.
    this.chunkQueue = this.chunkQueue.then(async () => {
      try {
        if (this.keepAudio) {
          await db.putAudioChunk({
            sessionId,
            sequence: chunk.sequence,
            blob: chunk.blob,
            mimeType: chunk.mimeType,
            durationMs: chunk.durationMs,
          });
        }

        const pcm = await decodeToMono16k(chunk.blob);
        const rawText = await this.transcriber.transcribe(pcm);

        if (rawText) {
          // REDACT BEFORE WRITE — raw text never leaves memory.
          const { text, redactions } = redactPII(rawText);
          this.redactionCount += redactions.length;
          if (text) this.redactedParts.push(text);
          this.events.onTranscriptUpdate?.(
            sessionId,
            this.redactedParts.join(' '),
          );
        }
      } catch (err) {
        this.events.onError?.(
          err instanceof Error ? err.message : 'Failed to process audio chunk',
        );
      } finally {
        this.pendingChunks--;
      }
    });
  }

  /**
   * Stop recording, finish pending transcriptions, persist the redacted
   * transcript, and clean up audio.
   */
  async endSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;

    this.events.onStatusChange?.('Finishing transcription…');
    const recorder = this.recorder;
    this.recorder = null;
    await recorder?.stop();

    // Wait for in-flight chunk transcriptions.
    await this.chunkQueue;

    const transcript = this.redactedParts.join(' ');
    const endedAt = Date.now();

    await db.putTranscript({
      sessionId,
      text: transcript,
      redactionCount: this.redactionCount,
      createdAt: Date.now(),
    });
    await db.updateSession(sessionId, {
      endedAt,
      durationMs: endedAt - this.sessionStartedAt,
      status: 'transcribed',
    });

    // Default policy: audio is not retained once transcribed.
    if (this.keepAudio) {
      await db.deleteAudioChunksForSession(sessionId);
    }

    this.sessionId = null;
    // Tear down the worker so the WASM heap (hundreds of MB on phones)
    // is released between sessions. Without this, successive sessions
    // push the tab past its memory budget until the OS kills it.
    this.transcriber.dispose();
    this.events.onStatusChange?.('Session saved');
  }

  dispose(): void {
    this.transcriber.dispose();
  }
}

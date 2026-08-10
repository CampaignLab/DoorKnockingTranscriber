/**
 * Pipeline orchestration:
 *   record chunk → transcribe → REDACT → store transcript → (session end)
 *   → LLM extraction → store insight → delete audio (default policy).
 *
 * Privacy rules enforced here:
 *  - Raw transcript text exists in memory only.
 *  - Audio chunks are kept in memory unless keepAudio is enabled, and are
 *    deleted after transcription when they were persisted.
 *  - The LLM only ever receives redacted text.
 */

import { ChunkedRecorder, decodeToMono16k, type AudioChunk } from './audio/recorder';
import { Transcriber } from './transcription/transcriber';
import type { WhisperModelId } from './transcription/transcription-protocol';
import { DEFAULT_WHISPER_MODEL } from './transcription/transcription-protocol';
import { InsightExtractor, DEFAULT_LLM_MODEL, type Insight } from './llm/extractor';
import { redactPII } from './privacy/redact';
import * as db from './storage/db';

export interface PipelineEvents {
  /** Called with the running REDACTED transcript whenever a new chunk is transcribed. */
  onTranscriptUpdate?: (sessionId: string, text: string) => void;
  onStatusChange?: (status: string) => void;
  onInsight?: (sessionId: string, insight: Insight) => void;
  onError?: (message: string) => void;
}

export interface PipelineOptions {
  keepAudio?: boolean;
  whisperModel?: WhisperModelId;
  llmModel?: string;
}

export class SessionPipeline {
  readonly transcriber = new Transcriber();
  readonly extractor = new InsightExtractor();

  private recorder: ChunkedRecorder | null = null;
  private sessionId: string | null = null;
  private sessionStartedAt = 0;
  private redactedParts: string[] = [];
  private redactionCount = 0;
  private keepAudio: boolean;
  private whisperModel: WhisperModelId;
  private llmModel: string;
  private chunkQueue: Promise<void> = Promise.resolve();
  private pendingChunks = 0;
  private readonly events: PipelineEvents;

  constructor(events: PipelineEvents = {}, options: PipelineOptions = {}) {
    this.events = events;
    this.keepAudio = options.keepAudio ?? false;
    this.whisperModel = options.whisperModel ?? DEFAULT_WHISPER_MODEL;
    this.llmModel = options.llmModel ?? DEFAULT_LLM_MODEL;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get isRecording(): boolean {
    return this.recorder?.isRecording ?? false;
  }

  async startSession(): Promise<string> {
    if (this.sessionId) throw new Error('A session is already active');
    if (!this.transcriber.isReady) {
      throw new Error('Transcription model not loaded yet');
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
      startedAt: this.sessionStartedAt,
      endedAt: null,
      durationMs: 0,
      status: 'recorded',
      whisperModel: this.whisperModel,
      llmModel: null,
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
   * transcript, run LLM extraction (if loaded), and clean up audio.
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

    if (this.extractor.isReady && transcript.trim().length > 0) {
      this.events.onStatusChange?.('Extracting insights…');
      try {
        const insight = await this.extractor.extract(transcript);
        await db.putInsight({ sessionId, insight, createdAt: Date.now() });
        await db.updateSession(sessionId, {
          status: 'analysed',
          llmModel: this.llmModel,
        });
        this.events.onInsight?.(sessionId, insight);
      } catch (err) {
        this.events.onError?.(
          err instanceof Error ? err.message : 'Insight extraction failed',
        );
      }
    } else if (!this.extractor.isReady) {
      // LLM is optional: without it the session stays transcribed-only.
      this.events.onStatusChange?.(
        'Session saved (insight extraction skipped — LLM not loaded)',
      );
      return;
    }

    this.events.onStatusChange?.('Session saved');
  }

  /** Re-run extraction for an existing session (e.g. after loading the LLM later). */
  async analyseSession(sessionId: string): Promise<Insight> {
    if (!this.extractor.isReady) throw new Error('LLM not loaded yet');
    const transcript = await db.getTranscript(sessionId);
    if (!transcript?.text.trim()) throw new Error('No transcript to analyse');

    const insight = await this.extractor.extract(transcript.text);
    await db.putInsight({ sessionId, insight, createdAt: Date.now() });
    await db.updateSession(sessionId, {
      status: 'analysed',
      llmModel: this.llmModel,
    });
    return insight;
  }

  dispose(): void {
    this.transcriber.dispose();
    void this.extractor.unload();
  }
}

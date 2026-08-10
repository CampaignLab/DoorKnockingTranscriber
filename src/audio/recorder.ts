/**
 * Chunked microphone recorder built on MediaRecorder.
 *
 * - Negotiates a supported mime type (opus/webm preferred, mp4 for iOS Safari).
 * - Emits fixed-length chunks (default 30 s) so a crash loses at most one chunk.
 * - Holds a screen Wake Lock while recording to reduce the chance of the OS
 *   suspending the page mid-session.
 */

export interface AudioChunk {
  blob: Blob;
  mimeType: string;
  /** 0-based sequence number within the session. */
  sequence: number;
  startedAt: number;
  durationMs: number;
}

export type ChunkHandler = (chunk: AudioChunk) => void;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/ogg;codecs=opus',
];

const DEFAULT_CHUNK_MS = 30_000;

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export class ChunkedRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private sequence = 0;
  private chunkStartedAt = 0;
  private wakeLock: WakeLockSentinelLike | null = null;
  private restartTimer: number | null = null;

  readonly chunkMs: number;
  private readonly onChunk: ChunkHandler;
  private _isRecording = false;

  constructor(onChunk: ChunkHandler, chunkMs = DEFAULT_CHUNK_MS) {
    this.onChunk = onChunk;
    this.chunkMs = chunkMs;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  /**
   * Browsers only expose the microphone in secure contexts: HTTPS or
   * localhost. Opening the dev server over http://<phone-ip> looks fine but
   * getUserMedia is blocked — this check lets the UI explain that instead of
   * showing a bare "not allowed" error.
   */
  static isSecureContextForMic(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext;
  }

  /** Translate getUserMedia failures into guidance the user can act on. */
  static explainMicError(err: unknown): string {
    if (!ChunkedRecorder.isSecureContextForMic()) {
      return (
        'Microphone needs a secure (HTTPS) connection. If you opened this via ' +
        'your computer\'s IP address (http://…), use an HTTPS URL instead: run ' +
        '`npm run dev` with basic-ssl (see README) or deploy the app, then reopen it.'
      );
    }
    if (err instanceof DOMException) {
      switch (err.name) {
        case 'NotAllowedError':
          return (
            'Microphone permission was denied. Tap the lock/site icon in your ' +
            'browser address bar, allow Microphone, then reload and try again.'
          );
        case 'NotFoundError':
          return 'No microphone found on this device.';
        case 'NotReadableError':
          return (
            'The microphone is busy — another app may be using it. Close it ' +
            'and try again.'
          );
      }
    }
    return err instanceof Error ? err.message : 'Could not access the microphone.';
  }

  static pickMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const candidate of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    }
    return null;
  }

  async start(): Promise<void> {
    if (this._isRecording) return;

    const mimeType = ChunkedRecorder.pickMimeType();
    if (!mimeType) {
      throw new Error(
        'No supported audio recording format found in this browser.',
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this._isRecording = false;
      throw new Error(ChunkedRecorder.explainMicError(err));
    }

    this.sequence = 0;
    this._isRecording = true;
    await this.acquireWakeLock();
    this.startChunk(mimeType);
  }

  private startChunk(mimeType: string): void {
    if (!this.stream || !this._isRecording) return;

    const seq = this.sequence++;
    this.chunkStartedAt = Date.now();
    const recorder = new MediaRecorder(this.stream, { mimeType });
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.onChunk({
          blob: event.data,
          mimeType,
          sequence: seq,
          startedAt: this.chunkStartedAt,
          durationMs: Date.now() - this.chunkStartedAt,
        });
      }
    };

    recorder.onerror = () => {
      // Surface via chunk stream end; pipeline handles session teardown.
      void this.stop();
    };

    // timeslice gives us a blob per chunk without needing restart logic,
    // but we still rotate the recorder each chunk for container integrity
    // (a single long webm stream can be unplayable if the page dies).
    recorder.start();

    this.restartTimer = window.setTimeout(() => {
      recorder.stop();
      if (this._isRecording) this.startChunk(mimeType);
    }, this.chunkMs);
  }

  async stop(): Promise<void> {
    if (!this._isRecording) return;
    this._isRecording = false;

    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.releaseWakeLock();
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      };
      if (nav.wakeLock) {
        this.wakeLock = await nav.wakeLock.request('screen');
      }
    } catch {
      // Wake Lock is best-effort (e.g. denied on low battery) — keep recording.
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      // ignore
    }
    this.wakeLock = null;
  }
}

/** Decode an audio blob to mono 16 kHz PCM for Whisper. */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const offlineTargetRate = 16_000;

  const decodeCtx = new AudioContext();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);

    // Down-mix to mono.
    const mono = new Float32Array(decoded.length);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < data.length; i++) mono[i] += data[i];
    }
    if (decoded.numberOfChannels > 1) {
      for (let i = 0; i < mono.length; i++) mono[i] /= decoded.numberOfChannels;
    }

    if (decoded.sampleRate === offlineTargetRate) return mono;

    // Resample via OfflineAudioContext.
    const duration = mono.length / decoded.sampleRate;
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(duration * offlineTargetRate),
      offlineTargetRate,
    );
    const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
    buffer.copyToChannel(mono, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void decodeCtx.close();
  }
}

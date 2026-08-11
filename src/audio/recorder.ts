/**
 * Chunked microphone recorder built on MediaRecorder.
 *
 * - Negotiates a supported mime type (opus/webm preferred, mp4 for iOS Safari).
 * - Emits fixed-length chunks (default 10 s) so a crash loses at most one chunk.
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

/**
 * Whisper pads every input to a fixed 30 s mel spectrogram, so a chunk
 * shorter than that costs a full 30 s inference regardless — a 10 s chunk
 * paid three times over. Matching the chunk length to the window is the
 * cheapest large win available on slow devices.
 */
const DEFAULT_CHUNK_MS = 30_000;

const TARGET_SAMPLE_RATE = 16_000;

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export class ChunkedRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private sequence = 0;
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
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.startChunk(mimeType);
  }

  private startChunk(mimeType: string): void {
    if (!this.stream || !this._isRecording) return;

    const seq = this.sequence++;
    // Held in locals, not on the instance: ondataavailable fires after the
    // next startChunk() below has already run, so instance fields would
    // report the *following* chunk's timings.
    const startedAt = Date.now();
    const recorder = new MediaRecorder(this.stream, { mimeType });
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.onChunk({
          blob: event.data,
          mimeType,
          sequence: seq,
          startedAt,
          durationMs: Date.now() - startedAt,
        });
      }
    };

    recorder.onerror = () => {
      // Surface via chunk stream end; pipeline handles session teardown.
      void this.stop();
    };

    // The recorder is rotated once per chunk rather than run with a
    // timeslice, for container integrity: a single long webm stream can be
    // unplayable if the page dies mid-write.
    recorder.start();

    this.restartTimer = window.setTimeout(() => {
      recorder.stop();
      if (this._isRecording) this.startChunk(mimeType);
    }, this.chunkMs);
  }

  async stop(): Promise<void> {
    if (!this._isRecording) return;
    this._isRecording = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

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

  /**
   * The browser auto-releases a screen wake lock whenever the page is
   * hidden and never restores it, so without this the lock silently stops
   * working the first time the canvasser switches apps.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible' && this._isRecording) {
      void this.acquireWakeLock();
    }
  };

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

/** Down-mix to a single channel, always returning a detachable copy. */
function toMono(decoded: AudioBuffer): Float32Array<ArrayBuffer> {
  if (decoded.numberOfChannels === 1) {
    // Copied rather than returned directly: the caller transfers this
    // buffer to the worker, which would detach the AudioBuffer's own store.
    const single = decoded.getChannelData(0);
    const copy = new Float32Array(single.length);
    copy.set(single);
    return copy;
  }
  const mono = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  for (let i = 0; i < mono.length; i++) mono[i] /= decoded.numberOfChannels;
  return mono;
}

/**
 * A single live AudioContext, reused across every call.
 *
 * Only used by the fallback path below. Creating one per chunk — as this
 * module used to — spins up a hardware audio unit each time and runs into
 * WebKit's cap of roughly four concurrent contexts partway through a long
 * session, which is precisely when older iPhones stopped transcribing.
 */
let fallbackCtx: AudioContext | null = null;

function sharedFallbackContext(): AudioContext {
  if (!fallbackCtx || fallbackCtx.state === 'closed') {
    fallbackCtx = new AudioContext();
  }
  return fallbackCtx;
}

/** Decode an audio blob to mono 16 kHz PCM for Whisper. */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  try {
    // decodeAudioData resamples to its context's rate, so an offline
    // context at 16 kHz decodes and resamples in one pass — no hardware
    // audio unit, and none of the intermediate buffers a separate render
    // pass would need.
    const offline = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    return toMono(await offline.decodeAudioData(await blob.arrayBuffer()));
  } catch {
    // Older WebKit builds reject decodeAudioData on an OfflineAudioContext.
    // Re-read the blob: the first attempt detached its ArrayBuffer.
    return decodeViaLiveContext(await blob.arrayBuffer());
  }
}

async function decodeViaLiveContext(
  arrayBuffer: ArrayBuffer,
): Promise<Float32Array> {
  const decoded = await sharedFallbackContext().decodeAudioData(arrayBuffer);
  const mono = toMono(decoded);
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) return mono;

  const offline = new OfflineAudioContext(
    1,
    Math.ceil((mono.length / decoded.sampleRate) * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE,
  );
  const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate);
  buffer.copyToChannel(mono, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}

/**
 * Main-thread façade for the Whisper worker: load the model (with progress
 * callbacks) and transcribe 16 kHz mono PCM chunks.
 */

import type {
  WhisperModelId,
  WorkerResponse,
} from './transcription-protocol';
import { DEFAULT_WHISPER_MODEL } from './transcription-protocol';

export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number;
}

export class Transcriber {
  private worker: Worker | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (err: Error) => void }
  >();
  private onProgress: ((p: LoadProgress) => void) | null = null;
  private model: WhisperModelId = DEFAULT_WHISPER_MODEL;

  get isReady(): boolean {
    return this.ready;
  }

  async load(
    model: WhisperModelId = DEFAULT_WHISPER_MODEL,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<void> {
    if (this.readyPromise && this.model === model) return this.readyPromise;

    this.disposeWorker();
    this.model = model;
    this.onProgress = onProgress ?? null;
    this.ready = false;

    this.worker = new Worker(
      new URL('./whisper.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker failed to start'));

      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        switch (msg.type) {
          case 'progress':
            this.onProgress?.({
              status: msg.status,
              file: msg.file,
              progress: msg.progress,
            });
            break;
          case 'ready':
            this.ready = true;
            resolve();
            break;
          case 'error':
            if (msg.id !== undefined) {
              const entry = this.pending.get(msg.id);
              if (entry) {
                this.pending.delete(msg.id);
                entry.reject(new Error(msg.message));
                break;
              }
            }
            if (!this.ready) reject(new Error(msg.message));
            break;
          case 'transcript': {
            const entry = this.pending.get(msg.id);
            if (entry) {
              this.pending.delete(msg.id);
              entry.resolve(msg.text);
            }
            break;
          }
        }
      };

      this.worker.onerror = (event) => {
        reject(new Error(event.message ?? 'Whisper worker error'));
      };

      this.worker!.postMessage({ type: 'load', model });
    });

    return this.readyPromise;
  }

  /** Transcribe mono 16 kHz PCM audio; resolves with the transcript text. */
  transcribe(audio: Float32Array): Promise<string> {
    if (!this.worker || !this.ready) {
      return Promise.reject(new Error('Transcriber not loaded'));
    }
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Transfer the underlying buffer to avoid copying large PCM data.
      this.worker!.postMessage({ type: 'transcribe', id, audio }, [
        audio.buffer,
      ]);
    });
  }

  dispose(): void {
    this.disposeWorker();
  }

  private disposeWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.readyPromise = null;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Transcriber disposed'));
    }
    this.pending.clear();
  }
}

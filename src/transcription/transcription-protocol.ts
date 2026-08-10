/** Typed messages between the main thread and the Whisper worker. */

export type WorkerRequest =
  | { type: 'load'; model: string }
  | { type: 'transcribe'; id: number; audio: Float32Array };

export type WorkerResponse =
  | {
      type: 'progress';
      status: string;
      file?: string;
      progress?: number;
    }
  | { type: 'ready'; model: string }
  | { type: 'transcript'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

export const WHISPER_MODELS = {
  'Xenova/whisper-tiny.en': {
    label: 'Whisper Tiny (English) — fastest, rougher',
    approxSizeMb: 40,
  },
  'Xenova/whisper-base.en': {
    label: 'Whisper Base (English) — recommended',
    approxSizeMb: 80,
  },
} as const;

export type WhisperModelId = keyof typeof WHISPER_MODELS;

// Per product decision: always Whisper Base for accuracy on doorstep audio.
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'Xenova/whisper-base.en';

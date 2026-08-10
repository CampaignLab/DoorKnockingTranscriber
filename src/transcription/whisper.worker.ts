/**
 * Whisper transcription worker.
 *
 * Runs @xenova/transformers' ASR pipeline off the main thread. Communicates
 * via typed messages with src/transcription/transcriber.ts.
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from '@xenova/transformers';
import type {
  WorkerRequest,
  WorkerResponse,
} from './transcription-protocol';

// Model files are cached by the library's Cache Storage usage; after the
// first download the app works fully offline.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Keep peak memory down on phones: a single WASM thread and no
// SharedArrayBuffer paths (which also require cross-origin isolation).
// Older devices get killed by the OS when the tab's memory budget is
// exceeded mid-transcription, so every allocation here counts.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.simd = true;

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let currentModel: string | null = null;

function post(message: WorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

async function loadModel(model: string): Promise<void> {
  if (transcriber && currentModel === model) {
    post({ type: 'ready', model });
    return;
  }

  transcriber = null;
  currentModel = null;

  const created = await pipeline('automatic-speech-recognition', model, {
    quantized: true,
    progress_callback: (progress: {
      status: string;
      file?: string;
      progress?: number;
    }) => {
      post({
        type: 'progress',
        status: progress.status,
        file: progress.file,
        progress:
          typeof progress.progress === 'number'
            ? Math.round(progress.progress)
            : undefined,
      });
    },
  });

  transcriber = created as AutomaticSpeechRecognitionPipeline;
  currentModel = model;
  post({ type: 'ready', model });
}

async function transcribe(
  id: number,
  audio: Float32Array,
): Promise<void> {
  if (!transcriber) {
    post({ type: 'error', id, message: 'Model not loaded yet.' });
    return;
  }
  try {
    const output = await transcriber(audio, {
      // Smaller chunks shrink the decoder's peak KV-cache / tensor
      // allocations — important on memory-constrained phones.
      chunk_length_s: 15,
      stride_length_s: 3,
      return_timestamps: false,
    });
    const text = Array.isArray(output)
      ? output.map((o) => o.text).join(' ')
      : output.text;
    post({ type: 'transcript', id, text: text.trim() });
  } catch (err) {
    post({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case 'load':
      void loadModel(message.model).catch((err: unknown) => {
        post({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
      break;
    case 'transcribe':
      void transcribe(message.id, message.audio);
      break;
  }
};

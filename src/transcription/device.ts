/**
 * Device capability detection for picking a Whisper model that won't
 * exhaust the tab's memory budget (older phones get killed by the OS
 * when the WASM heap spikes during transcription).
 */

import { DEFAULT_WHISPER_MODEL, type WhisperModelId } from './transcription-protocol';

/** Model that is roughly half the RAM of Whisper Base. */
export const LOW_MEMORY_MODEL: WhisperModelId = 'Xenova/whisper-tiny.en';

/**
 * Rough heuristic for "this device may not survive Whisper Base on WASM".
 *
 * `navigator.deviceMemory` (GB) is only available on Chromium; Safari and
 * Firefox report `undefined`. Old iPhones are the devices most often killed
 * for memory, so any iPhone/iPad without a deviceMemory signal is treated
 * as low-memory unless it's clearly modern (we can't detect that reliably,
 * so we err on the safe side — tiny is still decent for doorstep audio).
 */
export function isLowMemoryDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };

  if (typeof nav.deviceMemory === 'number') {
    // < 4 GB RAM — Chrome's own "low-end" bucket.
    return nav.deviceMemory < 4;
  }

  // Safari: no deviceMemory. Use hardware concurrency as a weak proxy —
  // older phones have fewer cores (≤4).
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 4) {
    return true;
  }

  // iOS Safari on older phones reports 2–4 cores and no deviceMemory.
  const ua = nav.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua);
  if (isIOS) return true; // be conservative on iPhones — WASM + base model OOMs there.

  return false;
}

/** Pick the model to load on this device. */
export function pickWhisperModel(): WhisperModelId {
  return isLowMemoryDevice() ? LOW_MEMORY_MODEL : DEFAULT_WHISPER_MODEL;
}

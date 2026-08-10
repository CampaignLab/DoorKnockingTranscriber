/**
 * First-run onboarding flow:
 *   1. Welcome + privacy explainer
 *   2. Start downloads (Whisper Base, then Llama 3.2 3B) with progress
 *   3. While downloading, capture the email of the councillor/MP being
 *      campaigned for (validated before continuing)
 *   4. Complete when both models are cached/loaded AND the email is saved
 *
 * Persistent storage is requested up-front so the multi-GB model cache is
 * not evicted by the browser under storage pressure.
 */

import { SessionPipeline } from '../pipeline';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from '../transcription/transcription-protocol';
import { DEFAULT_LLM_MODEL, hasWebGPU } from '../llm/extractor';
import * as db from '../storage/db';
import { el } from './app';

interface OnboardingEvents {
  onComplete: () => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = 'welcome' | 'download';

export class OnboardingView {
  readonly element: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private readonly events: OnboardingEvents;

  private step: Step = 'welcome';

  // Download step nodes
  private whisperBar!: HTMLElement;
  private whisperStatus!: HTMLElement;
  private llmBar!: HTMLElement;
  private llmStatus!: HTMLElement;
  private llmSkipBtn!: HTMLButtonElement;
  private emailInput!: HTMLInputElement;
  private emailError!: HTMLElement;
  private finishBtn!: HTMLButtonElement;
  private overallStatus!: HTMLElement;

  private whisperDone = false;
  private llmDone = false;
  private llmSkipped = false;
  private downloading = false;

  constructor(pipeline: SessionPipeline, events: OnboardingEvents) {
    this.pipeline = pipeline;
    this.events = events;
    this.element = el('section', 'view');
    this.renderWelcome();
  }

  // --- Step 1: welcome ---

  private renderWelcome(): void {
    this.step = 'welcome';
    this.element.replaceChildren();

    const heading = el('h2');
    heading.textContent = 'Welcome to Door Knocking Notes';

    const intro = el('p', 'setup-note');
    intro.textContent =
      'Record doorstep conversations, transcribe them, and extract what matters — voting intention and key issues — entirely on this device. Nothing is ever sent to the cloud.';

    const points = el('ul', 'setup-note');
    for (const text of [
      'The transcription model (~80 MB) downloads once — required.',
      'The insight-extraction model (~2 GB) is optional: skip it and you can still record and transcribe, just without automatic insights. You can download it later in Setup.',
      'After setup, the app works fully offline: everything happens on your phone.',
      'Names, addresses, phone numbers and postcodes are automatically removed from transcripts before anything is stored.',
      'Audio is not kept after transcription by default.',
    ]) {
      const li = el('li');
      li.textContent = text;
      li.style.marginBottom = '6px';
      points.append(li);
    }

    const startBtn = el('button', 'btn');
    startBtn.type = 'button';
    startBtn.textContent = 'Set up my device';
    startBtn.addEventListener('click', () => void this.renderDownload());

    this.element.append(heading, intro, points, startBtn);
  }

  // --- Step 2: download + email capture ---

  private async renderDownload(): Promise<void> {
    this.step = 'download';
    this.element.replaceChildren();

    const heading = el('h2');
    heading.textContent = 'Downloading models';

    this.overallStatus = el('p', 'setup-note');
    this.overallStatus.textContent =
      'Keep this tab open. Models are cached by the browser, so this only happens once.';

    // Whisper block
    const whisperLabel = el('p', 'setup-note');
    whisperLabel.style.marginBottom = '4px';
    whisperLabel.textContent = `Transcription — ${WHISPER_MODELS[DEFAULT_WHISPER_MODEL].label}`;
    this.whisperBar = progressBar();
    this.whisperStatus = el('p', 'setup-note');
    this.whisperStatus.textContent = 'Waiting…';

    // LLM block — optional; the user may skip it.
    const llmLabel = el('p', 'setup-note');
    llmLabel.style.marginBottom = '4px';
    llmLabel.textContent = 'Insight extraction — Llama 3.2 3B (optional, ~2 GB)';
    this.llmBar = progressBar();
    this.llmStatus = el('p', 'setup-note');

    this.llmSkipBtn = el('button', 'btn secondary');
    this.llmSkipBtn.type = 'button';
    this.llmSkipBtn.textContent = 'Skip — transcribe only';
    this.llmSkipBtn.style.display = 'none';
    this.llmSkipBtn.addEventListener('click', () => this.skipLlm());

    if (hasWebGPU()) {
      this.llmStatus.textContent = 'Waiting…';
    } else {
      this.llmStatus.textContent =
        '⚠ WebGPU is unavailable in this browser, so on-device insight ' +
        'extraction is disabled. Recording and transcription still work. ' +
        'To enable it: on iPhone use Safari 18.2+ (Settings → Safari → ' +
        'Advanced → Feature Flags → WebGPU); on Android use recent Chrome.';
      this.llmDone = true; // Nothing to download; don't block completion.
    }

    // Email capture — shown while downloads run.
    const emailHeading = el('h3');
    emailHeading.textContent = 'While that downloads…';

    const emailLabel = el('label', 'setup-note');
    emailLabel.textContent =
      'Email of the councillor or MP you are campaigning for. Session insights will be associated with this campaign.';
    emailLabel.htmlFor = 'campaign-email';

    this.emailInput = document.createElement('input');
    this.emailInput.type = 'email';
    this.emailInput.id = 'campaign-email';
    this.emailInput.placeholder = 'candidate@example.org';
    this.emailInput.autocomplete = 'off';
    this.emailInput.inputMode = 'email';
    this.emailInput.style.cssText =
      'width:100%;padding:14px;border-radius:10px;background:var(--surface);color:var(--text);border:1px solid var(--surface-2);font-size:1rem;';
    this.emailInput.addEventListener('input', () => {
      this.emailError.textContent = '';
      this.updateFinishState();
    });

    this.emailError = el('p', 'setup-note');
    this.emailError.style.color = 'var(--danger)';

    this.finishBtn = el('button', 'btn');
    this.finishBtn.type = 'button';
    this.finishBtn.textContent = 'Finish setup';
    this.finishBtn.disabled = true;
    this.finishBtn.addEventListener('click', () => void this.finish());

    this.element.append(
      heading,
      this.overallStatus,
      whisperLabel,
      this.whisperBar,
      this.whisperStatus,
      llmLabel,
      this.llmBar,
      this.llmStatus,
      this.llmSkipBtn,
      emailHeading,
      emailLabel,
      this.emailInput,
      this.emailError,
      this.finishBtn,
    );

    await this.requestPersistentStorage();
    void this.runDownloads();
  }

  /** Ask the browser not to evict the model caches under storage pressure. */
  private async requestPersistentStorage(): Promise<void> {
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Best-effort only.
    }
  }

  private async runDownloads(): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;

    // 1. Whisper (needed for recording at all).
    try {
      if (this.pipeline.transcriber.isReady) {
        this.whisperDone = true;
        setBar(this.whisperBar, 100);
        this.whisperStatus.textContent = '✓ Already loaded.';
      } else {
        this.whisperStatus.textContent = 'Downloading…';
        await this.pipeline.transcriber.load(DEFAULT_WHISPER_MODEL, (p) => {
          if (p.progress !== undefined) {
            setBar(this.whisperBar, p.progress);
            this.whisperStatus.textContent = `Downloading (${p.progress}%)`;
          }
        });
        this.whisperDone = true;
        setBar(this.whisperBar, 100);
        this.whisperStatus.textContent = '✓ Transcription model ready.';
      }
    } catch (err) {
      this.whisperStatus.textContent = `Failed: ${err instanceof Error ? err.message : String(err)} — check your connection and reload to retry.`;
      this.downloading = false;
      return;
    }

    this.updateFinishState();

    // 2. LLM (optional — only if the user hasn't skipped it).
    if (!this.llmDone && !this.llmSkipped && hasWebGPU()) {
      this.llmSkipBtn.style.display = '';
      try {
        if (this.pipeline.extractor.isReady) {
          this.llmDone = true;
          setBar(this.llmBar, 100);
          this.llmStatus.textContent = '✓ Already loaded.';
        } else {
          this.llmStatus.textContent =
            'Downloading… (large — this is the slow one). Tap “Skip” to transcribe only.';
          await this.pipeline.extractor.load(DEFAULT_LLM_MODEL, (report) => {
            const pct = Math.round((report.progress ?? 0) * 100);
            setBar(this.llmBar, pct);
            this.llmStatus.textContent = `Downloading (${pct}%) — tap “Skip” to transcribe only.`;
          });
          this.llmDone = true;
          setBar(this.llmBar, 100);
          this.llmStatus.textContent = '✓ Insight model ready.';
        }
      } catch (err) {
        if (this.llmSkipped) {
          // Skipped mid-download; extractor.load was abandoned.
          await this.pipeline.extractor.unload();
        } else {
          // Non-fatal: transcription still works; retryable in Setup.
          this.llmDone = true;
          this.llmStatus.textContent = `⚠ LLM download failed (${err instanceof Error ? err.message : String(err)}). You can retry later in Setup.`;
        }
      }
      this.llmSkipBtn.style.display = 'none';
    }

    this.downloading = false;
    this.updateFinishState();
  }

  /** Skip the optional LLM download; extraction stays off until Setup. */
  private skipLlm(): void {
    this.llmSkipped = true;
    this.llmDone = true;
    setBar(this.llmBar, 0);
    this.llmStatus.textContent =
      'Skipped. Sessions will be recorded and transcribed only — you can download the insight model later in Setup.';
    this.llmSkipBtn.style.display = 'none';
    this.updateFinishState();
  }

  private updateFinishState(): void {
    if (this.step !== 'download') return;
    const emailValid = EMAIL_PATTERN.test(this.emailInput.value.trim());
    this.finishBtn.disabled = !(this.whisperDone && this.llmDone && emailValid);
  }

  private async finish(): Promise<void> {
    const email = this.emailInput.value.trim();
    if (!EMAIL_PATTERN.test(email)) {
      this.emailError.textContent = 'Please enter a valid email address.';
      return;
    }

    this.finishBtn.disabled = true;
    this.finishBtn.textContent = 'Saving…';

    await db.putSetting(db.SETTINGS_KEYS.campaignEmail, email);
    await db.putSetting(db.SETTINGS_KEYS.onboarded, 'true');
    await db.putSetting(
      db.SETTINGS_KEYS.llmEnabled,
      this.pipeline.extractor.isReady ? 'true' : 'false',
    );

    this.events.onComplete();
  }
}

function progressBar(): HTMLElement {
  const track = el('div', 'progress-track');
  track.append(el('div', 'progress-fill'));
  return track;
}

function setBar(track: HTMLElement, pct: number): void {
  const fill = track.firstElementChild as HTMLElement | null;
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

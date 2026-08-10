/**
 * Setup screen (post-onboarding): fixed models (Whisper Base + Llama 3.2 3B),
 * reload if needed, model cache status, and campaign email editing.
 */

import { SessionPipeline } from '../pipeline';
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL,
} from '../transcription/transcription-protocol';
import { DEFAULT_LLM_MODEL, hasWebGPU } from '../llm/extractor';
import * as db from '../storage/db';
import { el } from './app';

interface SetupEvents {
  onReady: () => void;
}

export class SetupView {
  readonly element: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private readonly events: SetupEvents;

  private whisperStatus!: HTMLElement;
  private whisperProgress!: HTMLElement;
  private whisperBtn!: HTMLButtonElement;

  private llmStatus!: HTMLElement;
  private llmProgress!: HTMLElement;
  private llmBtn!: HTMLButtonElement;

  private cacheStatus!: HTMLElement;
  private emailInput!: HTMLInputElement;
  private emailStatus!: HTMLElement;

  constructor(pipeline: SessionPipeline, events: SetupEvents) {
    this.pipeline = pipeline;
    this.events = events;
    this.element = this.build();
    this.refresh();
  }

  private build(): HTMLElement {
    const view = el('section', 'view');

    const heading = el('h2');
    heading.textContent = 'Setup';

    // --- Campaign email ---
    const emailHeading = el('h3');
    emailHeading.textContent = 'Campaign';

    const emailLabel = el('label', 'setup-note');
    emailLabel.textContent =
      'Email of the councillor or MP you are campaigning for.';
    emailLabel.htmlFor = 'setup-campaign-email';

    this.emailInput = document.createElement('input');
    this.emailInput.type = 'email';
    this.emailInput.id = 'setup-campaign-email';
    this.emailInput.inputMode = 'email';
    this.emailInput.style.cssText =
      'width:100%;padding:14px;border-radius:10px;background:var(--surface);color:var(--text);border:1px solid var(--surface-2);font-size:1rem;';

    this.emailStatus = el('p', 'setup-note');

    const emailSaveBtn = el('button', 'btn secondary');
    emailSaveBtn.type = 'button';
    emailSaveBtn.textContent = 'Save email';
    emailSaveBtn.addEventListener('click', () => void this.saveEmail());

    // --- Whisper (fixed: Base) ---
    const whisperHeading = el('h3');
    whisperHeading.textContent = `Transcription — ${WHISPER_MODELS[DEFAULT_WHISPER_MODEL].label}`;

    this.whisperBtn = el('button', 'btn secondary');
    this.whisperBtn.type = 'button';
    this.whisperBtn.addEventListener('click', () => void this.loadWhisper());

    this.whisperProgress = progressBar();
    this.whisperStatus = el('p', 'setup-note');

    // --- LLM (fixed: Llama 3.2 3B) ---
    const llmHeading = el('h3');
    llmHeading.textContent = 'Insight extraction — Llama 3.2 3B';

    this.llmBtn = el('button', 'btn secondary');
    this.llmBtn.type = 'button';
    this.llmBtn.addEventListener('click', () => void this.loadLlm());

    this.llmProgress = progressBar();
    this.llmStatus = el('p', 'setup-note');

    if (!hasWebGPU()) {
      this.llmStatus.textContent =
        'WebGPU is not available in this browser — insight extraction is ' +
        'unavailable here, but recording and transcription still work. ' +
        'To enable it: on iPhone use Safari 18.2+ (Settings → Safari → ' +
        'Advanced → Feature Flags → WebGPU); on Android use recent Chrome.';
      this.llmBtn.disabled = true;
    }

    // --- Cache status ---
    const cacheHeading = el('h3');
    cacheHeading.textContent = 'Model storage';
    this.cacheStatus = el('p', 'setup-note');

    const doneBtn = el('button', 'btn secondary');
    doneBtn.type = 'button';
    doneBtn.textContent = 'Back to recording';
    doneBtn.addEventListener('click', () => this.events.onReady());

    view.append(
      heading,
      emailHeading,
      emailLabel,
      this.emailInput,
      emailSaveBtn,
      this.emailStatus,
      whisperHeading,
      this.whisperBtn,
      this.whisperProgress,
      this.whisperStatus,
      llmHeading,
      this.llmBtn,
      this.llmProgress,
      this.llmStatus,
      cacheHeading,
      this.cacheStatus,
      doneBtn,
    );
    return view;
  }

  /** Refresh statuses from current state; called on show. */
  refresh(): void {
    this.whisperBtn.textContent = this.pipeline.transcriber.isReady
      ? 'Reload transcription model'
      : 'Load transcription model';
    this.whisperStatus.textContent = this.pipeline.transcriber.isReady
      ? '✓ Loaded and cached.'
      : 'Not loaded in this session (cached copy will be used if downloaded before).';

    this.llmBtn.textContent = this.pipeline.extractor.isReady
      ? 'Reload LLM'
      : 'Load LLM';
    if (hasWebGPU()) {
      this.llmStatus.textContent = this.pipeline.extractor.isReady
        ? '✓ Loaded and cached.'
        : 'Not loaded in this session (cached copy will be used if downloaded before).';
    }

    void this.loadEmail();
    void this.updateCacheStatus();
  }

  private async loadEmail(): Promise<void> {
    const email = await db.getSetting(db.SETTINGS_KEYS.campaignEmail);
    if (email && !this.emailInput.value) this.emailInput.value = email;
  }

  private async updateCacheStatus(): Promise<void> {
    try {
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      const estimate = await navigator.storage?.estimate?.();
      const usedMb = estimate?.usage
        ? Math.round(estimate.usage / (1024 * 1024))
        : null;
      const parts = [
        persisted
          ? '✓ Persistent storage granted — cached models will not be evicted.'
          : '⚠ Persistent storage not granted — the browser may evict cached models under storage pressure, requiring a re-download.',
      ];
      if (usedMb !== null) {
        parts.push(`${usedMb.toLocaleString()} MB currently stored on this device.`);
      }
      this.cacheStatus.textContent = parts.join(' ');
    } catch {
      this.cacheStatus.textContent = 'Storage status unavailable.';
    }
  }

  private async saveEmail(): Promise<boolean> {
    const email = this.emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.emailStatus.textContent = 'Please enter a valid email address.';
      this.emailStatus.style.color = 'var(--danger)';
      return false;
    }
    await db.putSetting(db.SETTINGS_KEYS.campaignEmail, email);
    this.emailStatus.textContent = '✓ Saved.';
    this.emailStatus.style.color = 'var(--ok)';
    return true;
  }

  private async loadWhisper(): Promise<void> {
    this.whisperBtn.disabled = true;
    setBar(this.whisperProgress, 0);
    this.whisperStatus.textContent = 'Loading…';
    try {
      await this.pipeline.transcriber.load(DEFAULT_WHISPER_MODEL, (p) => {
        if (p.progress !== undefined) {
          setBar(this.whisperProgress, p.progress);
          this.whisperStatus.textContent = `Loading (${p.progress}%)`;
        }
      });
      setBar(this.whisperProgress, 100);
      this.whisperStatus.textContent = '✓ Transcription model loaded.';
      this.whisperBtn.textContent = 'Reload transcription model';
    } catch (err) {
      this.whisperStatus.textContent =
        err instanceof Error ? err.message : 'Failed to load model';
    } finally {
      this.whisperBtn.disabled = false;
      void this.updateCacheStatus();
    }
  }

  private async loadLlm(): Promise<void> {
    this.llmBtn.disabled = true;
    setBar(this.llmProgress, 0);
    this.llmStatus.textContent = 'Loading… (first load is a large download)';
    try {
      await this.pipeline.extractor.load(DEFAULT_LLM_MODEL, (report) => {
        const pct = Math.round((report.progress ?? 0) * 100);
        setBar(this.llmProgress, pct);
        this.llmStatus.textContent = `Loading (${pct}%)`;
      });
      setBar(this.llmProgress, 100);
      this.llmStatus.textContent = '✓ LLM loaded.';
      this.llmBtn.textContent = 'Reload LLM';
    } catch (err) {
      this.llmStatus.textContent =
        err instanceof Error ? err.message : 'Failed to load LLM';
    } finally {
      this.llmBtn.disabled = false;
      void this.updateCacheStatus();
    }
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

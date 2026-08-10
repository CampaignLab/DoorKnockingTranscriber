/**
 * First-run onboarding flow:
 *   1. Welcome + privacy explainer
 *   2. Start Whisper download with progress
 *   3. While downloading, capture the email of the councillor/MP being
 *      campaigned for (validated before continuing)
 *   4. Complete when the model is cached/loaded AND the email is saved
 *
 * Persistent storage is requested up-front so the model cache is not
 * evicted by the browser under storage pressure.
 */

import { SessionPipeline } from '../pipeline';
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from '../transcription/transcription-protocol';
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
  private emailInput!: HTMLInputElement;
  private emailError!: HTMLElement;
  private finishBtn!: HTMLButtonElement;
  private overallStatus!: HTMLElement;

  private whisperDone = false;
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
      'Record doorstep conversations and transcribe them entirely on this device. Nothing is ever sent to the cloud.';

    const points = el('ul', 'setup-note');
    for (const text of [
      'A transcription model will download once (about 80 MB — use Wi-Fi).',
      'After that, the app works fully offline: recording and transcription both happen on your phone.',
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
    heading.textContent = 'Downloading model';

    this.overallStatus = el('p', 'setup-note');
    this.overallStatus.textContent =
      'Keep this tab open. The model is cached by the browser, so this only happens once.';

    // Whisper block
    const whisperLabel = el('p', 'setup-note');
    whisperLabel.style.marginBottom = '4px';
    whisperLabel.textContent = `Transcription — ${WHISPER_MODELS[DEFAULT_WHISPER_MODEL].label}`;
    this.whisperBar = progressBar();
    this.whisperStatus = el('p', 'setup-note');
    this.whisperStatus.textContent = 'Waiting…';

    // Email capture — shown while the download runs.
    const emailHeading = el('h3');
    emailHeading.textContent = 'While that downloads…';

    const emailLabel = el('label', 'setup-note');
    emailLabel.textContent =
      'Email of the councillor or MP you are campaigning for. Sessions will be associated with this campaign.';
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
      emailHeading,
      emailLabel,
      this.emailInput,
      this.emailError,
      this.finishBtn,
    );

    await this.requestPersistentStorage();
    void this.runDownloads();
  }

  /** Ask the browser not to evict the model cache under storage pressure. */
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

    this.downloading = false;
    this.updateFinishState();
  }

  private updateFinishState(): void {
    if (this.step !== 'download') return;
    const emailValid = EMAIL_PATTERN.test(this.emailInput.value.trim());
    this.finishBtn.disabled = !(this.whisperDone && emailValid);
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

/**
 * First-run onboarding flow:
 *   1. Welcome + privacy explainer
 *   2. Download the Whisper model with progress
 *   3. Complete when the model is cached/loaded
 *
 * Persistent storage is requested up-front so the model cache is not
 * evicted by the browser under storage pressure.
 */

import { SessionPipeline } from '../pipeline';
import { DEFAULT_WHISPER_MODEL } from '../transcription/transcription-protocol';
import * as db from '../storage/db';
import { el } from './app';

interface OnboardingEvents {
  onComplete: () => void;
}

export class OnboardingView {
  readonly element: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private readonly events: OnboardingEvents;

  // Download step nodes
  private whisperBar!: HTMLElement;
  private whisperStatus!: HTMLElement;
  private finishBtn!: HTMLButtonElement;
  private overallStatus!: HTMLElement;

  private whisperDone = false;
  private downloading = false;

  constructor(pipeline: SessionPipeline, events: OnboardingEvents) {
    this.pipeline = pipeline;
    this.events = events;
    this.element = el('section', 'view');

    if (this.pipeline.transcriber.isReady) {
      // Model already loaded (e.g. setup finished but the flag was never
      // saved) — skip straight to the record screen.
      void this.finish();
      return;
    }

    this.renderWelcome();
    // Start the download immediately: if a previous setup was interrupted
    // it resumes now, and by the time the user taps “Get started” the
    // progress bar is already moving.
    void this.requestPersistentStorage();
    void this.runDownload();
  }

  // --- Step 1: welcome ---

  private renderWelcome(): void {
    this.element.replaceChildren();

    const heading = el('h2');
    heading.textContent = 'Welcome to Door Knocking Notes';

    const intro = el('p', 'setup-note');
    intro.textContent =
      'This app writes down your doorstep conversations for you. ' +
      'Tap the red button at each door — that is all there is to it.';

    const points = el('ul', 'setup-note');
    for (const text of [
      'Everything stays on this phone. Nothing is ever uploaded.',
      'The recording itself is never kept — only the written note.',
      'When you are done, share all your notes in one message.',
    ]) {
      const li = el('li');
      li.textContent = text;
      li.style.marginBottom = '10px';
      points.append(li);
    }

    const wifi = el('p', 'setup-note');
    wifi.textContent =
      'Set-up needs Wi-Fi and takes a few minutes. It only happens once, ' +
      'and afterwards the app works without any internet at all.';

    const startBtn = el('button', 'btn');
    startBtn.type = 'button';
    startBtn.textContent = 'Get started';
    startBtn.addEventListener('click', () => void this.renderDownload());

    this.element.append(heading, intro, points, wifi, startBtn);
  }

  // --- Step 2: model download ---

  private async renderDownload(): Promise<void> {
    this.element.replaceChildren();

    const heading = el('h2');
    heading.textContent = 'Setting up your device';

    this.overallStatus = el('p', 'setup-note');
    this.overallStatus.textContent =
      'Please keep this page open. This happens once — after today, ' +
      'the app works without any internet at all.';

    this.whisperBar = progressBar();
    this.whisperStatus = el('p', 'setup-note');
    this.whisperStatus.textContent = this.downloading
      ? 'Setting up…'
      : 'Getting ready…';

    this.finishBtn = el('button', 'btn');
    this.finishBtn.type = 'button';
    this.finishBtn.textContent = 'Start using the app';
    this.finishBtn.disabled = true;
    this.finishBtn.addEventListener('click', () => void this.finish());

    this.element.append(
      heading,
      this.overallStatus,
      this.whisperBar,
      this.whisperStatus,
      this.finishBtn,
    );

    // If the download already finished while the welcome screen was up,
    // unlock the button straight away.
    if (this.whisperDone) {
      setBar(this.whisperBar, 100);
      this.whisperStatus.textContent =
        '✓ All ready. Everything stays on this phone.';
      this.finishBtn.disabled = false;
    }
  }

  /** Ask the browser not to evict the model cache under storage pressure. */
  private async requestPersistentStorage(): Promise<void> {
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Best-effort only.
    }
  }

  private async runDownload(): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;

    // The download can start on the welcome screen before the progress
    // bar exists; update it only once the setup screen is showing.
    const updateStatus = (text: string) => {
      if (this.whisperStatus) this.whisperStatus.textContent = text;
    };
    const updateBar = (pct: number) => {
      if (this.whisperBar) setBar(this.whisperBar, pct);
    };

    try {
      if (this.pipeline.transcriber.isReady) {
        this.whisperDone = true;
        updateBar(100);
        updateStatus('✓ All ready.');
      } else {
        updateStatus('Setting up…');
        await this.pipeline.transcriber.load(DEFAULT_WHISPER_MODEL, (p) => {
          if (p.progress !== undefined) {
            updateBar(p.progress);
            updateStatus(`Setting up… ${p.progress}%`);
          }
        });
        this.whisperDone = true;
        updateBar(100);
        updateStatus('✓ All ready. Everything stays on this phone.');
      }
    } catch (err) {
      updateStatus(
        'Set-up did not finish. Please check your Wi-Fi and reload the page to try again.',
      );
      this.downloading = false;
      return;
    }

    this.downloading = false;
    if (this.finishBtn) this.finishBtn.disabled = !this.whisperDone;
  }

  private async finish(): Promise<void> {
    if (this.finishBtn) {
      this.finishBtn.disabled = true;
      this.finishBtn.textContent = 'One moment…';
    }

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
  if (fill)
    fill.style.transform = `scaleX(${Math.min(100, Math.max(0, pct)) / 100})`;
}

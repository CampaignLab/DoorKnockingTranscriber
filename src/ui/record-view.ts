/**
 * Recording screen: big start/stop button, elapsed timer, consent banner,
 * live redacted transcript.
 */

import { SessionPipeline } from '../pipeline';
import { ChunkedRecorder } from '../audio/recorder';
import { el } from './app';

interface RecordViewEvents {
  onSessionEnded: () => void;
  onNeedsSetup: () => void;
}

export class RecordView {
  readonly element: HTMLElement;

  private readonly pipeline: SessionPipeline;
  private readonly events: RecordViewEvents;

  private button!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private timerHandle: number | null = null;
  private startedAt = 0;
  private busy = false;

  constructor(pipeline: SessionPipeline, events: RecordViewEvents) {
    this.pipeline = pipeline;
    this.events = events;
    this.element = this.build();
  }

  private build(): HTMLElement {
    const view = el('section', 'view');

    const area = el('div', 'record-area');

    this.timerEl = el('div', 'record-timer');
    this.timerEl.textContent = '00:00';

    this.button = el('button', 'record-button');
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Start or stop recording');
    this.button.append(el('span', 'dot'));
    this.button.addEventListener('click', () => void this.toggle());

    this.statusEl = el('div', 'record-status');
    this.statusEl.textContent = this.initialStatus();

    area.append(this.timerEl, this.button, this.statusEl);

    const consent = el('div', 'consent-banner');
    consent.textContent =
      'Reminder: tell the resident you are recording, e.g. “Do you mind if I record our chat so I can note down what matters to you? It stays on my device.” Follow the consent rules for your jurisdiction.';

    this.transcriptEl = el('div', 'transcript-live');

    view.append(area, consent, this.transcriptEl);
    return view;
  }

  private initialStatus(): string {
    if (!ChunkedRecorder.isSecureContextForMic()) {
      return (
        '⚠ This page is not on HTTPS, so the browser will block the ' +
        'microphone. Open the app via its HTTPS URL (or deploy it) to record.'
      );
    }
    return this.pipeline.transcriber.isReady
      ? 'Tap to start a doorstep session'
      : 'Load the transcription model in Setup first';
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.button.disabled = true;
    try {
      if (this.pipeline.isRecording) {
        await this.stop();
      } else {
        await this.start();
      }
    } finally {
      this.busy = false;
      this.button.disabled = false;
    }
  }

  private async start(): Promise<void> {
    if (!ChunkedRecorder.isSupported()) {
      this.setStatus('Audio recording is not supported in this browser.');
      return;
    }
    if (!this.pipeline.transcriber.isReady) {
      this.events.onNeedsSetup();
      return;
    }

    try {
      this.transcriptEl.textContent = '';
      await this.pipeline.startSession();
      this.pipelineEventsHook();
      this.startedAt = Date.now();
      this.button.classList.add('recording');
      this.setStatus('Recording…');
      this.timerHandle = window.setInterval(() => this.tick(), 500);
      this.tick();
    } catch (err) {
      this.setStatus(
        err instanceof Error ? err.message : 'Could not start recording',
      );
    }
  }

  private pipelineEventsHook(): void {
    // The pipeline's events were bound at construction; patch transcript
    // updates for the live view here by re-pointing through a lightweight
    // subscription. (Pipeline emits via the shared App handler for errors.)
    const pipeline = this.pipeline as unknown as {
      events: { onTranscriptUpdate?: (id: string, text: string) => void };
    };
    pipeline.events.onTranscriptUpdate = (_id, text) => {
      this.transcriptEl.textContent = text;
      this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    };
  }

  private async stop(): Promise<void> {
    this.button.classList.remove('recording');
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    this.setStatus('Saving session…');
    try {
      await this.pipeline.endSession();
      this.setStatus('Session saved. Tap to start another.');
      this.events.onSessionEnded();
    } catch (err) {
      this.setStatus(
        err instanceof Error ? err.message : 'Failed to save session',
      );
    }
  }

  private tick(): void {
    const elapsed = Math.max(0, Date.now() - this.startedAt);
    const totalSeconds = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    this.timerEl.textContent = `${mm}:${ss}`;
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }
}

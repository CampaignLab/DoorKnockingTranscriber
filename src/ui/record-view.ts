/**
 * Recording screen: big start/stop button, elapsed timer, consent banner,
 * live redacted transcript, and the current session block.
 *
 * Flow: the first recording of the day creates a new session block; each
 * start/stop adds a session to that block. "Finish block" hands off to the
 * share flow, after which the block (and its sessions) is deleted.
 */

import { SessionPipeline } from '../pipeline';
import { ChunkedRecorder } from '../audio/recorder';
import * as db from '../storage/db';
import { el } from './app';

interface RecordViewEvents {
  /** A session was saved; session counts may have changed. */
  onSessionEnded: () => void;
  /** The transcription model is not loaded. */
  onNeedsSetup: () => void;
  /** User asked to see their notes. */
  onOpenNotes: () => void;
  /** User chose to finish the block and share its transcripts. */
  onFinishBlock: (blockId: string) => void;
}

export class RecordView {
  readonly element: HTMLElement;

  private readonly pipeline: SessionPipeline;
  private readonly events: RecordViewEvents;

  private button!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private timerEl!: HTMLElement;
  private promptEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private blockEl!: HTMLElement;
  private finishBlockBtn!: HTMLButtonElement;
  private notesLink!: HTMLButtonElement;
  private timerHandle: number | null = null;
  private startedAt = 0;
  private busy = false;

  /** The block currently being recorded into. */
  private blockId: string | null = null;

  constructor(pipeline: SessionPipeline, events: RecordViewEvents) {
    this.pipeline = pipeline;
    this.events = events;
    this.element = this.build();
  }

  /** Reset after the block has been shared and deleted. */
  resetBlock(): void {
    this.blockId = null;
    void this.refreshBlockStatus();
  }

  /** Called by the shell every time this view is shown. */
  onShown(): void {
    // The status was computed at construction; the model may have finished
    // loading since, so recompute the idle prompt each time.
    if (!this.pipeline.isRecording && !this.busy) {
      this.setStatus(this.initialStatus());
    }
    void this.refreshBlockStatus();
  }

  private build(): HTMLElement {
    const view = el('section', 'view');

    const area = el('div', 'record-area');

    this.timerEl = el('div', 'record-timer');
    this.timerEl.textContent = '';

    this.button = el('button', 'record-button');
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Record');
    this.button.append(el('span', 'dot'));
    this.button.addEventListener('click', () => void this.toggle());

    this.statusEl = el('div', 'record-status');
    this.statusEl.textContent = this.initialStatus();

    area.append(this.timerEl, this.button, this.statusEl);

    // Large prompt shown only while recording.
    this.promptEl = el('div', 'record-prompt');
    this.promptEl.textContent = 'Speak their name and address first';
    this.promptEl.style.display = 'none';

    // The written note, shown only after a recording has been transcribed.
    this.transcriptEl = el('div', 'transcript-live');
    this.transcriptEl.style.display = 'none';

    // Current block status + finish action.
    this.blockEl = el('div', 'block-status');
    this.finishBlockBtn = el('button', 'btn');
    this.finishBlockBtn.type = 'button';
    this.finishBlockBtn.textContent = 'Finish & share my notes';
    this.finishBlockBtn.style.display = 'none';
    this.finishBlockBtn.addEventListener('click', () => {
      if (this.blockId && !this.pipeline.isRecording && !this.busy) {
        this.events.onFinishBlock(this.blockId);
      }
    });

    // The one quiet way to review notes.
    this.notesLink = el('button', 'notes-link');
    this.notesLink.type = 'button';
    this.notesLink.textContent = 'See my notes';
    this.notesLink.style.display = 'none';
    this.notesLink.addEventListener('click', () => this.events.onOpenNotes());

    view.append(
      area,
      this.promptEl,
      this.transcriptEl,
      this.blockEl,
      this.finishBlockBtn,
      this.notesLink,
    );
    void this.refreshBlockStatus();
    return view;
  }

  private initialStatus(): string {
    if (!ChunkedRecorder.isSecureContextForMic()) {
      return (
        'The microphone needs a secure (HTTPS) address to work. ' +
        'Please open the app from its proper web address.'
      );
    }
    return this.pipeline.transcriber.isReady
      ? 'Ready when you are — tap the red button after visiting a house.'
      : 'Still setting up — please close and reopen the app to finish.';
  }

  private async refreshBlockStatus(): Promise<void> {
    if (!this.blockId) {
      this.blockEl.textContent = '';
      this.finishBlockBtn.style.display = 'none';
      this.notesLink.style.display = 'none';
      return;
    }
    const sessions = await db.listSessionsForBlock(this.blockId);
    const done = sessions.filter((s) => s.status === 'transcribed').length;
    if (done === 0) {
      this.blockEl.textContent = '';
      this.finishBlockBtn.style.display = 'none';
      this.notesLink.style.display = 'none';
      return;
    }
    this.blockEl.textContent = `${done} note${done === 1 ? '' : 's'} so far`;
    const idle = !this.pipeline.isRecording;
    this.finishBlockBtn.style.display = idle ? '' : 'none';
    this.notesLink.style.display = idle ? '' : 'none';
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
      // First recording of the day creates the block; the rest join it.
      if (!this.blockId) {
        const block = await db.createBlock();
        this.blockId = block.id;
      }

      await this.pipeline.startSession(this.blockId);
      this.pipelineEventsHook();
      this.startedAt = Date.now();
      this.button.classList.add('recording');
      this.transcriptEl.style.display = 'none';
      this.setStatus('Listening… tap again to stop.');
      this.promptEl.style.display = '';
      this.finishBlockBtn.style.display = 'none';
      this.notesLink.style.display = 'none';
      this.timerHandle = window.setInterval(() => this.tick(), 500);
      this.tick();
    } catch (err) {
      this.setStatus(
        err instanceof Error ? err.message : 'Could not start recording',
      );
    }
  }

  private pipelineEventsHook(): void {
    // Collect the redacted transcript as chunks arrive; the box itself is
    // revealed only after the session has been saved.
    const pipeline = this.pipeline as unknown as {
      events: { onTranscriptUpdate?: (id: string, text: string) => void };
    };
    pipeline.events.onTranscriptUpdate = (_id, text) => {
      this.transcriptEl.textContent = text;
    };
  }

  private async stop(): Promise<void> {
    this.button.classList.remove('recording');
    this.promptEl.style.display = 'none';
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    this.timerEl.textContent = '';
    this.setStatus('Writing it down…');
    try {
      await this.pipeline.endSession();
      this.setStatus('Saved. Tap the red button at the next door.');
      // Show the written note once it exists.
      if (this.transcriptEl.textContent) {
        this.transcriptEl.style.display = '';
      }
      await this.refreshBlockStatus();
      this.events.onSessionEnded();
    } catch (err) {
      this.setStatus(
        err instanceof Error ? err.message : 'Could not save — please try again.',
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

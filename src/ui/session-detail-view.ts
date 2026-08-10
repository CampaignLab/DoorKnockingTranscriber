/**
 * Session detail: transcript and delete action.
 */

import * as db from '../storage/db';
import { el } from './app';

interface DetailEvents {
  onBack: () => void;
  onChanged: () => void;
}

export class SessionDetailView {
  readonly element: HTMLElement;
  private readonly events: DetailEvents;
  private sessionId: string | null = null;

  private statusEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;

  constructor(events: DetailEvents) {
    this.events = events;
    this.element = this.build();
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
    void this.render();
  }

  private build(): HTMLElement {
    const view = el('section', 'view');

    const backBtn = el('button', 'notes-link');
    backBtn.type = 'button';
    backBtn.textContent = '← Back to my notes';
    backBtn.addEventListener('click', () => this.events.onBack());

    this.statusEl = el('div', 'record-status');
    this.statusEl.style.maxWidth = 'none';

    this.transcriptEl = el('div', 'transcript-live');
    this.transcriptEl.style.maxHeight = 'none';
    this.transcriptEl.style.flex = '1';

    this.deleteBtn = el('button', 'btn danger');
    this.deleteBtn.type = 'button';
    this.deleteBtn.textContent = 'Delete this note';
    this.deleteBtn.addEventListener('click', () => void this.remove());

    view.append(backBtn, this.statusEl, this.transcriptEl, this.deleteBtn);
    return view;
  }

  private async render(): Promise<void> {
    if (!this.sessionId) return;

    const [session, transcript] = await Promise.all([
      db.getSession(this.sessionId),
      db.getTranscript(this.sessionId),
    ]);

    if (!session) {
      this.statusEl.textContent = 'This note could not be found.';
      return;
    }

    this.statusEl.textContent = new Date(session.startedAt).toLocaleString(
      undefined,
      { dateStyle: 'full', timeStyle: 'short' },
    );

    this.transcriptEl.textContent =
      transcript?.text || 'Nothing was heard in this recording.';
  }

  private async remove(): Promise<void> {
    if (!this.sessionId) return;
    // Double-tap style confirm: first tap arms, second tap deletes.
    if (this.deleteBtn.dataset.armed === 'true') {
      await db.deleteSession(this.sessionId);
      this.events.onChanged();
      this.events.onBack();
    } else {
      this.deleteBtn.dataset.armed = 'true';
      this.deleteBtn.textContent = 'Tap again to really delete it';
      setTimeout(() => {
        this.deleteBtn.dataset.armed = 'false';
        this.deleteBtn.textContent = 'Delete this note';
      }, 3000);
    }
  }
}

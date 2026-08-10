/**
 * Session detail: redacted transcript and delete action.
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

    const backBtn = el('button', 'btn secondary');
    backBtn.type = 'button';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => this.events.onBack());

    this.statusEl = el('div', 'record-status');

    const transcriptHeading = el('h3');
    transcriptHeading.textContent = 'Transcript (PII removed)';
    this.transcriptEl = el('div', 'transcript-live');

    const actions = el('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';

    this.deleteBtn = el('button', 'btn danger');
    this.deleteBtn.type = 'button';
    this.deleteBtn.textContent = 'Delete session';
    this.deleteBtn.addEventListener('click', () => void this.remove());

    actions.append(this.deleteBtn);

    view.append(
      backBtn,
      this.statusEl,
      transcriptHeading,
      this.transcriptEl,
      actions,
    );
    return view;
  }

  private async render(): Promise<void> {
    if (!this.sessionId) return;

    const [session, transcript] = await Promise.all([
      db.getSession(this.sessionId),
      db.getTranscript(this.sessionId),
    ]);

    if (!session) {
      this.statusEl.textContent = 'Session not found.';
      return;
    }

    this.statusEl.textContent = `${new Date(session.startedAt).toLocaleString()} · ${Math.round(session.durationMs / 1000)}s · ${transcript?.redactionCount ?? 0} redactions`;

    this.transcriptEl.textContent = transcript?.text || '(no speech detected)';
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
      this.deleteBtn.textContent = 'Tap again to confirm delete';
      setTimeout(() => {
        this.deleteBtn.dataset.armed = 'false';
        this.deleteBtn.textContent = 'Delete session';
      }, 3000);
    }
  }
}

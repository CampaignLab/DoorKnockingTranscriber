/**
 * Session list screen: past sessions with status and date.
 */

import * as db from '../storage/db';
import { el } from './app';

interface SessionsViewEvents {
  onOpen: (sessionId: string) => void;
  onBack: () => void;
}

export class SessionsView {
  readonly element: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly events: SessionsViewEvents;

  constructor(events: SessionsViewEvents) {
    this.events = events;
    this.element = el('section', 'view');
    const backBtn = el('button', 'notes-link');
    backBtn.type = 'button';
    backBtn.textContent = '← Back to recording';
    backBtn.addEventListener('click', () => this.events.onBack());
    const heading = el('h2');
    heading.textContent = 'My notes';
    this.listEl = el('ul', 'session-list');
    this.element.append(backBtn, heading, this.listEl);
  }

  async refresh(): Promise<void> {
    const sessions = await db.listSessions();

    this.listEl.replaceChildren();

    if (sessions.length === 0) {
      const empty = el('li');
      empty.textContent = 'Nothing here yet — your notes will appear here.';
      empty.style.color = 'var(--ink-soft)';
      this.listEl.append(empty);
      return;
    }

    for (const session of sessions) {
      const card = el('li', 'session-card');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const meta = el('div', 'meta');
      meta.textContent = new Date(session.startedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

      const summary = el('div', 'summary');
      summary.textContent =
        session.status === 'transcribed'
          ? `${Math.round(session.durationMs / 1000)} seconds`
          : 'Still being written down…';

      card.append(meta, summary);

      const open = () => this.events.onOpen(session.id);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });

      this.listEl.append(card);
    }
  }
}

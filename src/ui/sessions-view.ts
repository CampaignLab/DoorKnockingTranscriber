/**
 * Session list screen: past sessions with status, date and insight tags.
 */

import * as db from '../storage/db';
import type { InsightRecord } from '../storage/db';
import { el } from './app';

interface SessionsViewEvents {
  onOpen: (sessionId: string) => void;
}

export class SessionsView {
  readonly element: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly events: SessionsViewEvents;

  constructor(events: SessionsViewEvents) {
    this.events = events;
    this.element = el('section', 'view');
    const heading = el('h2');
    heading.textContent = 'Sessions';
    this.listEl = el('ul', 'session-list');
    this.element.append(heading, this.listEl);
  }

  async refresh(): Promise<void> {
    const [sessions, insights] = await Promise.all([
      db.listSessions(),
      db.listInsights(),
    ]);
    const insightBySession = new Map<string, InsightRecord>(
      insights.map((i) => [i.sessionId, i]),
    );

    this.listEl.replaceChildren();

    if (sessions.length === 0) {
      const empty = el('li');
      empty.textContent = 'No sessions yet — record your first doorstep chat.';
      empty.style.color = 'var(--muted)';
      this.listEl.append(empty);
      return;
    }

    for (const session of sessions) {
      const card = el('li', 'session-card');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const meta = el('div', 'meta');
      const date = el('span');
      date.textContent = new Date(session.startedAt).toLocaleString();
      const status = el('span', `status-pill ${session.status}`);
      status.textContent = session.status;
      meta.append(date, status);

      const summary = el('div', 'summary');
      const insight = insightBySession.get(session.id);
      summary.textContent = insight?.insight.notes
        ? insight.insight.notes
        : `${Math.round(session.durationMs / 1000)}s recording`;

      card.append(meta, summary);

      if (insight) {
        const tags = el('div', 'tags');
        const party = el('span', 'tag');
        party.textContent = insight.insight.party_support.replace(/_/g, ' ');
        tags.append(party);
        for (const issue of insight.insight.key_issues.slice(0, 4)) {
          const tag = el('span', 'tag');
          tag.textContent = issue.replace(/_/g, ' ');
          tags.append(tag);
        }
        card.append(tags);
      }

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

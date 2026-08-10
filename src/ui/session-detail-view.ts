/**
 * Session detail: redacted transcript, insight card, actions
 * (analyse/re-analyse, delete).
 */

import { SessionPipeline } from '../pipeline';
import * as db from '../storage/db';
import type { Insight } from '../llm/extractor';
import { el } from './app';

interface DetailEvents {
  onBack: () => void;
  onChanged: () => void;
}

export class SessionDetailView {
  readonly element: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private readonly events: DetailEvents;
  private sessionId: string | null = null;

  private statusEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private insightEl!: HTMLElement;
  private analyseBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;

  constructor(pipeline: SessionPipeline, events: DetailEvents) {
    this.pipeline = pipeline;
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

    const insightHeading = el('h3');
    insightHeading.textContent = 'Insights';
    this.insightEl = el('div');

    const actions = el('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';

    this.analyseBtn = el('button', 'btn');
    this.analyseBtn.type = 'button';
    this.analyseBtn.addEventListener('click', () => void this.analyse());

    this.deleteBtn = el('button', 'btn danger');
    this.deleteBtn.type = 'button';
    this.deleteBtn.textContent = 'Delete session';
    this.deleteBtn.addEventListener('click', () => void this.remove());

    actions.append(this.analyseBtn, this.deleteBtn);

    view.append(
      backBtn,
      this.statusEl,
      transcriptHeading,
      this.transcriptEl,
      insightHeading,
      this.insightEl,
      actions,
    );
    return view;
  }

  private async render(): Promise<void> {
    if (!this.sessionId) return;

    const [session, transcript, insight] = await Promise.all([
      db.getSession(this.sessionId),
      db.getTranscript(this.sessionId),
      db.getInsight(this.sessionId),
    ]);

    if (!session) {
      this.statusEl.textContent = 'Session not found.';
      return;
    }

    this.statusEl.textContent = `${new Date(session.startedAt).toLocaleString()} · ${Math.round(session.durationMs / 1000)}s · ${transcript?.redactionCount ?? 0} redactions`;

    this.transcriptEl.textContent = transcript?.text || '(no speech detected)';
    this.renderInsight(insight?.insight ?? null);

    this.analyseBtn.textContent = insight
      ? 'Re-run analysis'
      : this.pipeline.extractor.isReady
        ? 'Analyse now'
        : 'Load LLM in Setup to analyse';
    this.analyseBtn.disabled =
      !this.pipeline.extractor.isReady || !transcript?.text.trim();
  }

  private renderInsight(insight: Insight | null): void {
    this.insightEl.replaceChildren();
    if (!insight) {
      const none = el('p');
      none.textContent = 'No insights extracted yet.';
      none.style.color = 'var(--muted)';
      this.insightEl.append(none);
      return;
    }

    const card = el('div', 'insight-card');
    const rows: [string, string][] = [
      ['Party support', insight.party_support.replace(/_/g, ' ')],
      ['Sentiment', insight.sentiment.replace(/_/g, ' ')],
      [
        'Key issues',
        insight.key_issues.length
          ? insight.key_issues.map((i) => i.replace(/_/g, ' ')).join(', ')
          : '—',
      ],
      ['Follow-up requested', insight.follow_up_requested ? 'Yes' : 'No'],
      ['Notes', insight.notes || '—'],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'row');
      const l = el('span', 'label');
      l.textContent = label;
      const v = el('span');
      v.textContent = value;
      v.style.textAlign = 'right';
      row.append(l, v);
      card.append(row);
    }
    this.insightEl.append(card);
  }

  private async analyse(): Promise<void> {
    if (!this.sessionId || !this.pipeline.extractor.isReady) return;
    this.analyseBtn.disabled = true;
    this.analyseBtn.textContent = 'Analysing…';
    try {
      await this.pipeline.analyseSession(this.sessionId);
      await this.render();
      this.events.onChanged();
    } catch (err) {
      this.analyseBtn.textContent =
        err instanceof Error ? err.message : 'Analysis failed';
      this.analyseBtn.disabled = false;
    }
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

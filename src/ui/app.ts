/**
 * App shell: header with privacy badge, view switching, bottom nav.
 */

import { SessionPipeline } from '../pipeline';
import { RecordView } from './record-view';
import { SessionsView } from './sessions-view';
import { SessionDetailView } from './session-detail-view';
import { SetupView } from './setup-view';
import { OnboardingView } from './onboarding-view';
import { sendSummaryNotification } from '../email/notify';
import * as db from '../storage/db';
import type { Insight } from '../llm/extractor';

type ViewName = 'onboarding' | 'record' | 'sessions' | 'detail' | 'setup';

export class App {
  private readonly root: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private view: ViewName = 'record';

  private header!: HTMLElement;
  private main!: HTMLElement;
  private nav!: HTMLElement;

  private recordView: RecordView;
  private sessionsView: SessionsView;
  private detailView: SessionDetailView;
  private setupView: SetupView;
  private onboardingView: OnboardingView;

  constructor(root: HTMLElement) {
    this.root = root;
    this.pipeline = new SessionPipeline({
      onError: (message) => this.showError(message),
      onInsight: (sessionId, insight) => void this.handleNewInsight(sessionId, insight),
    });

    this.recordView = new RecordView(this.pipeline, {
      onSessionEnded: () => void this.refreshSessions(),
      onNeedsSetup: () => this.show('setup'),
    });
    this.sessionsView = new SessionsView({
      onOpen: (sessionId) => {
        this.detailView.setSession(sessionId);
        this.show('detail');
      },
    });
    this.detailView = new SessionDetailView(this.pipeline, {
      onBack: () => this.show('sessions'),
      onChanged: () => void this.refreshSessions(),
    });
    this.setupView = new SetupView(this.pipeline, {
      onReady: () => this.show('record'),
    });
    this.onboardingView = new OnboardingView(this.pipeline, {
      onComplete: () => this.show('record'),
    });
  }

  async mount(): Promise<void> {
    this.header = el('header', 'app-header');
    const title = el('h1');
    title.textContent = 'Door Knocking Notes';
    const badge = el('span', 'privacy-badge');
    badge.textContent = '100% on-device';
    this.header.append(title, badge);

    this.main = el('main');

    this.nav = el('nav', 'bottom-nav');
    const recordBtn = navButton('● Record', () => this.show('record'));
    const sessionsBtn = navButton('☰ Sessions', () => this.show('sessions'));
    const setupBtn = navButton('⚙ Setup', () => this.show('setup'));
    recordBtn.dataset.view = 'record';
    sessionsBtn.dataset.view = 'sessions';
    setupBtn.dataset.view = 'setup';
    this.nav.append(recordBtn, sessionsBtn, setupBtn);

    this.root.append(this.header, this.main, this.nav);

    // First run: onboarding (model download + campaign email) gates the app.
    const onboarded = await db.getSetting(db.SETTINGS_KEYS.onboarded);
    this.show(onboarded === 'true' ? 'record' : 'onboarding');
  }

  /**
   * Handle a new insight: send email notification if configured
   */
  private async handleNewInsight(sessionId: string, insight: Insight): Promise<void> {
    const notificationEmail = await db.getSetting(db.SETTINGS_KEYS.notificationEmail);
    if (!notificationEmail) return;

    const session = await db.getSession(sessionId);
    if (!session) return;

    const transcript = await db.getTranscript(sessionId);
    const transcriptSummary = transcript?.text
      ? transcript.text.substring(0, 200) + (transcript.text.length > 200 ? '…' : '')
      : undefined;

    const success = await sendSummaryNotification({
      recipientEmail: notificationEmail,
      sessionId,
      session,
      insight,
      transcriptSummary,
    });

    if (!success) {
      console.warn('Failed to send summary notification email');
    }
  }

  show(view: ViewName): void {
    this.view = view;
    this.main.replaceChildren();

    // Onboarding gates the app: hide navigation until it is complete.
    this.nav.style.display = view === 'onboarding' ? 'none' : '';

    for (const btn of Array.from(this.nav.querySelectorAll('button'))) {
      btn.classList.toggle('active', btn.dataset.view === view);
    }

    switch (view) {
      case 'onboarding':
        this.main.append(this.onboardingView.element);
        break;
      case 'record':
        this.main.append(this.recordView.element);
        break;
      case 'sessions':
        void this.refreshSessions();
        this.main.append(this.sessionsView.element);
        break;
      case 'detail':
        this.main.append(this.detailView.element);
        break;
      case 'setup':
        this.setupView.refresh();
        this.main.append(this.setupView.element);
        break;
    }
  }

  private async refreshSessions(): Promise<void> {
    if (this.view === 'sessions') await this.sessionsView.refresh();
  }

  private showError(message: string): void {
    const box = el('div', 'error-box');
    box.textContent = message;
    this.main.prepend(box);
    setTimeout(() => box.remove(), 8000);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function navButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

export { el };

/**
 * App shell: header with privacy badge, view switching, bottom nav.
 */

import { SessionPipeline } from '../pipeline';
import { RecordView } from './record-view';
import { SessionsView } from './sessions-view';
import { SessionDetailView } from './session-detail-view';
import { ShareView } from './share-view';
import { OnboardingView } from './onboarding-view';
import * as db from '../storage/db';

type ViewName = 'onboarding' | 'record' | 'sessions' | 'detail' | 'share';

export class App {
  private readonly root: HTMLElement;
  private readonly pipeline: SessionPipeline;
  private view: ViewName = 'record';

  private main!: HTMLElement;

  private recordView: RecordView;
  private sessionsView: SessionsView;
  private detailView: SessionDetailView;
  private shareView: ShareView;
  private onboardingView: OnboardingView;

  constructor(root: HTMLElement) {
    this.root = root;
    this.pipeline = new SessionPipeline({
      onError: (message) => this.showError(message),
    });

    this.recordView = new RecordView(this.pipeline, {
      onSessionEnded: () => void this.refreshSessions(),
      onNeedsSetup: () => this.show('onboarding'),
      onOpenNotes: () => this.show('sessions'),
      onFinishBlock: (blockId) => {
        void this.shareView.setBlock(blockId);
        this.show('share');
      },
    });
    this.sessionsView = new SessionsView({
      onOpen: (sessionId) => {
        this.detailView.setSession(sessionId);
        this.show('detail');
      },
      onBack: () => this.show('record'),
    });
    this.detailView = new SessionDetailView({
      onBack: () => this.show('sessions'),
      onChanged: () => void this.refreshSessions(),
    });
    this.shareView = new ShareView({
      onDone: () => {
        this.recordView.resetBlock();
        this.show('record');
      },
      onCancel: () => this.show('record'),
    });
    this.onboardingView = new OnboardingView(this.pipeline, {
      onComplete: () => this.show('record'),
    });
  }

  async mount(): Promise<void> {
    this.main = el('main');

    this.root.append(this.main);

    // Gate on the model being ready, not on a flag: if setup was
    // interrupted, the welcome screen is shown again and the download
    // resumes automatically.
    const onboarded = await db.getSetting(db.SETTINGS_KEYS.onboarded);
    this.show(
      onboarded === 'true' && this.pipeline.transcriber.isReady
        ? 'record'
        : 'onboarding',
    );
  }

  show(view: ViewName): void {
    this.view = view;
    this.main.replaceChildren();

    switch (view) {
      case 'onboarding':
        this.main.append(this.onboardingView.element);
        break;
      case 'record':
        this.recordView.onShown();
        this.main.append(this.recordView.element);
        break;
      case 'sessions':
        void this.refreshSessions();
        this.main.append(this.sessionsView.element);
        break;
      case 'detail':
        this.main.append(this.detailView.element);
        break;
      case 'share':
        this.main.append(this.shareView.element);
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

export { el };

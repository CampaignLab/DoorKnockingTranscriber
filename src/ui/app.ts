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
      onProgress: (done, total) => this.recordView.setProgress(done, total),
    });

    this.recordView = new RecordView(this.pipeline, {
      onSessionEnded: () => void this.refreshSessions(),
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

    // Notes are kept until shared, or for one week — wipe anything older.
    await db.purgeExpired();
    // Audio from a session that already produced its note (or whose session
    // is gone entirely) must never survive a restart. Awaited so it settles
    // before we look for sessions worth resuming.
    await db.purgeOrphanAudioChunks();
    // A refresh mid-day must not orphan the block being recorded into.
    await this.recordView.restoreBlock();

    // Gate on the setting alone. The worker is torn down between sessions
    // to free memory, so `transcriber.isReady` is false on almost every
    // launch and gating on it sent returning users back to the welcome
    // screen every time.
    const onboarded = await db.getSetting(db.SETTINGS_KEYS.onboarded);
    this.show(onboarded === 'true' ? 'record' : 'onboarding');

    if (onboarded === 'true') await this.offerResume();
  }

  /**
   * A session whose audio is still buffered was interrupted — the tab was
   * killed, or the app closed mid-write-up. The recording is still here, so
   * offer to finish the note instead of losing it.
   */
  private async offerResume(): Promise<void> {
    const pending = await db.findResumableSessions();
    if (pending.length === 0) return;

    const box = el('div', 'error-box');
    const text = el('p');
    text.textContent =
      pending.length === 1
        ? 'A recording was interrupted before it was written up. It is still here.'
        : `${pending.length} recordings were interrupted before they were written up. They are still here.`;

    const btn = el('button', 'btn');
    btn.type = 'button';
    btn.textContent = 'Finish writing them up';
    btn.addEventListener('click', () => {
      box.remove();
      void this.resumeSessions(pending.map((s) => s.id));
    });

    box.append(text, btn);
    this.main.prepend(box);
  }

  private async resumeSessions(sessionIds: string[]): Promise<void> {
    if (this.view !== 'record') this.show('record');
    for (const sessionId of sessionIds) {
      try {
        await this.recordView.runResumed(sessionId);
      } catch (err) {
        this.showError(
          err instanceof Error
            ? err.message
            : 'That note could not be finished.',
        );
      }
    }
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

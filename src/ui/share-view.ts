/**
 * Share screen: preview the formatted notes for a finished session block,
 * share them via the native share sheet (or copy to clipboard), then delete
 * the block and all of its sessions locally.
 */

import * as db from '../storage/db';
import { el } from './app';

interface ShareViewEvents {
  /** Block shared and deleted — return to a fresh record screen. */
  onDone: () => void;
  /** User backed out without sharing; the block is kept. */
  onCancel: () => void;
}

export class ShareView {
  readonly element: HTMLElement;
  private readonly events: ShareViewEvents;
  private blockId: string | null = null;

  private headingEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private shareBtn!: HTMLButtonElement;
  private copyBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;

  private message = '';

  constructor(events: ShareViewEvents) {
    this.events = events;
    this.element = this.build();
  }

  async setBlock(blockId: string): Promise<void> {
    this.blockId = blockId;
    this.statusEl.textContent = '';
    await this.render();
  }

  private build(): HTMLElement {
    const view = el('section', 'view');

    this.headingEl = el('h2');
    this.headingEl.textContent = 'Share my notes';

    const note = el('p', 'setup-note');
    note.textContent =
      'Here are your notes. Once you share them, they are wiped from this phone — ' +
      'so nothing personal stays behind.';

    this.previewEl = el('div', 'transcript-live');
    this.previewEl.style.maxHeight = '42dvh';

    this.statusEl = el('p', 'setup-note');

    this.shareBtn = el('button', 'btn');
    this.shareBtn.type = 'button';
    this.shareBtn.textContent = 'Share my notes';
    this.shareBtn.addEventListener('click', () => void this.share());

    this.copyBtn = el('button', 'btn secondary');
    this.copyBtn.type = 'button';
    this.copyBtn.textContent = 'Copy instead';
    this.copyBtn.addEventListener('click', () => void this.copy());

    this.cancelBtn = el('button', 'notes-link');
    this.cancelBtn.type = 'button';
    this.cancelBtn.textContent = '← Keep recording';
    this.cancelBtn.addEventListener('click', () => this.events.onCancel());

    view.append(
      this.headingEl,
      note,
      this.previewEl,
      this.statusEl,
      this.shareBtn,
      this.copyBtn,
      this.cancelBtn,
    );
    return view;
  }

  private async render(): Promise<void> {
    if (!this.blockId) return;

    const sessions = (await db.listSessionsForBlock(this.blockId)).filter(
      (s) => s.status === 'transcribed',
    );

    if (sessions.length === 0) {
      this.previewEl.textContent = 'There are no written notes yet.';
      this.shareBtn.disabled = true;
      this.copyBtn.disabled = true;
      return;
    }

    const parts: string[] = [];
    let index = 0;
    for (const session of sessions) {
      index++;
      const transcript = await db.getTranscript(session.id);
      const when = new Date(session.startedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      parts.push(`${index}. ${when}\n${transcript?.text || 'Nothing was heard.'}`);
    }

    this.message = `Door knocking notes — ${sessions.length} conversation${sessions.length === 1 ? '' : 's'}\n\n${parts.join('\n\n')}`;
    this.previewEl.textContent = this.message;
    this.shareBtn.disabled = false;
    this.copyBtn.disabled = false;
  }

  /** Mark the block as handed off and wipe it locally. */
  private async finalize(): Promise<void> {
    if (!this.blockId) return;
    await db.deleteBlock(this.blockId);
    this.blockId = null;
    this.events.onDone();
  }

  private async share(): Promise<void> {
    if (!this.blockId || !this.message) return;
    this.shareBtn.disabled = true;

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Door knocking notes', text: this.message });
        // Share sheet completed (or at least handed off) — wipe locally.
        await this.finalize();
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // User cancelled the sheet — keep the data.
          this.statusEl.textContent =
            'Sharing was cancelled — your notes are still safely on this phone.';
        } else {
          this.statusEl.textContent =
            'Sharing did not work — your notes are still on this phone. Try “Copy instead”.';
        }
        this.shareBtn.disabled = false;
        return;
      }
    }

    // Fallback: no share sheet — copy to clipboard, then delete.
    const copied = await this.copyToClipboard();
    if (copied) {
      await this.finalize();
    } else {
      this.statusEl.textContent =
        'Copying did not work — your notes are still on this phone. You can select the text above by hand.';
      this.shareBtn.disabled = false;
    }
  }

  private async copy(): Promise<void> {
    if (!this.message) return;
    const copied = await this.copyToClipboard();
    this.statusEl.textContent = copied
      ? '✓ Copied. Your notes are still on this phone until you share them.'
      : 'Copying did not work — you can select the text above by hand.';
  }

  private async copyToClipboard(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.message);
      return true;
    } catch {
      return false;
    }
  }
}

import type { AppSession } from '@mentra/sdk';
import { HARD_TIMEOUT_MS } from './config';

function generateBlackBitmap(): string {
  const w = 526, h = 100;
  const rowBytes = w * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padding;
  const pixelDataSize = stride * h;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelDataSize, 34);
  return buf.toString('base64');
}

const BLACK_BITMAP_B64 = generateBlackBitmap();

type DisplayJob = { type: 'text'; text: string; durationMs: number; perPageMs: number }
  | { type: 'status'; text: string; durationMs: number }
  | { type: 'thinking'; userText: string }
  | { type: 'bitmap'; data: string; durationMs: number };

export class DisplayManager {
  private session: AppSession;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private busyUntil = 0;
  private queue: DisplayJob[] = [];

  constructor(session: AppSession) { this.session = session; }

  showWelcome(text: string) {
    this.cancelAll();
    this.session.layouts.showTextWall(text);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), 3000);
  }

  showThinking(userText: string) {
    this.cancelAll();
    this.queue = [];
    this.session.layouts.showReferenceCard(userText, 'Thinking...');
    this.busy = true;
    this.busyUntil = Date.now() + HARD_TIMEOUT_MS;
  }

  showWaiting() {
    this.cancelAll();
    this.session.layouts.showTextWall('Moment...');
    this.busy = true;
    this.busyUntil = Date.now() + HARD_TIMEOUT_MS;
  }

  showReply(answer: string) {
    this.queue = [];
    this._showText(answer, 15000, 8000);
  }

  showNotification(text: string, durationMs = 10000) {
    if (this.busy && Date.now() < this.busyUntil) {
      this.queue.push({ type: 'text', text, durationMs, perPageMs: 8000 });
      return;
    }
    this._showText(text, durationMs, 8000);
  }

  async showBitmap(base64Bmp: string, durationMs = 10000) {
    this.cancelAll();
    await this.session.layouts.showBitmapView(base64Bmp);
    this.busy = true;
    this.busyUntil = Date.now() + durationMs;
    this.hideTimer = setTimeout(async () => {
      try { await this.session.layouts.showBitmapView(BLACK_BITMAP_B64); } catch (e) {}
      setTimeout(() => {
        this.session.layouts.clearView();
        this.busy = false;
        this.processQueue();
      }, 200);
    }, durationMs);
  }

  showStatus(text: string, durationMs = 3000) {
    this.cancelAll();
    this.session.layouts.showTextWall(text);
    this.busy = true;
    this.busyUntil = Date.now() + durationMs;
    this.hideTimer = setTimeout(() => {
      this.session.layouts.clearView();
      this.busy = false;
      this.processQueue();
    }, durationMs);
  }

  setDashboard(text: string) {
    try { this.session.dashboard.content.write(text, ['main']); } catch (e) {}
  }

  showDashboardCard(left: string, right: string) {
    try { this.session.layouts.showDashboardCard(left, right); } catch (e) {}
  }

  private _showText(text: string, singlePageMs: number, perPageMs: number) {
    this.cancelAll();

    const LINE_WIDTH = 40;
    const LINES_PER_PAGE = 4;

    // Word-wrap into lines of ~LINE_WIDTH chars
    const lines: string[] = [];
    for (const rawLine of text.split('\n')) {
      if (rawLine.length === 0) { lines.push(''); continue; }
      let rem = rawLine;
      while (rem.length > 0) {
        if (rem.length <= LINE_WIDTH) { lines.push(rem); break; }
        let cut = rem.lastIndexOf(' ', LINE_WIDTH);
        if (cut < 10) cut = LINE_WIDTH;
        lines.push(rem.substring(0, cut));
        rem = rem.substring(cut).trimStart();
      }
    }

    // Group wrapped lines into pages
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
      chunks.push(lines.slice(i, i + LINES_PER_PAGE).join('\n'));
    }

    if (chunks.length <= 1) {
      this.session.layouts.showTextWall(chunks[0] || text);
      this.busy = true;
      this.busyUntil = Date.now() + singlePageMs;
      this.hideTimer = setTimeout(() => {
        this.session.layouts.clearView();
        this.busy = false;
        this.processQueue();
      }, singlePageMs);
      return;
    }

    const total = chunks.length;
    let current = 0;
    this.busy = true;
    this.busyUntil = Date.now() + (total * perPageMs) + 3000;

    const showNext = () => {
      if (current >= total) {
        this.hideTimer = setTimeout(() => {
          this.session.layouts.clearView();
          this.busy = false;
          this.processQueue();
        }, 3000);
        return;
      }
      const label = `[${current + 1}/${total}] `;
      this.session.layouts.showTextWall(label + chunks[current]);
      current++;
      this.scrollTimer = setTimeout(showNext, perPageMs);
    };

    showNext();
  }

  private processQueue() {
    if (this.queue.length === 0) return;
    const next = this.queue.shift()!;
    switch (next.type) {
      case 'text':
        this._showText(next.text, next.durationMs, next.perPageMs);
        break;
      case 'status':
        this.showStatus(next.text, next.durationMs);
        break;
      case 'bitmap':
        this.showBitmap(next.data, next.durationMs);
        break;
    }
  }

  cancelAndClear() {
    this.cancelAll();
    this.queue = [];
    this.session.layouts.clearView();
  }

  cancelAll() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (this.scrollTimer) { clearTimeout(this.scrollTimer); this.scrollTimer = null; }
    this.busy = false;
  }
}

import { NOTIF_DEDUP_WINDOW_MS } from './config';

export class NotificationDedup {
  private pending = new Map<string, { count: number; lastBody: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private onFlush: (app: string, count: number, lastBody: string) => void) {}

  add(app: string, body: string) {
    const key = app.toLowerCase();
    const existing = this.pending.get(key);

    if (existing) {
      existing.count++;
      existing.lastBody = body;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.pending.delete(key);
        this.onFlush(app, existing.count, existing.lastBody);
      }, NOTIF_DEDUP_WINDOW_MS);
      return;
    }

    this.onFlush(app, 1, body);

    const entry = { count: 0, lastBody: body, timer: setTimeout(() => {
      this.pending.delete(key);
      if (entry.count > 0) {
        this.onFlush(app, entry.count, entry.lastBody);
      }
    }, NOTIF_DEDUP_WINDOW_MS) };

    this.pending.set(key, entry);
  }
}

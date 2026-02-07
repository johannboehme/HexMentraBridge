import { AppServer, AppSession } from '@mentra/sdk';
import { WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME not set'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY not set'); })();
const PORT = parseInt(process.env.PORT || '3000');
const PUSH_PORT = parseInt(process.env.PUSH_PORT || '3001');
const PUSH_BIND = process.env.PUSH_BIND || '127.0.0.1';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';  // Optional auth token for external access
const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://localhost:18789';
const OPENCLAW_GW_TOKEN = process.env.OPENCLAW_GW_TOKEN || '';

// Notification blocklist: comma-separated app names (case-insensitive)
const NOTIF_BLOCKLIST = (process.env.NOTIF_BLOCKLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const G1_PREFIX = '⚠️ G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!\n\n';

// Generate a minimal black 526x100 24-bit BMP as base64 for clearing green line artifacts
function generateBlackBitmap(): string {
  const w = 526, h = 100;
  const rowBytes = w * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padding;
  const pixelDataSize = stride * h;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  // BMP header
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  // DIB header
  buf.writeUInt32LE(40, 14); // header size
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);  // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(pixelDataSize, 34);
  // All pixel data stays 0 (black) — Buffer.alloc zero-fills
  return buf.toString('base64');
}
const BLACK_BITMAP_B64 = generateBlackBitmap();
const G1_COPILOT_PREFIX = '⚠️ G1 COPILOT MODE: The user is having a conversation nearby. You are listening silently. Do NOT respond directly. Instead, provide 1-2 short contextual hints, facts, or suggestions that might help the user. No markdown, no emojis. Ultra short.\n\nOverheard: ';
const SOFT_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 300_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const HEAD_HOLD_MS = 5_000;
const NOTIF_DEDUP_WINDOW_MS = 10_000;

// ─── Helpers ───

function formatAgo(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// ─── OpenClaw Gateway WebSocket Client (with auto-reconnect) ───

class OpenClawClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private runListeners = new Map<string, (text: string) => void>();
  private _pendingRunCallbacks: Array<(text: string) => void> = [];  // FIFO queue for matching run callbacks
  private reconnectDelay = RECONNECT_DELAY_MS;
  private shouldReconnect = true;

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return this._connect();
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(OPENCLAW_WS_URL);
      } catch (err: any) {
        console.error('[OpenClaw] WS create error:', err.message);
        this.scheduleReconnect();
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        const connId = this.nextId();
        this.send({
          type: 'req', id: connId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'gateway-client', displayName: 'G1 Bridge', version: '0.8.1', platform: 'linux', mode: 'cli' },
            auth: { token: OPENCLAW_GW_TOKEN },
          },
        });
        const handler = (data: any) => {
          const msg = JSON.parse(String(data));
          if (msg.type === 'res' && msg.id === connId) {
            if (msg.ok) {
              this.connected = true;
              this.reconnectDelay = RECONNECT_DELAY_MS;
              console.log('[OpenClaw] Connected');
              resolve();
            } else {
              reject(new Error(`Connect failed: ${JSON.stringify(msg.error)}`));
            }
            this.ws!.removeListener('message', handler);
          }
        };
        this.ws!.on('message', handler);
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data));

        if (msg.type === 'res' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.payload);
          else p.reject(new Error(JSON.stringify(msg.error)));
        }

        if (msg.type === 'event' && msg.event === 'chat') {
          const pl = msg.payload;
          if (pl?.state === 'final' && pl?.message?.role === 'assistant') {
            const content = pl.message.content;
            let text = '';
            if (Array.isArray(content)) text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
            else if (typeof content === 'string') text = content;
            console.log(`[OpenClaw] chat final: runId=${pl.runId} text="${(text||'').substring(0,60)}" hasListener=${pl.runId ? this.runListeners.has(pl.runId) : 'no-runId'} pendingCbs=${this._pendingRunCallbacks.length} listeners=${this.runListeners.size}`);
            if (text && pl.runId) {
              const cb = this.runListeners.get(pl.runId);
              if (cb) { this.runListeners.delete(pl.runId); cb(text); }
            }
          }
        }

        if (msg.type === 'event' && msg.event === 'agent') {
          const pl = msg.payload;
          if (pl?.stream === 'lifecycle') {
            console.log(`[OpenClaw] agent lifecycle: phase=${pl?.data?.phase} runId=${pl?.runId} pendingCbs=${this._pendingRunCallbacks.length}`);
          }
          if (pl?.stream === 'lifecycle' && pl?.data?.phase === 'start' && pl?.runId && this._pendingRunCallbacks.length > 0) {
            const cb = this._pendingRunCallbacks.shift()!;
            this.runListeners.set(pl.runId, cb);
            console.log(`[OpenClaw] matched runId=${pl.runId} → listener (remaining pendingCbs=${this._pendingRunCallbacks.length})`);
          }
          // If run ended but we never got a chat event, resolve with empty (NO_REPLY)
          if (pl?.stream === 'lifecycle' && pl?.data?.phase === 'end' && pl?.runId && this.runListeners.has(pl.runId)) {
            // Give chat event 2s to arrive (it sometimes comes slightly after phase:end)
            const endRunId = pl.runId;
            setTimeout(() => {
              const cb = this.runListeners.get(endRunId);
              if (cb) {
                console.log(`[OpenClaw] phase:end cleanup — no chat event for runId=${endRunId}, resolving as empty`);
                this.runListeners.delete(endRunId);
                cb('');
              }
            }, 2000);
          }
        }
      });

      this.ws.on('error', (err) => {
        console.error('[OpenClaw] WS error:', err.message);
      });

      this.ws.on('close', () => {
        console.log('[OpenClaw] WS closed');
        this.connected = false;
        for (const [id, p] of this.pending) {
          p.reject(new Error('WS closed'));
        }
        this.pending.clear();
        this._pendingRunCallbacks = [];
        this.runListeners.clear();
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    console.log(`[OpenClaw] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this._connect().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private nextId() { return `g1-${++this.reqId}`; }
  private send(msg: any) { this.ws?.send(JSON.stringify(msg)); }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Not connected')); return; }
      const id = this.nextId();
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'req', id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Request timeout')); } }, 60000);
    });
  }

  async chat(message: string, prefix: string, onSoftTimeout?: () => void): Promise<string> {
    if (!this.connected) return 'Hex offline — reconnecting...';
    return new Promise(async (resolve) => {
      let resolved = false;
      const done = (text: string) => { if (!resolved) { resolved = true; resolve(text); } };
      const cb = (text: string) => done(text);
      this._pendingRunCallbacks.push(cb);
      try {
        await this.request('chat.send', {
          message: prefix + message,
          sessionKey: 'agent:main:main',
          idempotencyKey: `g1-${Date.now()}`,
        });
      } catch (err: any) {
        console.error('[OpenClaw] chat.send failed:', err.message);
        // Remove our callback from the queue
        const idx = this._pendingRunCallbacks.indexOf(cb);
        if (idx >= 0) this._pendingRunCallbacks.splice(idx, 1);
        done('Failed to reach Hex');
        return;
      }
      setTimeout(() => { if (!resolved) { onSoftTimeout?.(); } }, SOFT_TIMEOUT_MS);
      setTimeout(() => {
        if (!resolved) {
          // Remove our callback from the queue if still there
          const idx = this._pendingRunCallbacks.indexOf(cb);
          if (idx >= 0) this._pendingRunCallbacks.splice(idx, 1);
          done('Hex braucht zu lange.');
        }
      }, HARD_TIMEOUT_MS);
    });
  }

  /** Cancel all pending run callbacks (used when copilot debounce supersedes old requests) */
  cancelPendingRuns() {
    for (const cb of this._pendingRunCallbacks) {
      cb('');  // resolve with empty → treated as NO_REPLY
    }
    this._pendingRunCallbacks = [];
    // Also cancel any already-matched run listeners
    for (const [runId, cb] of this.runListeners) {
      cb('');
    }
    this.runListeners.clear();
  }

  async sendRaw(message: string): Promise<void> {
    await this.request('chat.send', {
      message,
      sessionKey: 'agent:main:main',
      idempotencyKey: `g1-${Date.now()}`,
    });
  }

  isConnected() { return this.connected; }
}

const openclawClient = new OpenClawClient();

// ─── Display Manager (with queue) ───

type DisplayJob = { type: 'text'; text: string; durationMs: number; perPageMs: number }
  | { type: 'status'; text: string; durationMs: number }
  | { type: 'thinking'; userText: string }
  | { type: 'bitmap'; data: string; durationMs: number };

class DisplayManager {
  private session: AppSession;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private busyUntil = 0;
  private queue: DisplayJob[] = [];

  constructor(session: AppSession) { this.session = session; }

  // ─── Public API ───

  showWelcome(text: string) {
    this.cancelAll();
    this.session.layouts.showTextWall(text);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), 3000);
  }

  showThinking(userText: string) {
    this.cancelAll();
    this.queue = []; // Clear pending notifications — user interaction takes priority
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
    this.queue = []; // Clear pending notifications — reply takes priority
    this._showText(answer, 15000, 8000);
  }

  showNotification(text: string, durationMs = 10000) {
    if (this.busy && Date.now() < this.busyUntil) {
      // Queue it — will show after current display finishes
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
      // Push a black bitmap to clear green line artifact before clearView
      try { await this.session.layouts.showBitmapView(BLACK_BITMAP_B64); } catch (e) {}
      setTimeout(() => {
        this.session.layouts.clearView();
        this.busy = false;
        this.processQueue();
      }, 200);
    }, durationMs);
  }

  showStatus(text: string, durationMs = 3000) {
    // Status messages are brief and don't queue
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

  // ─── Internal ───

  private _showText(text: string, singlePageMs: number, perPageMs: number) {
    this.cancelAll();

    const CHUNK_SIZE = 180;
    if (text.length <= CHUNK_SIZE) {
      this.session.layouts.showTextWall(text);
      this.busy = true;
      this.busyUntil = Date.now() + singlePageMs;
      this.hideTimer = setTimeout(() => {
        this.session.layouts.clearView();
        this.busy = false;
        this.processQueue();
      }, singlePageMs);
      return;
    }

    // Split into chunks at word boundaries
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= CHUNK_SIZE) {
        chunks.push(remaining);
        break;
      }
      let cut = remaining.lastIndexOf(' ', CHUNK_SIZE);
      if (cut < 100) cut = CHUNK_SIZE;
      chunks.push(remaining.substring(0, cut));
      remaining = remaining.substring(cut).trimStart();
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

  private cancelAll() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (this.scrollTimer) { clearTimeout(this.scrollTimer); this.scrollTimer = null; }
    this.busy = false;
  }
}

// ─── Notification Deduplicator ───

class NotificationDedup {
  private pending = new Map<string, { count: number; lastBody: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private onFlush: (app: string, count: number, lastBody: string) => void) {}

  add(app: string, body: string) {
    const key = app.toLowerCase();
    const existing = this.pending.get(key);

    if (existing) {
      // More notifications from same app within window — just count
      existing.count++;
      existing.lastBody = body;
      // Reset timer so we batch everything within the window
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.pending.delete(key);
        this.onFlush(app, existing.count, existing.lastBody);
      }, NOTIF_DEDUP_WINDOW_MS);
      return;
    }

    // First notification — show immediately
    this.onFlush(app, 1, body);

    // Start dedup window for subsequent notifications from same app
    const entry = { count: 0, lastBody: body, timer: setTimeout(() => {
      this.pending.delete(key);
      if (entry.count > 0) {
        this.onFlush(app, entry.count, entry.lastBody);
      }
    }, NOTIF_DEDUP_WINDOW_MS) };

    this.pending.set(key, entry);
  }
}

// Active sessions for push + mic control + debug status
type SessionHandle = {
  display: DisplayManager;
  toggleMic: () => void;
  getMicState: () => boolean;
  toggleCopilot: () => boolean;  // returns new state
  getCopilotState: () => boolean;
  getDebugStatus: () => {
    lastTranscriptAt: number | null;
    lastTranscriptText: string;
    copilotQueueSize: number;
    copilotInflight: boolean;
    listening: boolean;
    copilot: boolean;
  };
};
const activeSessions = new Map<string, SessionHandle>();

// ─── Push HTTP API ───

function startPushServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check for external access (skip for localhost when no token set)
    if (PUSH_TOKEN) {
      const auth = req.headers['authorization'] || '';
      let urlToken: string | null = null;
      try { urlToken = new URL(req.url || '/', `http://localhost`).searchParams.get('token'); } catch (e) {}
      if (auth !== `Bearer ${PUSH_TOKEN}` && urlToken !== PUSH_TOKEN) {
        res.writeHead(401); res.end('{"error":"unauthorized"}');
        return;
      }
    }

    const path = (req.url || '/').split('?')[0];

    if (req.method === 'POST' && path === '/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { text, duration = 10000 } = JSON.parse(body);
          if (!text) { res.writeHead(400); res.end('{"error":"text required"}'); return; }
          let sent = 0;
          for (const [id, h] of activeSessions) { h.display.showNotification(text, duration); sent++; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
      });
      return;
    }

    if (req.method === 'POST' && path === '/push-bitmap') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const { bitmap, duration = 10000 } = JSON.parse(body);
          if (!bitmap) { res.writeHead(400); res.end('{"error":"bitmap required"}'); return; }
          let sent = 0;
          for (const [id, h] of activeSessions) {
            try { await h.display.showBitmap(bitmap, duration); sent++; } catch (e) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e: any) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    if (req.method === 'POST' && path === '/mic') {
      // Toggle mic on all active sessions — for WearOS/Tasker trigger
      let toggled = 0;
      let micState = false;
      for (const [id, h] of activeSessions) {
        h.toggleMic();
        micState = h.getMicState();
        toggled++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: toggled, listening: micState }));
      return;
    }

    if (req.method === 'GET' && path === '/mic') {
      // Get mic state
      let micState = false;
      for (const [id, h] of activeSessions) { micState = h.getMicState(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: activeSessions.size, listening: micState }));
      return;
    }

    if (req.method === 'POST' && path === '/copilot') {
      // Toggle copilot mode on all active sessions — for WearOS/Tasker trigger
      let toggled = 0;
      let copilotState = false;
      for (const [id, h] of activeSessions) {
        copilotState = h.toggleCopilot();
        toggled++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: toggled, copilot: copilotState }));
      return;
    }

    if (req.method === 'GET' && path === '/copilot') {
      // Get copilot state
      let copilotState = false;
      for (const [id, h] of activeSessions) { copilotState = h.getCopilotState(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: activeSessions.size, copilot: copilotState }));
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      let micState = false;
      let copilotState = false;
      for (const [id, h] of activeSessions) { micState = h.getMicState(); copilotState = h.getCopilotState(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openclaw: openclawClient.isConnected(),
        sessions: activeSessions.size,
        sessionIds: [...activeSessions.keys()],
        listening: micState,
        copilot: copilotState,
      }));
      return;
    }

    if (req.method === 'GET' && path === '/debug') {
      // Debug endpoint: per-session transcript & queue status
      const sessions: Record<string, any> = {};
      for (const [id, h] of activeSessions) {
        const s = h.getDebugStatus();
        const agoSec = s.lastTranscriptAt ? Math.round((Date.now() - s.lastTranscriptAt) / 1000) : null;

        // Progress: queue fill (each item = 20%, caps at 100)
        // Inflight counts as 1 item too
        let progress = 0;
        if (s.copilotInflight) progress = Math.min((1 + s.copilotQueueSize) * 20, 100);
        else if (s.copilotQueueSize > 0) progress = Math.min(s.copilotQueueSize * 20, 100);

        sessions[id] = {
          listening: s.listening,
          copilot: s.copilot,
          lastTranscriptAt: s.lastTranscriptAt,
          lastTranscriptAgo: agoSec !== null ? formatAgo(agoSec) : null,
          lastTranscriptText: s.lastTranscriptText || null,
          copilotQueueSize: s.copilotQueueSize,
          copilotInflight: s.copilotInflight,
          progress,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openclaw: openclawClient.isConnected(),
        totalSessions: activeSessions.size,
        sessions,
      }));
      return;
    }

    res.writeHead(404); res.end('Not found');
  });
  server.listen(PUSH_PORT, PUSH_BIND, () => console.log(`[Push] API on http://${PUSH_BIND}:${PUSH_PORT}${PUSH_TOKEN ? ' (auth required)' : ''}`));
}

// ─── Bridge App ───

class G1OpenClawBridge extends AppServer {
  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[${sessionId}] Connected: ${userId}`);

    const display = new DisplayManager(session);
    display.showWelcome(openclawClient.isConnected() ? 'Hex connected.' : 'Hex offline.');
    display.setDashboard('Hex: Ready');

    // ─── State ───
    let listening = false;
    let copilotMode = false;
    let copilotBuffer: string[] = [];
    let copilotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let copilotInflight = false;
    const COPILOT_DEBOUNCE_MS = 3_000;  // Batch transcripts over 3s window
    let unsubTranscription: (() => void) | null = null;
    let resubAttempts = 0;
    let lastTranscriptAt: number | null = null;
    let lastTranscriptText = '';

    const COPILOT_TIMEOUT_MS = 60_000;  // 60s max for copilot responses

    // Copilot batch processor — serializes requests, never drops buffered text
    const sendCopilotBatch = async () => {
      if (copilotBuffer.length === 0) return;
      if (copilotInflight) {
        console.log(`[${sessionId}] Copilot: deferring batch (in-flight request)`);
        return;
      }

      const batch = copilotBuffer.join(' ');
      copilotBuffer = [];

      copilotInflight = true;

      // Safety timeout — if chat() never resolves, force-unlock after 60s
      const safetyTimer = setTimeout(() => {
        if (copilotInflight) {
          console.log(`[${sessionId}] Copilot: safety timeout (${COPILOT_TIMEOUT_MS / 1000}s)`);
          copilotInflight = false;
          openclawClient.cancelPendingRuns();
          drainBuffer();
        }
      }, COPILOT_TIMEOUT_MS);

      try {
        const reply = await openclawClient.chat(batch, G1_COPILOT_PREFIX);
        clearTimeout(safetyTimer);
        const t = reply ? reply.trim() : '';
        const skip = !t || /^NO[_]?R?E?P?L?Y?$/i.test(t) || t.startsWith('NO_REPLY') || t.startsWith('NO_RE');
        if (t && !skip) {
          console.log(`[${sessionId}] Copilot hint: "${t.substring(0, 80)}"`);
          display.showReply(t);
        } else {
          console.log(`[${sessionId}] Copilot: nothing to show`);
        }
      } catch (e: any) {
        clearTimeout(safetyTimer);
        console.error(`[${sessionId}] Copilot error: ${e.message}`);
      } finally {
        copilotInflight = false;
        drainBuffer();
      }
    };

    const drainBuffer = () => {
      if (copilotBuffer.length > 0 && copilotMode) {
        console.log(`[${sessionId}] Copilot: draining ${copilotBuffer.length} buffered items`);
        if (copilotDebounceTimer) clearTimeout(copilotDebounceTimer);
        copilotDebounceTimer = setTimeout(() => {
          copilotDebounceTimer = null;
          sendCopilotBatch();
        }, 1_000);
      }
    };
    let resubTimer: ReturnType<typeof setTimeout> | null = null;
    const RESUB_BASE_DELAY_MS = 3_000;     // Start with 3s
    const MAX_RESUB_DELAY_MS = 120_000;    // Max 2min between retries

    // ─── Transcription Handler ───
    const handleTranscription = async (data: any) => {
      if (!data.isFinal) return;
      const userText = data.text.trim();
      if (!userText) return;

      // Track for debug status
      lastTranscriptAt = Date.now();
      lastTranscriptText = userText;

      const lower = userText.toLowerCase();

      // Voice commands (work in any mode)
      if (lower.includes('neue session') || lower.includes('new session')) {
        console.log(`[${sessionId}] Session reset`);
        display.showStatus('New session...', 3000);
        try { await openclawClient.sendRaw('/new'); } catch (e) {}
        display.showStatus('Session reset.', 3000);
        return;
      }

      // Copilot toggle — must match strict patterns only
      const normalized = lower.replace(/[-]/g, '').replace(/[.,!?]/g, '').trim();
      const copilotPatterns = [
        'copilot modus', 'copilot mode',
        'copilot an', 'copilot aus',
        'copilot on', 'copilot off',
        'copilotmodus',
      ];
      if (copilotPatterns.some(p => normalized === p)) {
        copilotMode = !copilotMode;
        const state = copilotMode ? 'Copilot ON' : 'Copilot OFF';
        console.log(`[${sessionId}] ${state}`);
        // Clear copilot state on toggle
        if (copilotDebounceTimer) { clearTimeout(copilotDebounceTimer); copilotDebounceTimer = null; }
        copilotBuffer = [];
        display.showStatus(state, 3000);
        updateDashboard();
        return;
      }

      // Copilot mode: debounce transcripts, then send batched
      if (copilotMode) {
        console.log(`[${sessionId}] Copilot heard: "${userText}"`);
        copilotBuffer.push(userText);

        // Reset debounce timer — wait for a pause in speech
        if (copilotDebounceTimer) clearTimeout(copilotDebounceTimer);
        copilotDebounceTimer = setTimeout(() => {
          copilotDebounceTimer = null;
          sendCopilotBatch();
        }, COPILOT_DEBOUNCE_MS);
        return;
      }

      // Normal mode
      console.log(`[${sessionId}] User: "${userText}"`);
      display.showThinking(userText);

      const reply = await openclawClient.chat(
        userText, G1_PREFIX,
        () => display.showWaiting()
      );

      const trimmed = reply ? reply.trim() : '';
      const isNoReply = !trimmed || /^NO[_]?R?E?P?L?Y?$/i.test(trimmed) || trimmed.startsWith('NO_REPLY') || trimmed.startsWith('NO_RE');
      if (trimmed && !isNoReply) {
        console.log(`[${sessionId}] Hex: "${reply.substring(0, 80)}"`);
        display.showReply(reply);
      } else {
        console.log(`[${sessionId}] Hex: silent (NO_REPLY)`);
        display.showStatus('', 100); // Clear the "Thinking..." display
      }
    };

    // ─── Transcription Subscribe with auto-resubscribe on error ───
    const subscribeTranscription = () => {
      if (unsubTranscription) {
        try { unsubTranscription(); } catch (e) {}
        unsubTranscription = null;
      }

      try {
        unsubTranscription = session.events.onTranscription(handleTranscription, {
          onError: (err: any) => {
            console.error(`[${sessionId}] Transcription stream error:`, err?.message || err);
            scheduleResub();
          },
          onEnd: () => {
            console.log(`[${sessionId}] Transcription stream ended unexpectedly`);
            scheduleResub();
          },
        } as any);
      } catch (e: any) {
        // If onTranscription doesn't support error callbacks, use basic subscribe
        console.log(`[${sessionId}] Transcription subscribe (basic mode)`);
        unsubTranscription = session.events.onTranscription(handleTranscription);
      }

      resubAttempts = 0;
      console.log(`[${sessionId}] Transcription subscribed`);
    };

    const scheduleResub = () => {
      if (!listening) return;
      if (resubTimer) return; // Already scheduled

      resubAttempts++;
      const delay = Math.min(RESUB_BASE_DELAY_MS * Math.pow(2, resubAttempts - 1), MAX_RESUB_DELAY_MS);
      console.log(`[${sessionId}] Resubscribing in ${Math.round(delay / 1000)}s (attempt ${resubAttempts})`);

      resubTimer = setTimeout(() => {
        resubTimer = null;
        if (!listening) return;
        console.log(`[${sessionId}] Resubscribing transcription...`);
        display.showStatus('Reconnecting mic...', 2000);
        subscribeTranscription();
      }, delay);
    };

    const cancelResub = () => {
      if (resubTimer) { clearTimeout(resubTimer); resubTimer = null; }
      resubAttempts = 0;
    };

    // ─── Start/Stop Listening ───
    const startListening = () => {
      if (listening) return;
      listening = true;
      console.log(`[${sessionId}] Mic ON`);
      display.showStatus('Listening...', 2000);
      updateDashboard();
      subscribeTranscription();
    };

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      console.log(`[${sessionId}] Mic OFF`);
      cancelResub();
      if (unsubTranscription) { try { unsubTranscription(); } catch (e) {} unsubTranscription = null; }
      display.showStatus('Mic off.', 2000);
      updateDashboard();
    };

    const toggleMic = () => {
      if (listening) stopListening();
      else startListening();
    };

    // Register session for HTTP API access
    activeSessions.set(sessionId, {
      display,
      toggleMic,
      getMicState: () => listening,
      toggleCopilot: () => {
        copilotMode = !copilotMode;
        const state = copilotMode ? 'Copilot ON' : 'Copilot OFF';
        console.log(`[${sessionId}] ${state} (via API)`);
        if (copilotDebounceTimer) { clearTimeout(copilotDebounceTimer); copilotDebounceTimer = null; }
        copilotBuffer = [];
        display.showStatus(state, 3000);
        updateDashboard();
        return copilotMode;
      },
      getCopilotState: () => copilotMode,
      getDebugStatus: () => ({
        lastTranscriptAt,
        lastTranscriptText,
        copilotQueueSize: copilotBuffer.length,
        copilotInflight,
        listening,
        copilot: copilotMode,
      }),
    });

    // ─── Phone Notifications (with dedup + blocklist + queue) ───
    const notifDedup = new NotificationDedup((app, count, lastBody) => {
      if (count === 1) {
        display.showNotification(`${app}\n${lastBody}`, 10000);
      } else {
        display.showNotification(`${app} (${count} new)\n${lastBody}`, 10000);
      }
    });

    session.events.onPhoneNotifications((data: any) => {
      const app = data.app || 'Notification';

      // Blocklist check
      if (NOTIF_BLOCKLIST.includes(app.toLowerCase())) {
        console.log(`[${sessionId}] NOTIF BLOCKED: ${app}`);
        return;
      }

      const title = data.title || '';
      const content = data.content || '';
      let body = title && content ? `${title}: ${content}` : (title || content);
      if (body.length > 200) {
        const cut = body.lastIndexOf(' ', 200);
        body = body.substring(0, cut > 80 ? cut : 200) + '...';
      }

      console.log(`[${sessionId}] NOTIF: ${app} — ${body}`);
      notifDedup.add(app, body);
    });

    // ─── Head-Up Toggle (6s hold) ───
    let headUpSince: number | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    session.events.onHeadPosition((data: any) => {
      if (data.position === 'up') {
        headUpSince = Date.now();
        holdTimer = setTimeout(() => {
          if (headUpSince) {
            console.log(`[${sessionId}] Head-up 5s → toggle`);
            toggleMic();
          }
          headUpSince = null;
        }, HEAD_HOLD_MS);
      } else if (data.position === 'down') {
        headUpSince = null;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      }
    });

    // ─── Dashboard ───
    const updateDashboard = () => {
      const status = copilotMode ? 'Hex: Copilot' : (listening ? 'Hex: Listening...' : 'Hex: Ready');
      display.setDashboard(status);
    };
    updateDashboard();

    console.log(`[${sessionId}] Ready. Look up 6s to toggle mic.`);
    if (NOTIF_BLOCKLIST.length > 0) {
      console.log(`[${sessionId}] Notification blocklist: ${NOTIF_BLOCKLIST.join(', ')}`);
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    activeSessions.delete(sessionId);
    // Note: watchdog cleanup happens naturally since the session is gone
    console.log(`[${sessionId}] Ended: ${reason}`);
  }
}

// ─── Main ───

async function main() {
  console.log('G1-OpenClaw Bridge v0.8.1');
  console.log(`  MentraOS: ${PACKAGE_NAME}`);
  console.log(`  OpenClaw: ${OPENCLAW_WS_URL}`);
  console.log(`  Ports: ${PORT} (MentraOS), ${PUSH_PORT} (Push API)`);
  if (NOTIF_BLOCKLIST.length > 0) {
    console.log(`  Notification blocklist: ${NOTIF_BLOCKLIST.join(', ')}`);
  }

  try { await openclawClient.connect(); }
  catch (err: any) { console.error('OpenClaw connect failed:', err.message); }

  startPushServer();
  const app = new G1OpenClawBridge();
  await app.start();
}

main().catch(console.error);

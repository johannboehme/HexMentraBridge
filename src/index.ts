import { AppServer, AppSession, ViewType } from '@mentra/sdk';
import { WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME not set'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY not set'); })();
const PORT = parseInt(process.env.PORT || '3000');
const PUSH_PORT = parseInt(process.env.PUSH_PORT || '3001');
const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://localhost:18789';
const OPENCLAW_GW_TOKEN = process.env.OPENCLAW_GW_TOKEN || '';

const G1_PREFIX = '⚠️ G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!\n\n';
const SOFT_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 300_000;

// ─── OpenClaw Gateway WebSocket Client ───

class OpenClawClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private runListeners = new Map<string, (text: string) => void>();
  private _pendingRunCallback: ((text: string) => void) | null = null;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(OPENCLAW_WS_URL);
      this.ws.on('open', () => {
        const connId = this.nextId();
        this.send({
          type: 'req', id: connId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'gateway-client', displayName: 'G1 Bridge', version: '0.4.0', platform: 'linux', mode: 'cli' },
            auth: { token: OPENCLAW_GW_TOKEN },
          },
        });
        const handler = (data: any) => {
          const msg = JSON.parse(String(data));
          if (msg.type === 'res' && msg.id === connId) {
            if (msg.ok) { this.connected = true; console.log('[OpenClaw] Connected'); resolve(); }
            else reject(new Error(`Connect failed: ${JSON.stringify(msg.error)}`));
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
            if (text && pl.runId) {
              console.log(`[OpenClaw] Reply (${pl.runId}): "${text.substring(0, 80)}"`);
              const cb = this.runListeners.get(pl.runId);
              if (cb) { this.runListeners.delete(pl.runId); cb(text); }
            }
          }
        }
        if (msg.type === 'event' && msg.event === 'agent') {
          const pl = msg.payload;
          if (pl?.stream === 'lifecycle' && pl?.data?.phase === 'start' && pl?.runId && this._pendingRunCallback) {
            this.runListeners.set(pl.runId, this._pendingRunCallback);
            this._pendingRunCallback = null;
          }
        }
      });

      this.ws.on('error', (err) => console.error('[OpenClaw] WS error:', err.message));
      this.ws.on('close', () => { console.log('[OpenClaw] WS closed'); this.connected = false; });
    });
  }

  private nextId() { return `g1-${++this.reqId}`; }
  private send(msg: any) { this.ws?.send(JSON.stringify(msg)); }
  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'req', id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Request timeout')); } }, 60000);
    });
  }

  async chat(message: string, onSoftTimeout?: () => void): Promise<string> {
    if (!this.connected) return 'Not connected to Hex';
    return new Promise(async (resolve) => {
      let resolved = false;
      const done = (text: string) => { if (!resolved) { resolved = true; resolve(text); } };
      this._pendingRunCallback = (text: string) => done(text);
      try {
        await this.request('chat.send', {
          message: G1_PREFIX + message,
          sessionKey: 'agent:main:main',
          idempotencyKey: `g1-${Date.now()}`,
        });
      } catch (err: any) {
        console.error('[OpenClaw] chat.send failed:', err.message);
        this._pendingRunCallback = null;
        done('Failed to reach Hex');
        return;
      }
      setTimeout(() => { if (!resolved) { onSoftTimeout?.(); } }, SOFT_TIMEOUT_MS);
      setTimeout(() => { if (!resolved) { this._pendingRunCallback = null; done('Hex braucht zu lange.'); } }, HARD_TIMEOUT_MS);
    });
  }

  /** Send a raw message (e.g. /new, /status) without waiting for reply */
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

// ─── Display Manager ───

class DisplayManager {
  private session: AppSession;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(session: AppSession) { this.session = session; }

  showWelcome(text: string) {
    this.cancelHide();
    this.session.layouts.showTextWall(text);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), 3000);
  }

  showThinking(userText: string) {
    this.cancelHide();
    this.session.layouts.showReferenceCard(userText, 'Thinking...');
  }

  showWaiting() {
    this.cancelHide();
    this.session.layouts.showTextWall('Moment...');
  }

  showReply(answer: string) {
    this.cancelHide();
    const truncated = answer.length > 280 ? answer.substring(0, 277) + '...' : answer;
    this.session.layouts.showTextWall(truncated);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), 15000);
  }

  /** Push a notification from Hex (proactive) */
  showNotification(text: string, durationMs = 10000) {
    this.cancelHide();
    const truncated = text.length > 280 ? text.substring(0, 277) + '...' : text;
    this.session.layouts.showReferenceCard('Hex', truncated);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), durationMs);
  }

  /** Push a bitmap to the display */
  async showBitmap(base64Bmp: string, durationMs = 10000) {
    this.cancelHide();
    await this.session.layouts.showBitmapView(base64Bmp);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), durationMs);
  }

  showStatus(text: string, durationMs = 3000) {
    this.cancelHide();
    this.session.layouts.showTextWall(text);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), durationMs);
  }

  private cancelHide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }
}

// Track active sessions for push notifications
const activeSessions = new Map<string, DisplayManager>();

// ─── Push HTTP API (localhost only) ───

function startPushServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // POST /push  { "text": "...", "duration": 10000 }
    if (req.method === 'POST' && req.url === '/push') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const text = data.text || '';
          const duration = data.duration || 10000;

          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'text required' }));
            return;
          }

          let sent = 0;
          for (const [id, display] of activeSessions) {
            display.showNotification(text, duration);
            sent++;
            console.log(`[Push] Sent to ${id}: "${text.substring(0, 60)}"`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
        }
      });
      return;
    }

    // POST /push-bitmap  { "bitmap": "<base64 BMP>", "duration": 10000 }
    if (req.method === 'POST' && req.url === '/push-bitmap') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const bitmap = data.bitmap || '';
          const duration = data.duration || 10000;

          if (!bitmap) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bitmap (base64 BMP) required' }));
            return;
          }

          let sent = 0;
          for (const [id, display] of activeSessions) {
            try {
              await display.showBitmap(bitmap, duration);
              sent++;
              console.log(`[Push] Bitmap sent to ${id}`);
            } catch (err: any) {
              console.error(`[Push] Bitmap error for ${id}:`, err.message);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message || 'invalid request' }));
        }
      });
      return;
    }

    // GET /status
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openclaw: openclawClient.isConnected(),
        sessions: activeSessions.size,
        sessionIds: [...activeSessions.keys()],
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PUSH_PORT, '127.0.0.1', () => {
    console.log(`[Push] API listening on http://127.0.0.1:${PUSH_PORT}`);
  });
}

// ─── Bridge App ───

class G1OpenClawBridge extends AppServer {
  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[${sessionId}] Connected: ${userId}`);

    const display = new DisplayManager(session);
    activeSessions.set(sessionId, display);
    display.showWelcome(openclawClient.isConnected() ? 'Hex connected.' : 'Hex offline.');

    // ─── Dashboard Card ───
    try {
      session.dashboard.content.write('Hex: Ready', ['main']);
      console.log(`[${sessionId}] Dashboard card set.`);
    } catch (e: any) {
      console.log(`[${sessionId}] Dashboard card failed: ${e.message}`);
    }

    // ─── Head-Up Toggle for Transcription ───
    let listening = false;
    let unsubTranscription: (() => void) | null = null;

    const startListening = () => {
      if (listening) return;
      listening = true;
      console.log(`[${sessionId}] Transcription ON`);
      display.showStatus('Listening...', 2000);

      try {
        session.dashboard.content.write('Hex: Listening...', ['main']);
      } catch (e) {}

      unsubTranscription = session.events.onTranscription(async (data) => {
        if (!data.isFinal) return;
        const userText = data.text.trim();
        if (!userText) return;

        // "Neue Session" / "New Session" → reset main session
        const lower = userText.toLowerCase();
        if (lower.includes('neue session') || lower.includes('new session')) {
          console.log(`[${sessionId}] Session reset requested`);
          display.showStatus('New session...', 3000);
          try {
            await openclawClient.sendRaw('/new');
          } catch (e: any) {
            console.error(`[${sessionId}] Reset failed:`, e.message);
          }
          display.showStatus('Session reset.', 3000);
          return;
        }

        console.log(`[${sessionId}] User: "${userText}"`);
        display.showThinking(userText);

        const reply = await openclawClient.chat(
          userText,
          () => display.showWaiting()
        );

        console.log(`[${sessionId}] Hex: "${reply.substring(0, 80)}"`);
        display.showReply(reply);
      });
    };

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      console.log(`[${sessionId}] Transcription OFF`);
      if (unsubTranscription) { unsubTranscription(); unsubTranscription = null; }
      display.showStatus('Mic off.', 2000);

      try {
        session.dashboard.content.write('Hex: Ready', ['main']);
      } catch (e) {}
    };

    // ─── Phone Notifications → Display on glasses ───
    // Smart truncation: App name as card title, content truncated to fit G1 display
    // ~4 lines, ~40 chars/line = ~160 chars usable for body
    const MAX_NOTIF_BODY = 150;
    session.events.onPhoneNotifications((data: any) => {
      const app = data.app || 'Notification';
      const title = data.title || '';
      const content = data.content || '';

      // Build body: title + content, smartly truncated
      let body = '';
      if (title && content) {
        body = `${title}: ${content}`;
      } else {
        body = title || content;
      }

      // Smart truncation: try to cut at word boundary
      if (body.length > MAX_NOTIF_BODY) {
        const cut = body.lastIndexOf(' ', MAX_NOTIF_BODY);
        body = body.substring(0, cut > 80 ? cut : MAX_NOTIF_BODY) + '...';
      }

      console.log(`[${sessionId}] NOTIF: ${app} — ${body}`);
      display.showNotification(`${app}\n${body}`, 10000);
    });

    // ─── Head-Up Toggle (6s hold required) ───
    const HOLD_DURATION_MS = 6000;
    let headUpSince: number | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    session.events.onHeadPosition((data: any) => {
      if (data.position === 'up') {
        headUpSince = Date.now();
        // Start timer — toggle after 6s of sustained head-up
        holdTimer = setTimeout(() => {
          if (headUpSince) {
            console.log(`[${sessionId}] Head-up held 6s → toggle`);
            if (listening) stopListening();
            else startListening();
          }
          headUpSince = null;
        }, HOLD_DURATION_MS);
      } else if (data.position === 'down') {
        // Cancelled before 6s
        headUpSince = null;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      }
    });

    console.log(`[${sessionId}] Ready. Look up to toggle mic.`);
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    activeSessions.delete(sessionId);
    console.log(`[${sessionId}] Ended: ${reason}`);
  }
}

// ─── Main ───

async function main() {
  console.log('G1-OpenClaw Bridge v0.4.0');
  console.log(`  MentraOS: ${PACKAGE_NAME}`);
  console.log(`  OpenClaw: ${OPENCLAW_WS_URL}`);
  console.log(`  Ports: ${PORT} (MentraOS), ${PUSH_PORT} (Push API)`);

  try { await openclawClient.connect(); }
  catch (err: any) { console.error('OpenClaw connect failed:', err.message); }

  startPushServer();

  const app = new G1OpenClawBridge();
  await app.start();
}

main().catch(console.error);

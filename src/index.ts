import { AppServer, AppSession } from '@mentra/sdk';
import { WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME not set'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY not set'); })();
const PORT = parseInt(process.env.PORT || '3000');
const PUSH_PORT = parseInt(process.env.PUSH_PORT || '3001');
const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://localhost:18789';
const OPENCLAW_GW_TOKEN = process.env.OPENCLAW_GW_TOKEN || '';

const G1_PREFIX = '⚠️ G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!\n\n';
const G1_COPILOT_PREFIX = '⚠️ G1 COPILOT MODE: The user is having a conversation nearby. You are listening silently. Do NOT respond directly. Instead, provide 1-2 short contextual hints, facts, or suggestions that might help the user. No markdown, no emojis. Ultra short.\n\nOverheard: ';
const SOFT_TIMEOUT_MS = 45_000;
const HARD_TIMEOUT_MS = 300_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const HEAD_HOLD_MS = 6_000;
const MAX_NOTIF_BODY = 150;

// ─── OpenClaw Gateway WebSocket Client (with auto-reconnect) ───

class OpenClawClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private runListeners = new Map<string, (text: string) => void>();
  private _pendingRunCallback: ((text: string) => void) | null = null;
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
            client: { id: 'gateway-client', displayName: 'G1 Bridge', version: '0.6.0', platform: 'linux', mode: 'cli' },
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
            if (text && pl.runId) {
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

      this.ws.on('error', (err) => {
        console.error('[OpenClaw] WS error:', err.message);
      });

      this.ws.on('close', () => {
        console.log('[OpenClaw] WS closed');
        this.connected = false;
        // Reject all pending requests
        for (const [id, p] of this.pending) {
          p.reject(new Error('WS closed'));
        }
        this.pending.clear();
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
      this._pendingRunCallback = (text: string) => done(text);
      try {
        await this.request('chat.send', {
          message: prefix + message,
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

  showNotification(text: string, durationMs = 10000) {
    this.cancelHide();
    const truncated = text.length > 280 ? text.substring(0, 277) + '...' : text;
    this.session.layouts.showReferenceCard('Hex', truncated);
    this.hideTimer = setTimeout(() => this.session.layouts.clearView(), durationMs);
  }

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

  setDashboard(text: string) {
    try { this.session.dashboard.content.write(text, ['main']); } catch (e) {}
  }

  showDashboardCard(left: string, right: string) {
    try { this.session.layouts.showDashboardCard(left, right); } catch (e) {}
  }

  private cancelHide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }
}

// Active sessions for push
const activeSessions = new Map<string, DisplayManager>();

// ─── Push HTTP API ───

function startPushServer() {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { text, duration = 10000 } = JSON.parse(body);
          if (!text) { res.writeHead(400); res.end('{"error":"text required"}'); return; }
          let sent = 0;
          for (const [id, d] of activeSessions) { d.showNotification(text, duration); sent++; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/push-bitmap') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const { bitmap, duration = 10000 } = JSON.parse(body);
          if (!bitmap) { res.writeHead(400); res.end('{"error":"bitmap required"}'); return; }
          let sent = 0;
          for (const [id, d] of activeSessions) {
            try { await d.showBitmap(bitmap, duration); sent++; } catch (e) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions: sent }));
        } catch (e: any) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

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

    res.writeHead(404); res.end('Not found');
  });
  server.listen(PUSH_PORT, '127.0.0.1', () => console.log(`[Push] API on http://127.0.0.1:${PUSH_PORT}`));
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
    display.setDashboard('Hex: Ready');

    // ─── State ───
    let listening = false;
    let copilotMode = false;
    let unsubTranscription: (() => void) | null = null;

    // ─── Transcription Handler ───
    const handleTranscription = async (data: any) => {
      if (!data.isFinal) return;
      const userText = data.text.trim();
      if (!userText) return;

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
        display.showStatus(state, 3000);
        updateDashboard();
        return;
      }

      // Copilot mode: silent transcription, contextual hints
      if (copilotMode) {
        console.log(`[${sessionId}] Copilot heard: "${userText}"`);
        const reply = await openclawClient.chat(userText, G1_COPILOT_PREFIX);
        // Filter out NO_REPLY / empty / non-useful responses
        if (reply && reply.length > 0 && !reply.trim().startsWith('NO_REPLY') && !reply.trim().startsWith('NO_RE')) {
          console.log(`[${sessionId}] Copilot hint: "${reply.substring(0, 80)}"`);
          display.showReply(reply);
        } else {
          console.log(`[${sessionId}] Copilot: nothing to show`);
        }
        return;
      }

      // Normal mode
      console.log(`[${sessionId}] User: "${userText}"`);
      display.showThinking(userText);

      const reply = await openclawClient.chat(
        userText, G1_PREFIX,
        () => display.showWaiting()
      );

      // Filter NO_REPLY responses
      if (reply && !reply.trim().startsWith('NO_REPLY') && !reply.trim().startsWith('NO_RE')) {
        console.log(`[${sessionId}] Hex: "${reply.substring(0, 80)}"`);
        display.showReply(reply);
      } else {
        console.log(`[${sessionId}] Hex: silent (NO_REPLY)`);
      }
    };

    // ─── Start/Stop Listening ───
    const startListening = () => {
      if (listening) return;
      listening = true;
      console.log(`[${sessionId}] Mic ON`);
      display.showStatus('Listening...', 2000);
      updateDashboard();
      unsubTranscription = session.events.onTranscription(handleTranscription);
    };

    const stopListening = () => {
      if (!listening) return;
      listening = false;
      console.log(`[${sessionId}] Mic OFF`);
      if (unsubTranscription) { unsubTranscription(); unsubTranscription = null; }
      display.showStatus('Mic off.', 2000);
      updateDashboard();
    };

    // ─── Phone Notifications ───
    session.events.onPhoneNotifications((data: any) => {
      const app = data.app || 'Notification';
      const title = data.title || '';
      const content = data.content || '';
      let body = title && content ? `${title}: ${content}` : (title || content);
      if (body.length > MAX_NOTIF_BODY) {
        const cut = body.lastIndexOf(' ', MAX_NOTIF_BODY);
        body = body.substring(0, cut > 80 ? cut : MAX_NOTIF_BODY) + '...';
      }
      console.log(`[${sessionId}] NOTIF: ${app} — ${body}`);
      display.showNotification(`${app}\n${body}`, 10000);
    });

    // ─── Head-Up Toggle (6s hold) ───
    let headUpSince: number | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    session.events.onHeadPosition((data: any) => {
      if (data.position === 'up') {
        headUpSince = Date.now();
        holdTimer = setTimeout(() => {
          if (headUpSince) {
            console.log(`[${sessionId}] Head-up 6s → toggle`);
            if (listening) stopListening();
            else startListening();
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
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    activeSessions.delete(sessionId);
    console.log(`[${sessionId}] Ended: ${reason}`);
  }
}

// ─── Main ───

async function main() {
  console.log('G1-OpenClaw Bridge v0.6.0');
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

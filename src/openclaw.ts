import { WebSocket } from 'ws';
import { OPENCLAW_WS_URL, OPENCLAW_GW_TOKEN, SOFT_TIMEOUT_MS, HARD_TIMEOUT_MS, RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS } from './config';
import { deviceAuth, buildDeviceAuthPayload, signDevicePayload } from './device-auth';

export class OpenClawClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private runListeners = new Map<string, (text: string) => void>();
  private _pendingIdempotencyCallbacks = new Map<string, (text: string) => void>();
  private reconnectDelay = RECONNECT_DELAY_MS;
  private shouldReconnect = true;

  onUnmatchedMessage: ((text: string) => void) | null = null;

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
        const sendConnect = (nonce?: string) => {
          const connId = this.nextId();
          const deviceBlock = deviceAuth ? (() => {
            const signedAt = Date.now();
            const payload = buildDeviceAuthPayload({
              deviceId: deviceAuth.deviceId,
              clientId: 'gateway-client', clientMode: 'cli',
              role: 'operator', scopes: ['operator.read', 'operator.write'],
              signedAtMs: signedAt, token: deviceAuth.deviceToken || OPENCLAW_GW_TOKEN,
              nonce: nonce || '',
            });
            return { device: { id: deviceAuth.deviceId, publicKey: deviceAuth.publicKeyBase64url, signature: signDevicePayload(payload), signedAt, ...(nonce ? { nonce } : {}) } };
          })() : (nonce ? { device: { nonce } } : {});
          this.send({
            type: 'req', id: connId, method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'gateway-client', displayName: 'G1 Bridge', version: '0.9.0', platform: 'linux', mode: 'cli' },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              auth: { token: deviceAuth?.deviceToken || OPENCLAW_GW_TOKEN },
              ...deviceBlock,
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
        };

        let challengeReceived = false;
        const challengeTimeout = setTimeout(() => {
          if (!challengeReceived) {
            console.log('[OpenClaw] No challenge received, connecting without nonce');
            sendConnect();
          }
        }, 2000);
        const challengeHandler = (data: any) => {
          try {
            const msg = JSON.parse(String(data));
            if (msg.type === 'event' && msg.event === 'connect.challenge' && msg.payload?.nonce) {
              challengeReceived = true;
              clearTimeout(challengeTimeout);
              this.ws!.removeListener('message', challengeHandler);
              console.log('[OpenClaw] Challenge received, connecting with nonce');
              sendConnect(msg.payload.nonce);
            }
          } catch {}
        };
        this.ws!.on('message', challengeHandler);
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
            console.log(`[OpenClaw] chat final: runId=${pl.runId} text="${(text||'').substring(0,60)}" hasListener=${pl.runId ? this.runListeners.has(pl.runId) : 'no-runId'} idemPending=${this._pendingIdempotencyCallbacks.size} listeners=${this.runListeners.size}`);
            if (text && pl.runId) {
              const cb = this.runListeners.get(pl.runId);
              if (cb) { this.runListeners.delete(pl.runId); cb(text); }
              else if (this.onUnmatchedMessage) {
                console.log(`[OpenClaw] Unmatched bot message — dispatching via callback`);
                this.onUnmatchedMessage(text);
              }
            }
          }
        }

        if (msg.type === 'event' && msg.event === 'agent') {
          const pl = msg.payload;
          if (pl?.stream === 'lifecycle') {
            console.log(`[OpenClaw] agent lifecycle: phase=${pl?.data?.phase} runId=${pl?.runId} idemKey=${pl?.data?.idempotencyKey || 'none'} idemPending=${this._pendingIdempotencyCallbacks.size} listeners=${this.runListeners.size}`);
          }
          if (pl?.stream === 'lifecycle' && pl?.data?.phase === 'start' && pl?.runId) {
            const idemKey = pl?.data?.idempotencyKey || pl?.idempotencyKey;
            if (idemKey && this._pendingIdempotencyCallbacks.has(idemKey)) {
              const cb = this._pendingIdempotencyCallbacks.get(idemKey)!;
              this._pendingIdempotencyCallbacks.delete(idemKey);
              this.runListeners.set(pl.runId, cb);
              console.log(`[OpenClaw] matched runId=${pl.runId} via idemKey=${idemKey} (idemPending=${this._pendingIdempotencyCallbacks.size})`);
            } else if (this.runListeners.has(pl.runId)) {
              console.log(`[OpenClaw] runId=${pl.runId} already has listener (matched via chat.send response)`);
            } else {
              console.log(`[OpenClaw] ignoring unmatched run runId=${pl.runId} (no callback)`);
            }
          }
          if (pl?.stream === 'lifecycle' && pl?.data?.phase === 'end' && pl?.runId && this.runListeners.has(pl.runId)) {
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
        const wasConnected = this.connected;
        this.connected = false;
        for (const [id, p] of this.pending) {
          p.reject(new Error('WS closed'));
        }
        this.pending.clear();
        this._pendingIdempotencyCallbacks.clear();
        this.runListeners.clear();
        this.scheduleReconnect();
        if (!wasConnected) {
          reject(new Error('WS closed before connect'));
        }
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
      const idemKey = `g1-${Date.now()}`;

      const cb = (text: string) => done(text);
      this._pendingIdempotencyCallbacks.set(idemKey, cb);

      try {
        const res = await this.request('chat.send', {
          message: prefix + message,
          sessionKey: 'agent:main:main',
          idempotencyKey: idemKey,
        });
        if (res?.runId) {
          this._pendingIdempotencyCallbacks.delete(idemKey);
          this.runListeners.set(res.runId, cb);
          console.log(`[OpenClaw] chat.send returned runId=${res.runId} for idem=${idemKey}`);
        } else {
          console.log(`[OpenClaw] chat.send no runId in response for idem=${idemKey}, waiting for phase:start`);
        }
      } catch (err: any) {
        console.error('[OpenClaw] chat.send failed:', err.message);
        this._pendingIdempotencyCallbacks.delete(idemKey);
        done('Failed to reach Hex');
        return;
      }
      setTimeout(() => { if (!resolved) { onSoftTimeout?.(); } }, SOFT_TIMEOUT_MS);
      setTimeout(() => {
        if (!resolved) {
          this._pendingIdempotencyCallbacks.delete(idemKey);
          for (const [runId, listener] of this.runListeners) {
            if (listener === cb) { this.runListeners.delete(runId); break; }
          }
          console.log('[OpenClaw] Hard timeout reached — suppressing stale request');
          done('');
        }
      }, HARD_TIMEOUT_MS);
    });
  }

  cancelPendingRuns() {
    for (const [key, cb] of this._pendingIdempotencyCallbacks) {
      cb('');
    }
    this._pendingIdempotencyCallbacks.clear();
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

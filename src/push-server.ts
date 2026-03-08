import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  PUSH_PORT, PUSH_BIND, PUSH_TOKEN,
  G1_PREFIX, G1_COPILOT_PREFIX, ASSISTANT_NAME,
  COPILOT_DEBOUNCE_MS, COPILOT_TIMEOUT_MS, CONTEXT_WINDOW_SIZE,
} from './config';
import type { OpenClawClient } from './openclaw';
import type { SessionHandle, AppClientState } from './types';
import { formatAgo, isNoReply } from './helpers';
import { filterWithLLM, containsAssistantName } from './filter';
import { logTranscript } from './logger';
import { createTrace, traceStep, traceFinish } from './timing';

export const appClients = new Map<string, AppClientState>();
let appClientCounter = 0;

export function sendToAppClient(client: AppClientState, msg: object) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

export function broadcastToAppClients(msg: object) {
  const data = JSON.stringify(msg);
  for (const [, client] of appClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

export function startPushServer(
  openclawClient: OpenClawClient,
  activeSessions: Map<string, SessionHandle>,
) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
          for (const [id, c] of appClients) { sendToAppClient(c, { type: 'ai_response', text }); sent++; }
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
      let micState = false;
      for (const [id, h] of activeSessions) { micState = h.getMicState(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: activeSessions.size, listening: micState }));
      return;
    }

    if (req.method === 'POST' && path === '/copilot') {
      let toggled = 0;
      let copilotState = false;
      for (const [id, h] of activeSessions) {
        copilotState = h.toggleCopilot();
        toggled++;
      }
      for (const [id, c] of appClients) {
        c.copilotMode = !c.copilotMode;
        copilotState = c.copilotMode;
        if (c.copilotDebounceTimer) { clearTimeout(c.copilotDebounceTimer); c.copilotDebounceTimer = null; }
        c.copilotBuffer = [];
        c.copilotPipelineSize = 0;
        c.copilotContextWindow.length = 0;
        sendToAppClient(c, { type: 'ai_response', text: copilotState ? 'Copilot ON' : 'Copilot OFF' });
        toggled++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: toggled, copilot: copilotState }));
      return;
    }

    if (req.method === 'GET' && path === '/copilot') {
      let copilotState = false;
      for (const [id, h] of activeSessions) { copilotState = h.getCopilotState(); }
      for (const [id, c] of appClients) { copilotState = c.copilotMode; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: activeSessions.size + appClients.size, copilot: copilotState }));
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      let micState = false;
      let copilotState = false;
      for (const [id, h] of activeSessions) { micState = h.getMicState(); copilotState = h.getCopilotState(); }
      for (const [id, c] of appClients) { copilotState = c.copilotMode; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openclaw: openclawClient.isConnected(),
        sessions: activeSessions.size,
        sessionIds: [...activeSessions.keys()],
        appClients: appClients.size,
        appClientIds: [...appClients.keys()],
        listening: micState,
        copilot: copilotState,
      }));
      return;
    }

    if (req.method === 'GET' && path === '/debug') {
      const sessions: Record<string, any> = {};
      for (const [id, h] of activeSessions) {
        const s = h.getDebugStatus();
        const agoSec = s.lastTranscriptAt ? Math.round((Date.now() - s.lastTranscriptAt) / 1000) : null;
        const progress = Math.min(s.copilotPipelineSize * 20, 100);
        sessions[id] = {
          listening: s.listening,
          copilot: s.copilot,
          lastTranscriptAt: s.lastTranscriptAt,
          lastTranscriptAgo: agoSec !== null ? formatAgo(agoSec) : null,
          lastTranscriptText: s.lastTranscriptText || null,
          copilotQueueSize: s.copilotPipelineSize,
          copilotInflight: s.copilotInflight,
          copilotPipeline: {
            size: s.copilotPipelineSize,
            bufferSize: s.copilotBufferSize,
            inflight: s.copilotInflight,
            totalFiltered: s.copilotFilteredCount,
            totalPassed: s.copilotPassedCount,
          },
          progress,
        };
      }
      const appClientDebug: Record<string, any> = {};
      for (const [id, c] of appClients) {
        const agoSec = c.lastTranscriptAt ? Math.round((Date.now() - c.lastTranscriptAt) / 1000) : null;
        const progress = Math.min(c.copilotPipelineSize * 20, 100);
        appClientDebug[id] = {
          type: 'g1claw',
          copilot: c.copilotMode,
          lastTranscriptAt: c.lastTranscriptAt,
          lastTranscriptAgo: agoSec !== null ? formatAgo(agoSec) : null,
          lastTranscriptText: c.lastTranscriptText || null,
          copilotQueueSize: c.copilotPipelineSize,
          copilotInflight: c.copilotInflight,
          copilotPipeline: {
            size: c.copilotPipelineSize,
            bufferSize: c.copilotBuffer.length,
            inflight: c.copilotInflight,
            totalFiltered: c.copilotFilteredCount,
            totalPassed: c.copilotPassedCount,
          },
          progress,
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        openclaw: openclawClient.isConnected(),
        totalSessions: activeSessions.size,
        totalAppClients: appClients.size,
        sessions,
        appClients: appClientDebug,
      }));
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  // ─── G1Claw App WebSocket (upgrade on /app-ws) ───

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(request.url || '/', `http://localhost`);
    if (url.pathname !== '/app-ws') {
      socket.destroy();
      return;
    }

    if (PUSH_TOKEN) {
      const auth = request.headers['authorization'] || '';
      const urlToken = url.searchParams.get('token');
      if (auth !== `Bearer ${PUSH_TOKEN}` && urlToken !== PUSH_TOKEN) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const clientId = `app-${++appClientCounter}`;
    console.log(`[${clientId}] G1Claw app connected`);

    const client: AppClientState = {
      ws,
      copilotMode: false,
      copilotBuffer: [],
      copilotDebounceTimer: null,
      copilotInflight: false,
      copilotPipelineSize: 0,
      copilotFilteredCount: 0,
      copilotPassedCount: 0,
      copilotContextWindow: [],
      lastTranscriptAt: null,
      lastTranscriptText: '',
      manualMode: false,
      manualBuffer: [],
    };
    appClients.set(clientId, client);

    const sendCopilotBatch = async () => {
      if (client.copilotBuffer.length === 0) return;
      if (client.copilotInflight) return;

      const batchItemCount = client.copilotBuffer.length;
      const batch = client.copilotBuffer.join(' ');
      client.copilotBuffer = [];

      const trace = createTrace('copilot', batch);
      traceStep(trace, 'debounce_done');

      const nameDetected = containsAssistantName(batch);
      let filterResult: 'RELEVANT' | 'SKIP' | 'ERROR';

      if (nameDetected) {
        console.log(`[${clientId}] Copilot: "${ASSISTANT_NAME}" detected — skipping filter: "${batch.substring(0, 80)}"`);
        traceStep(trace, 'keyword_bypass');
        filterResult = 'RELEVANT';
        logTranscript('copilot', batch, 'BYPASS');
      } else {
        traceStep(trace, 'filter_start');
        filterResult = await filterWithLLM(batch);
        traceStep(trace, 'filter_done');
        logTranscript('copilot', batch, filterResult);
      }
      trace.filterResult = nameDetected ? `BYPASS(${ASSISTANT_NAME})` : filterResult;

      client.copilotContextWindow.push(batch);
      while (client.copilotContextWindow.length > CONTEXT_WINDOW_SIZE) client.copilotContextWindow.shift();

      if (filterResult === 'SKIP') {
        client.copilotPipelineSize = Math.max(0, client.copilotPipelineSize - batchItemCount);
        client.copilotFilteredCount += batchItemCount;
        traceFinish(trace);
        drainBuffer();
        return;
      }

      let messageForOpus = batch;
      if (client.copilotContextWindow.length > 1) {
        const prevContext = client.copilotContextWindow.slice(0, -1);
        messageForOpus = 'Recent conversation context:\n' +
          prevContext.map(t => `- ${t}`).join('\n') +
          '\n\nCurrent: ' + batch;
      }

      client.copilotInflight = true;
      client.copilotPassedCount += batchItemCount;

      const safetyTimer = setTimeout(() => {
        if (client.copilotInflight) {
          client.copilotPipelineSize = Math.max(0, client.copilotPipelineSize - batchItemCount);
          client.copilotInflight = false;
          traceStep(trace, 'safety_timeout');
          traceFinish(trace);
          openclawClient.cancelPendingRuns();
          drainBuffer();
        }
      }, COPILOT_TIMEOUT_MS);

      traceStep(trace, 'opus_start');
      try {
        const reply = await openclawClient.chat(messageForOpus, G1_COPILOT_PREFIX);
        clearTimeout(safetyTimer);
        traceStep(trace, 'opus_done');
        client.copilotPipelineSize = Math.max(0, client.copilotPipelineSize - batchItemCount);
        const t = reply ? reply.trim() : '';
        if (t && !isNoReply(t)) {
          traceStep(trace, 'display');
          sendToAppClient(client, { type: 'ai_response', text: t });
        } else {
          traceStep(trace, 'no_reply');
        }
      } catch (e: any) {
        clearTimeout(safetyTimer);
        traceStep(trace, 'opus_error');
        client.copilotPipelineSize = Math.max(0, client.copilotPipelineSize - batchItemCount);
      } finally {
        client.copilotInflight = false;
        traceFinish(trace);
        drainBuffer();
      }
    };

    const drainBuffer = () => {
      if (client.copilotBuffer.length > 0 && client.copilotMode) {
        if (client.copilotDebounceTimer) clearTimeout(client.copilotDebounceTimer);
        client.copilotDebounceTimer = setTimeout(() => {
          client.copilotDebounceTimer = null;
          sendCopilotBatch();
        }, 1_000);
      }
    };

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(String(data));

        if (msg.type === 'ping') {
          sendToAppClient(client, { type: 'pong' });
          return;
        }

        if (msg.type === 'set_mode') {
          client.copilotMode = !!msg.copilot;
          if (client.copilotDebounceTimer) { clearTimeout(client.copilotDebounceTimer); client.copilotDebounceTimer = null; }
          client.copilotBuffer = [];
          client.copilotPipelineSize = 0;
          client.copilotContextWindow.length = 0;
          console.log(`[${clientId}] Copilot ${client.copilotMode ? 'ON' : 'OFF'} (via app)`);
          sendToAppClient(client, { type: 'ai_response', text: client.copilotMode ? 'Copilot ON' : 'Copilot OFF' });
          return;
        }

        if (msg.type === 'transcription' && msg.text) {
          const userText = msg.text.trim();
          if (!userText) return;

          client.lastTranscriptAt = Date.now();
          client.lastTranscriptText = userText;

          const lower = userText.toLowerCase();

          if (lower.includes('neue session') || lower.includes('new session')) {
            console.log(`[${clientId}] Session reset`);
            sendToAppClient(client, { type: 'ai_response', text: 'New session...' });
            try { await openclawClient.sendRaw('/new'); } catch (e) {}
            sendToAppClient(client, { type: 'ai_response', text: 'Session reset.' });
            return;
          }

          const normalized = lower.replace(/[-]/g, '').replace(/[.,!?]/g, '').trim();
          const copilotPatterns = [
            'copilot modus', 'copilot mode',
            'copilot an', 'copilot aus',
            'copilot on', 'copilot off',
            'copilotmodus',
          ];
          if (copilotPatterns.some(p => normalized === p)) {
            client.copilotMode = !client.copilotMode;
            const state = client.copilotMode ? 'Copilot ON' : 'Copilot OFF';
            console.log(`[${clientId}] ${state}`);
            if (client.copilotDebounceTimer) { clearTimeout(client.copilotDebounceTimer); client.copilotDebounceTimer = null; }
            client.copilotBuffer = [];
            client.copilotPipelineSize = 0;
            client.copilotContextWindow.length = 0;
            sendToAppClient(client, { type: 'ai_response', text: state });
            return;
          }

          const manualPatterns = ['manual mode', 'manuel mode', 'manueller modus'];
          const autoPatterns = ['automatic mode', 'automatischer modus', 'auto mode'];
          if (manualPatterns.some(p => normalized === p)) {
            client.manualMode = true;
            client.manualBuffer = [];
            console.log(`[${clientId}] Manual mode ON`);
            sendToAppClient(client, { type: 'ai_response', text: 'Manual mode enabled' });
            return;
          }
          if (autoPatterns.some(p => normalized === p)) {
            client.manualMode = false;
            client.manualBuffer = [];
            console.log(`[${clientId}] Auto mode ON`);
            sendToAppClient(client, { type: 'ai_response', text: 'Auto mode enabled' });
            return;
          }

          if (client.manualMode && (normalized === 'confirm' || normalized === 'bestätigen' || normalized === 'senden' || normalized === 'send' || normalized === 'commit' || normalized === 'submit')) {
            if (client.manualBuffer.length === 0) {
              sendToAppClient(client, { type: 'ai_response', text: 'Buffer empty' });
              return;
            }
            const combined = client.manualBuffer.join(' ');
            const count = client.manualBuffer.length;
            client.manualBuffer = [];
            const normalTrace = createTrace('normal', combined);
            logTranscript('normal', combined);
            console.log(`[${clientId}] Manual confirm (${count} items): "${combined.substring(0, 80)}"`);
            sendToAppClient(client, { type: 'ai_response', text: 'Thinking...' });
            traceStep(normalTrace, 'opus_start');
            const reply = await openclawClient.chat(combined, G1_PREFIX,
              () => sendToAppClient(client, { type: 'ai_response', text: 'Moment...' })
            );
            traceStep(normalTrace, 'opus_done');
            const trimmed = reply ? reply.trim() : '';
            if (trimmed && !isNoReply(trimmed)) {
              console.log(`[${clientId}] Hex: "${reply.substring(0, 80)}"`);
              traceStep(normalTrace, 'display');
              sendToAppClient(client, { type: 'ai_response', text: reply });
            } else {
              console.log(`[${clientId}] Hex: silent (NO_REPLY)`);
              traceStep(normalTrace, 'no_reply');
            }
            traceFinish(normalTrace);
            return;
          }
          if (client.manualMode && (normalized === 'preview' || normalized === 'vorschau')) {
            if (client.manualBuffer.length === 0) {
              sendToAppClient(client, { type: 'ai_response', text: 'Buffer empty' });
              return;
            }
            const lines = client.manualBuffer.map((t, i) => `${i + 1}. ${t}`);
            const previewText = `Buffer [${client.manualBuffer.length}]:\n${lines.join('\n')}`;
            console.log(`[${clientId}] Manual preview (${client.manualBuffer.length} items)`);
            sendToAppClient(client, { type: 'ai_response', text: previewText });
            return;
          }
          if (client.manualMode && (normalized === 'backspace' || normalized === 'zurück')) {
            if (client.manualBuffer.length > 0) {
              const removed = client.manualBuffer.pop();
              console.log(`[${clientId}] Manual buffer backspace, removed: "${removed}" (${client.manualBuffer.length} remaining)`);
              if (client.manualBuffer.length > 0) {
                const preview = client.manualBuffer.slice(-3).map((t, i) => `${client.manualBuffer.length - Math.min(3, client.manualBuffer.length) + i + 1}. ${t.substring(0, 50)}`).join('\n');
                sendToAppClient(client, { type: 'ai_response', text: `Buffer [${client.manualBuffer.length}]:\n${preview}` });
              } else {
                sendToAppClient(client, { type: 'ai_response', text: 'Buffer empty' });
              }
            } else {
              sendToAppClient(client, { type: 'ai_response', text: 'Buffer empty' });
            }
            return;
          }

          const cancelPatterns = ['cancel', 'abbrechen', 'clear', 'clear buffer', 'clear display', 'stop', 'stopp', 'löschen'];
          if (cancelPatterns.some(p => normalized === p)) {
            if (client.manualMode && client.manualBuffer.length > 0) {
              const count = client.manualBuffer.length;
              client.manualBuffer = [];
              console.log(`[${clientId}] Manual buffer cleared (${count} items)`);
            }
            console.log(`[${clientId}] Display cleared by user`);
            sendToAppClient(client, { type: 'ai_response', text: 'Cleared.' });
            return;
          }

          if (client.copilotMode) {
            console.log(`[${clientId}] Copilot heard: "${userText}"`);
            client.copilotBuffer.push(userText);
            client.copilotPipelineSize++;
            if (client.copilotDebounceTimer) clearTimeout(client.copilotDebounceTimer);
            client.copilotDebounceTimer = setTimeout(() => {
              client.copilotDebounceTimer = null;
              sendCopilotBatch();
            }, COPILOT_DEBOUNCE_MS);
            return;
          }

          if (client.manualMode) {
            client.manualBuffer.push(userText);
            console.log(`[${clientId}] Manual buffer (${client.manualBuffer.length}): "${userText}"`);
            const preview = client.manualBuffer.slice(-3).map((t, i) => `${client.manualBuffer.length - Math.min(3, client.manualBuffer.length) + i + 1}. ${t.substring(0, 50)}`).join('\n');
            sendToAppClient(client, { type: 'ai_response', text: `Buffer [${client.manualBuffer.length}]:\n${preview}` });
            return;
          }

          const normalTrace = createTrace('normal', userText);
          logTranscript('normal', userText);
          console.log(`[${clientId}] User: "${userText}"`);

          traceStep(normalTrace, 'opus_start');
          const reply = await openclawClient.chat(
            userText, G1_PREFIX,
            () => sendToAppClient(client, { type: 'ai_response', text: 'Moment...' })
          );
          traceStep(normalTrace, 'opus_done');

          const trimmed = reply ? reply.trim() : '';
          if (trimmed && !isNoReply(trimmed)) {
            console.log(`[${clientId}] Hex: "${reply.substring(0, 80)}"`);
            traceStep(normalTrace, 'display');
            sendToAppClient(client, { type: 'ai_response', text: reply });
          } else {
            console.log(`[${clientId}] Hex: silent (NO_REPLY)`);
            traceStep(normalTrace, 'no_reply');
          }
          traceFinish(normalTrace);
          return;
        }

        if (msg.type === 'audio' && msg.data) {
          console.log(`[${clientId}] Audio chunk received (${msg.data.length} chars b64) — server-side STT not yet implemented`);
          return;
        }
      } catch (e: any) {
        console.error(`[${clientId}] Message error: ${e.message}`);
      }
    });

    ws.on('close', () => {
      console.log(`[${clientId}] G1Claw app disconnected`);
      if (client.copilotDebounceTimer) clearTimeout(client.copilotDebounceTimer);
      appClients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`[${clientId}] WebSocket error: ${err.message}`);
    });
  });

  server.listen(PUSH_PORT, PUSH_BIND, () => console.log(`[Push] API + WebSocket on http://${PUSH_BIND}:${PUSH_PORT}${PUSH_TOKEN ? ' (auth required)' : ''}`));
}

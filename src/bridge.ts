import { AppServer, AppSession } from '@mentra/sdk';
import {
  PACKAGE_NAME, MENTRAOS_API_KEY, PORT,
  G1_PREFIX, G1_COPILOT_PREFIX, ASSISTANT_NAME,
  NOTIF_BLOCKLIST, HEAD_HOLD_MS,
  COPILOT_DEBOUNCE_MS, COPILOT_TIMEOUT_MS, CONTEXT_WINDOW_SIZE,
  HARD_TIMEOUT_MS,
} from './config';
import type { OpenClawClient } from './openclaw';
import type { SessionHandle } from './types';
import { isNoReply } from './helpers';
import { DisplayManager } from './display';
import { NotificationDedup } from './dedup';
import { filterWithLLM, containsAssistantName } from './filter';
import { logTranscript } from './logger';
import { createTrace, traceStep, traceFinish } from './timing';

export class G1OpenClawBridge extends AppServer {
  private openclawClient: OpenClawClient;
  private activeSessions: Map<string, SessionHandle>;

  constructor(openclawClient: OpenClawClient, activeSessions: Map<string, SessionHandle>) {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
    this.openclawClient = openclawClient;
    this.activeSessions = activeSessions;
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[${sessionId}] Connected: ${userId}`);
    const openclawClient = this.openclawClient;

    const display = new DisplayManager(session);
    display.showWelcome(openclawClient.isConnected() ? 'Hex connected.' : 'Hex offline.');
    display.setDashboard('Hex: Ready');

    // ─── State ───
    let listening = false;
    let copilotMode = false;
    let copilotBuffer: string[] = [];
    let copilotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let copilotInflight = false;
    let unsubTranscription: (() => void) | null = null;
    let resubAttempts = 0;
    let lastTranscriptAt: number | null = null;
    let lastTranscriptText = '';
    let manualMode = false;
    let manualBuffer: string[] = [];

    let copilotPipelineSize = 0;
    let copilotFilteredCount = 0;
    let copilotPassedCount = 0;

    const copilotContextWindow: string[] = [];

    // ─── Copilot batch processor ───
    const sendCopilotBatch = async () => {
      if (copilotBuffer.length === 0) return;
      if (copilotInflight) {
        console.log(`[${sessionId}] Copilot: deferring batch (in-flight request)`);
        return;
      }

      const batchItemCount = copilotBuffer.length;
      const batch = copilotBuffer.join(' ');
      copilotBuffer = [];

      const trace = createTrace('copilot', batch);
      traceStep(trace, 'debounce_done');

      const nameDetected = containsAssistantName(batch);
      let filterResult: 'RELEVANT' | 'SKIP' | 'ERROR';

      if (nameDetected) {
        console.log(`[${sessionId}] Copilot: "${ASSISTANT_NAME}" detected — skipping filter (${batchItemCount} items, pipeline=${copilotPipelineSize}): "${batch.substring(0, 80)}"`);
        traceStep(trace, 'keyword_bypass');
        filterResult = 'RELEVANT';
        logTranscript('copilot', batch, 'BYPASS');
      } else {
        console.log(`[${sessionId}] Copilot filter (${batchItemCount} items, pipeline=${copilotPipelineSize}): "${batch.substring(0, 80)}"`);
        traceStep(trace, 'filter_start');
        filterResult = await filterWithLLM(batch);
        traceStep(trace, 'filter_done');
        logTranscript('copilot', batch, filterResult);
      }
      trace.filterResult = nameDetected ? `BYPASS(${ASSISTANT_NAME})` : filterResult;

      copilotContextWindow.push(batch);
      while (copilotContextWindow.length > CONTEXT_WINDOW_SIZE) copilotContextWindow.shift();

      if (filterResult === 'SKIP') {
        copilotPipelineSize = Math.max(0, copilotPipelineSize - batchItemCount);
        copilotFilteredCount += batchItemCount;
        console.log(`[${sessionId}] Copilot: filtered out (SKIP) — pipeline=${copilotPipelineSize} filtered=${copilotFilteredCount}`);
        traceFinish(trace);
        drainBuffer();
        return;
      }

      if (filterResult === 'ERROR') {
        console.log(`[${sessionId}] Copilot: filter error, passing through to Opus`);
      }

      let messageForOpus = batch;
      if (copilotContextWindow.length > 1) {
        const prevContext = copilotContextWindow.slice(0, -1);
        messageForOpus = 'Recent conversation context:\n' +
          prevContext.map(t => `- ${t}`).join('\n') +
          '\n\nCurrent: ' + batch;
      }

      copilotInflight = true;
      copilotPassedCount += batchItemCount;

      const safetyTimer = setTimeout(() => {
        if (copilotInflight) {
          console.log(`[${sessionId}] Copilot: safety timeout (${COPILOT_TIMEOUT_MS / 1000}s)`);
          copilotPipelineSize = Math.max(0, copilotPipelineSize - batchItemCount);
          copilotInflight = false;
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
        copilotPipelineSize = Math.max(0, copilotPipelineSize - batchItemCount);
        const t = reply ? reply.trim() : '';
        if (t && !isNoReply(t)) {
          console.log(`[${sessionId}] Copilot hint (pipeline=${copilotPipelineSize}): "${t.substring(0, 80)}"`);
          traceStep(trace, 'display');
          display.showReply(t);
        } else {
          console.log(`[${sessionId}] Copilot: nothing to show (pipeline=${copilotPipelineSize})`);
          traceStep(trace, 'no_reply');
        }
      } catch (e: any) {
        clearTimeout(safetyTimer);
        traceStep(trace, 'opus_error');
        copilotPipelineSize = Math.max(0, copilotPipelineSize - batchItemCount);
        console.error(`[${sessionId}] Copilot error: ${e.message}`);
      } finally {
        copilotInflight = false;
        traceFinish(trace);
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
    const RESUB_BASE_DELAY_MS = 3_000;
    const MAX_RESUB_DELAY_MS = 120_000;

    // ─── Transcription Handler ───
    const handleTranscription = async (data: any) => {
      if (!data.isFinal) return;
      const userText = data.text.trim();
      if (!userText) return;

      lastTranscriptAt = Date.now();
      lastTranscriptText = userText;

      const lower = userText.toLowerCase();

      if (lower.includes('neue session') || lower.includes('new session')) {
        console.log(`[${sessionId}] Session reset`);
        display.showStatus('New session...', 3000);
        try { await openclawClient.sendRaw('/new'); } catch (e) {}
        display.showStatus('Session reset.', 3000);
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
        copilotMode = !copilotMode;
        const state = copilotMode ? 'Copilot ON' : 'Copilot OFF';
        console.log(`[${sessionId}] ${state}`);
        if (copilotDebounceTimer) { clearTimeout(copilotDebounceTimer); copilotDebounceTimer = null; }
        copilotBuffer = [];
        copilotPipelineSize = 0;
        copilotContextWindow.length = 0;
        display.showStatus(state, 3000);
        updateDashboard();
        return;
      }

      const manualPatterns = ['manual mode', 'manuel mode', 'manueller modus'];
      const autoPatterns = ['automatic mode', 'automatischer modus', 'auto mode'];
      if (manualPatterns.some(p => normalized === p)) {
        manualMode = true;
        manualBuffer = [];
        console.log(`[${sessionId}] Manual mode ON`);
        display.showStatus('Manual mode enabled', 3000);
        updateDashboard();
        return;
      }
      if (autoPatterns.some(p => normalized === p)) {
        manualMode = false;
        manualBuffer = [];
        console.log(`[${sessionId}] Auto mode ON`);
        display.showStatus('Auto mode enabled', 3000);
        updateDashboard();
        return;
      }

      if (manualMode && (normalized === 'confirm' || normalized === 'bestätigen' || normalized === 'senden' || normalized === 'send' || normalized === 'commit')) {
        if (manualBuffer.length === 0) {
          display.showStatus('Buffer empty', 2000);
          return;
        }
        const combined = manualBuffer.join(' ');
        const count = manualBuffer.length;
        manualBuffer = [];
        const normalTrace = createTrace('normal', combined);
        logTranscript('normal', combined);
        console.log(`[${sessionId}] Manual confirm (${count} items): "${combined.substring(0, 80)}"`);
        display.showThinking(combined.length > 60 ? combined.substring(0, 60) + '...' : combined);
        traceStep(normalTrace, 'opus_start');
        const reply = await openclawClient.chat(combined, G1_PREFIX, () => display.showWaiting());
        traceStep(normalTrace, 'opus_done');
        const trimmed = reply ? reply.trim() : '';
        if (trimmed && !isNoReply(trimmed)) {
          console.log(`[${sessionId}] Hex: "${reply.substring(0, 80)}"`);
          traceStep(normalTrace, 'display');
          display.showReply(reply);
        } else {
          console.log(`[${sessionId}] Hex: silent (NO_REPLY)`);
          traceStep(normalTrace, 'no_reply');
          display.showStatus('', 100);
        }
        traceFinish(normalTrace);
        return;
      }
      if (manualMode && (normalized === 'clear' || normalized === 'löschen')) {
        const count = manualBuffer.length;
        manualBuffer = [];
        console.log(`[${sessionId}] Manual buffer cleared (${count} items)`);
        display.showStatus('Buffer cleared', 2000);
        return;
      }

      const cancelPatterns = ['cancel', 'abbrechen', 'clear buffer', 'clear display', 'stop', 'stopp'];
      if (cancelPatterns.some(p => normalized === p)) {
        display.cancelAndClear();
        display.showStatus('Cleared.', 1500);
        console.log(`[${sessionId}] Display cleared by user`);
        return;
      }

      if (copilotMode) {
        console.log(`[${sessionId}] Copilot heard: "${userText}"`);
        copilotBuffer.push(userText);
        copilotPipelineSize++;
        if (copilotDebounceTimer) clearTimeout(copilotDebounceTimer);
        copilotDebounceTimer = setTimeout(() => {
          copilotDebounceTimer = null;
          sendCopilotBatch();
        }, COPILOT_DEBOUNCE_MS);
        return;
      }

      if (manualMode) {
        manualBuffer.push(userText);
        console.log(`[${sessionId}] Manual buffer (${manualBuffer.length}): "${userText}"`);
        const preview = manualBuffer.slice(-3).map((t, i) => `${manualBuffer.length - Math.min(3, manualBuffer.length) + i + 1}. ${t.substring(0, 50)}`).join('\n');
        display.showNotification(`Buffer [${manualBuffer.length}]:\n${preview}`, 5000);
        return;
      }

      // Normal mode
      const normalTrace = createTrace('normal', userText);
      logTranscript('normal', userText);
      console.log(`[${sessionId}] User: "${userText}"`);
      display.showThinking(userText);

      traceStep(normalTrace, 'opus_start');
      const reply = await openclawClient.chat(
        userText, G1_PREFIX,
        () => display.showWaiting()
      );
      traceStep(normalTrace, 'opus_done');

      const trimmed = reply ? reply.trim() : '';
      if (trimmed && !isNoReply(trimmed)) {
        console.log(`[${sessionId}] Hex: "${reply.substring(0, 80)}"`);
        traceStep(normalTrace, 'display');
        display.showReply(reply);
      } else {
        console.log(`[${sessionId}] Hex: silent (NO_REPLY)`);
        traceStep(normalTrace, 'no_reply');
        display.showStatus('', 100);
      }
      traceFinish(normalTrace);
    };

    // ─── Transcription Subscribe with auto-resubscribe ───
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
        console.log(`[${sessionId}] Transcription subscribe (basic mode)`);
        unsubTranscription = session.events.onTranscription(handleTranscription);
      }

      resubAttempts = 0;
      console.log(`[${sessionId}] Transcription subscribed`);
    };

    const scheduleResub = () => {
      if (!listening) return;
      if (resubTimer) return;

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

    this.activeSessions.set(sessionId, {
      display,
      toggleMic,
      getMicState: () => listening,
      toggleCopilot: () => {
        copilotMode = !copilotMode;
        const state = copilotMode ? 'Copilot ON' : 'Copilot OFF';
        console.log(`[${sessionId}] ${state} (via API)`);
        if (copilotDebounceTimer) { clearTimeout(copilotDebounceTimer); copilotDebounceTimer = null; }
        copilotBuffer = [];
        copilotPipelineSize = 0;
        copilotContextWindow.length = 0;
        display.showStatus(state, 3000);
        updateDashboard();
        return copilotMode;
      },
      getCopilotState: () => copilotMode,
      getDebugStatus: () => ({
        lastTranscriptAt,
        lastTranscriptText,
        copilotBufferSize: copilotBuffer.length,
        copilotPipelineSize,
        copilotInflight,
        copilotFilteredCount,
        copilotPassedCount,
        listening,
        copilot: copilotMode,
      }),
    });

    // ─── Phone Notifications ───
    const notifDedup = new NotificationDedup((app, count, lastBody) => {
      if (count === 1) {
        display.showNotification(`${app}\n${lastBody}`, 10000);
      } else {
        display.showNotification(`${app} (${count} new)\n${lastBody}`, 10000);
      }
    });

    session.events.onPhoneNotifications((data: any) => {
      const app = data.app || 'Notification';
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

    // ─── Head-Up Toggle ───
    let headUpSince: number | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    session.events.onHeadPosition((data: any) => {
      if (data.position === 'up') {
        headUpSince = Date.now();
        holdTimer = setTimeout(() => {
          if (headUpSince) {
            console.log(`[${sessionId}] Head-up hold → toggle`);
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
      const status = !listening ? 'Hex: Ready' : manualMode ? 'Hex: Manual' : copilotMode ? 'Hex: Copilot' : 'Hex: Auto';
      display.setDashboard(status);
    };
    updateDashboard();

    console.log(`[${sessionId}] Ready. Look up ${HEAD_HOLD_MS / 1000}s to toggle mic.`);
    if (NOTIF_BLOCKLIST.length > 0) {
      console.log(`[${sessionId}] Notification blocklist: ${NOTIF_BLOCKLIST.join(', ')}`);
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    console.log(`[${sessionId}] Ended: ${reason}`);
  }
}

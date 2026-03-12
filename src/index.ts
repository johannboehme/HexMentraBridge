import {
  PACKAGE_NAME, MENTRAOS_API_KEY, OPENCLAW_WS_URL,
  PORT, PUSH_PORT, FILTER_LLM_URL, FILTER_LLM_MODEL,
  ASSISTANT_NAME, NOTIF_BLOCKLIST,
} from './config';
import { TRANSCRIPTS_DIR } from './logger';
import { OpenClawClient } from './openclaw';
import { startPushServer } from './push-server';
import { G1OpenClawBridge } from './bridge';
import type { SessionHandle } from './types';

const activeSessions = new Map<string, SessionHandle>();
const openclawClient = new OpenClawClient();

openclawClient.onUnmatchedMessage = (text) => {
  console.log(`[OpenClaw] Unmatched bot message (ignored — no matching session): "${text.substring(0, 80)}"`);
};

async function main() {
  console.log('G1-OpenClaw Bridge v0.9.0');
  console.log(`  MentraOS: ${PACKAGE_NAME || 'DISABLED (no PACKAGE_NAME)'}`);
  console.log(`  OpenClaw: ${OPENCLAW_WS_URL}`);
  console.log(`  Ports: ${PACKAGE_NAME ? `${PORT} (MentraOS), ` : ''}${PUSH_PORT} (Push API + App WebSocket)`);
  console.log(`  Transcripts: ${TRANSCRIPTS_DIR}`);
  console.log(`  Copilot filter: ${FILTER_LLM_URL ? `${FILTER_LLM_MODEL} @ ${FILTER_LLM_URL}` : 'DISABLED (no FILTER_LLM_URL)'}`);
  console.log(`  Assistant name: "${ASSISTANT_NAME}" (keyword bypass for copilot filter)`);
  if (NOTIF_BLOCKLIST.length > 0) {
    console.log(`  Notification blocklist: ${NOTIF_BLOCKLIST.join(', ')}`);
  }

  try { await openclawClient.connect(); }
  catch (err: any) { console.error('OpenClaw connect failed:', err.message); }

  startPushServer(openclawClient, activeSessions);

  if (PACKAGE_NAME && MENTRAOS_API_KEY) {
    const app = new G1OpenClawBridge(openclawClient, activeSessions);
    await app.start();
    console.log('[MentraOS] Webhook ready — waiting for connections from MentraOS cloud...');
  } else {
    console.log('[MentraOS] Skipped — no PACKAGE_NAME/MENTRAOS_API_KEY. Using G1Claw app WebSocket only.');
  }
}

main().catch(console.error);

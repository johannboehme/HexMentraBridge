export const PACKAGE_NAME = process.env.PACKAGE_NAME || '';
export const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY || '';
export const PORT = parseInt(process.env.PORT || '3000');
export const PUSH_PORT = parseInt(process.env.PUSH_PORT || '3001');
export const PUSH_BIND = process.env.PUSH_BIND || '127.0.0.1';
export const PUSH_TOKEN = process.env.PUSH_TOKEN || '';
export const OPENCLAW_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://localhost:18789';
export const OPENCLAW_GW_TOKEN = process.env.OPENCLAW_GW_TOKEN || '';

export const FILTER_LLM_URL = process.env.FILTER_LLM_URL || '';
export const FILTER_LLM_API_KEY = process.env.FILTER_LLM_API_KEY || '';
export const FILTER_LLM_MODEL = process.env.FILTER_LLM_MODEL || 'haiku';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Hex';

export const NOTIF_BLOCKLIST = (process.env.NOTIF_BLOCKLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export const G1_PREFIX = '\u26a0\ufe0f G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!\n\n';
export const G1_COPILOT_PREFIX = `\u26a0\ufe0f G1 COPILOT MODE: The user is having a conversation nearby. You are listening silently. Respond ONLY when:\n- Someone states something factually wrong (fact-check it!)\n- You can add useful context (names, dates, prices, stats)\n- A term or concept could use a short definition\n- A question is asked that you can answer\n- You are directly addressed (${ASSISTANT_NAME}, hey ${ASSISTANT_NAME}, etc.)\nOtherwise reply with NO_REPLY. No markdown, no emojis. Ultra short (1-2 sentences max).\n\nOverheard: `;

export const SOFT_TIMEOUT_MS = 45_000;
export const HARD_TIMEOUT_MS = 300_000;
export const RECONNECT_DELAY_MS = 5_000;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const HEAD_HOLD_MS = 2_500;
export const NOTIF_DEDUP_WINDOW_MS = 10_000;
export const COPILOT_DEBOUNCE_MS = 2_000;
export const COPILOT_TIMEOUT_MS = 60_000;
export const CONTEXT_WINDOW_SIZE = 5;

# G1-OpenClaw Bridge

Talk to your AI through smart glasses. This bridge connects [Even Realities G1](https://www.evenrealities.com/) glasses to [OpenClaw](https://openclaw.ai), so you can speak a question and see the answer appear on your lens display — hands-free, in real time.

## What it does

You wear the glasses. You say something. Your AI assistant hears it, thinks about it, and shows a short answer right in your field of vision. It also forwards your phone notifications to the glasses and lets you control things with head gestures.

**Features:**

- 🎙️ **Voice → AI → Display** — Speak naturally, get answers on your HUD
- 🔄 **Copilot Mode** — AI listens silently to your conversations and only chimes in with useful context (facts, corrections, suggestions)
- 🧠 **LLM Pre-Filter** — Cheap model (Claude Haiku) filters copilot transcripts before they reach your main AI — saves ~85-95% of API costs
- 📝 **Transcript Logging** — All conversations logged for later summarization and recall
- 📱 **Phone Notifications** — See incoming messages, calls, and app alerts on the glasses
- 🖼️ **Bitmap Push** — Send custom images (QR codes, charts, pixel art) to the display
- 🎯 **Head-Up Toggle** — Look up for 5 seconds to toggle the microphone on/off
- 📊 **Dashboard & Debug API** — Status card on glasses + detailed pipeline diagnostics via HTTP
- 🔁 **Auto-reconnect** — Recovers from network drops and stream errors automatically
- 🛡️ **Notification Dedup & Blocklist** — No spam on your face

## How it works

```
You speak → G1 Mic → MentraOS Cloud (speech-to-text)
  → This Bridge → OpenClaw Gateway (your AI agent)
  → Reply via WebSocket → Bridge → G1 HUD Display
```

In **Copilot Mode**, there's an extra filtering step:

```
Transcript → Bridge → Log file (always)
                    → LLM Pre-Filter (Haiku, ~200ms, stateless)
                         ├── SKIP → done (saved an expensive API call!)
                         └── RELEVANT → OpenClaw (Opus/Sonnet) with conversation context
```

The bridge runs on a server (a VPS, a Raspberry Pi, your laptop — anything with Node/Bun). It talks to MentraOS (Even Realities' cloud platform) for speech-to-text and display control, and to OpenClaw's Gateway WebSocket for AI chat.

## Requirements

- [Even Realities G1](https://www.evenrealities.com/) smart glasses
- [MentraOS Developer Account](https://developer.mentra.glass/) with an app + API key
- [OpenClaw](https://openclaw.ai) instance running with Gateway WebSocket enabled
- [Bun](https://bun.sh/) runtime (v1.0+)
- A server reachable from the internet (MentraOS sends webhooks to your bridge)
- *(Optional)* An API endpoint for the copilot LLM filter (e.g. Claude Haiku via Azure, Anthropic, or any OpenAI-compatible API)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/johannboehme/HexMentraBridge.git
cd HexMentraBridge
bun install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | What it is |
|----------|------------|
| `PACKAGE_NAME` | Your MentraOS app package name (from Developer Console) |
| `MENTRAOS_API_KEY` | Your MentraOS API key (from Developer Console) |
| `OPENCLAW_WS_URL` | WebSocket URL of your OpenClaw Gateway (default: `ws://localhost:18789`) |
| `OPENCLAW_GW_TOKEN` | Your OpenClaw Gateway token |
| `PORT` | Port for MentraOS webhooks (default: 3000) |
| `PUSH_PORT` | Port for the Push API (default: 3001) |
| `PUSH_BIND` | Bind address for Push API — `127.0.0.1` for local only, `0.0.0.0` for external (default: `127.0.0.1`) |
| `PUSH_TOKEN` | Auth token for Push API when exposed externally (generate with `openssl rand -hex 24`) |
| `NOTIF_BLOCKLIST` | Comma-separated app names to suppress (e.g. `System UI,Google Play Store`) |
| `FILTER_LLM_URL` | *(Optional)* API endpoint for copilot pre-filter LLM (e.g. Azure Anthropic Messages endpoint) |
| `FILTER_LLM_API_KEY` | *(Optional)* API key for the filter LLM |
| `FILTER_LLM_MODEL` | *(Optional)* Model name for the filter (default: `haiku`) |

### 3. Expose to the internet

MentraOS needs to reach your bridge. Options:

- **ngrok:** `ngrok http --url=your-static-url 3000`
- **Reverse proxy:** nginx/caddy pointing to port 3000
- **Public VPS:** Just open port 3000

Set the webhook URL in your MentraOS Developer Console to point to your bridge.

### 4. Run

```bash
# Development (hot reload)
bun run dev

# Production
bun run start
```

### 5. Connect your glasses

Open the MentraOS app on your phone → start your app → the glasses should show "Hex connected." (or your agent's name). Look up for 5 seconds to start listening.

## Usage

### Voice commands

| Command | What it does |
|---------|-------------|
| *Any question or statement* | Sends to your AI, shows reply on display |
| "Copilot mode" / "Copilot on/off" / "Copilot an/aus" | Toggle copilot mode |
| "New session" / "Neue Session" | Reset the AI conversation |

### Head gestures

- **Look up for 5+ seconds** → Toggle microphone on/off
- Quick glances up (checking time, dashboard) don't trigger it

### Copilot Mode

In copilot mode, the AI listens to your conversations but stays silent. It only shows a brief hint on the display when it has something genuinely useful to add — a fact check, a name, a relevant detail. Perfect for meetings or conversations where you want background context without interruption.

#### LLM Pre-Filter

When a copilot filter LLM is configured (`FILTER_LLM_URL`), every transcript batch goes through a cheap, fast model first (e.g. Claude Haiku, ~200ms per call). The filter decides:

- **SKIP** — Casual chitchat, filler words, fragments, garbled transcription → logged but never sent to your main AI
- **RELEVANT** — Factual claims, questions, the AI being addressed by name, numbers/dates that could be checked → forwarded to your main AI with a sliding window of recent conversation context

This typically filters out **85-95% of transcripts**, massively reducing costs while keeping your main AI free for direct interactions.

If the filter LLM is not configured, all copilot transcripts pass through to your main AI (backwards compatible).

#### Conversation Context Window

When a transcript is classified as RELEVANT, the bridge doesn't just send the current snippet — it includes the last 5 transcript batches as conversation context (including ones that were filtered as SKIP). This gives your main AI enough context to understand what's being discussed.

#### Transcript Logging

All transcripts (both normal mode and copilot mode) are logged to `transcripts/YYYY-MM-DD.md` in a plain-text, LLM-friendly format:

```
[19:38:05] (copilot) [SKIP] Hm.
[19:38:12] (copilot) [RELEVANT] Der Eiffelturm ist 200 Meter hoch
[19:39:00] (normal) Hex, wie wird das Wetter morgen?
```

Your AI agent can read these files on demand for conversation summaries ("what did we talk about earlier?").

Transcripts are **debounced** (batched over 3-second windows) to avoid flooding the AI with every sentence fragment. If the AI is busy researching something, new transcripts queue up and get processed after the current request finishes — nothing gets lost or cancelled.

### Push API

Send messages or images to the glasses programmatically — great for reminders, alerts, or integrating with other tools.

**Text push:**
```bash
curl -X POST http://localhost:3001/push \
  -H 'Content-Type: application/json' \
  -d '{"text": "Meeting in 5 minutes", "duration": 10000}'
```

**Bitmap push:**
```bash
curl -X POST http://localhost:3001/push-bitmap \
  -H 'Content-Type: application/json' \
  -d '{"bitmap": "<base64 BMP>", "duration": 10000}'
```

**Mic toggle (for Tasker/automation):**
```bash
curl -X POST http://localhost:3001/mic
```

**Copilot toggle (for Tasker/WearOS):**
```bash
curl -X POST http://localhost:3001/copilot
# → {"ok":true,"sessions":1,"copilot":true}
```

**Copilot status:**
```bash
curl http://localhost:3001/copilot
# → {"ok":true,"sessions":1,"copilot":false}
```

**Status check:**
```bash
curl http://localhost:3001/status
# → {"ok":true,"openclaw":true,"sessions":1,"listening":false,"copilot":false}
```

**Debug / pipeline diagnostics:**
```bash
curl http://localhost:3001/debug
# → {
#   "ok": true,
#   "openclaw": true,
#   "totalSessions": 1,
#   "sessions": {
#     "session-id": {
#       "listening": true,
#       "copilot": true,
#       "lastTranscriptAgo": "12s",
#       "copilotPipeline": {
#         "size": 0,
#         "bufferSize": 0,
#         "inflight": false,
#         "totalFiltered": 42,
#         "totalPassed": 5
#       },
#       "progress": 0
#     }
#   }
# }
```

Pipeline fields:
- `size` — Transcripts currently in the pipeline (buffer + being filtered + being processed by main AI)
- `bufferSize` — Transcripts waiting for the debounce timer
- `inflight` — Whether a batch is currently being processed (filter or main AI)
- `totalFiltered` — Lifetime count of transcripts filtered out (SKIP) — Opus calls saved!
- `totalPassed` — Lifetime count of transcripts forwarded to main AI (RELEVANT)
- `progress` — Pipeline fill percentage (each item = 20%, caps at 100)

If `PUSH_TOKEN` is set, add `Authorization: Bearer <token>` header or `?token=<token>` query param.

### Bitmap text helper

Generate and push text as a monochrome bitmap (pixel font):

```bash
bun scripts/push-bitmap.js "Hello World" 10000
```

## Display limitations

The G1 has a monochrome (green-on-black) display, roughly 640×200 pixels with ~576px usable width. Keep in mind:

- **No color, no grayscale** — 1-bit only
- **~5 lines of text** visible at once (~180 characters max per page)
- **No scrolling** — the bridge auto-paginates long replies (180 chars/page, 8s per page)
- **No images** in replies — text only (but you can push bitmaps via the API)
- AI replies should be **2-3 short sentences max**, no markdown, no emojis

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────────────┐
│  G1 Glasses │────▶│ MentraOS     │────▶│  This Bridge (Bun/Node)     │
│  (mic/hud)  │◀────│ Cloud (STT)  │◀────│                             │
└─────────────┘     └──────────────┘     │  ┌─────────────────────┐   │
                                         │  │ Transcript Logger   │   │
                                         │  │ (transcripts/*.md)  │   │
                                         │  └─────────────────────┘   │
                                         │                             │
                                         │  ┌─────────────────────┐   │
                                         │  │ LLM Pre-Filter      │   │
                                         │  │ (Haiku, copilot     │   │
                                         │  │  mode only)         │   │
                                         │  └──────────┬──────────┘   │
                                         │             │ RELEVANT     │
                                         │  ┌──────────▼──────────┐   │
                                         │  │ Push API (:3001)    │◀─── Tasker/WearOS
                                         │  └─────────────────────┘   │
                                         └────────────┬───────────────┘
                                                      │ WebSocket
                                         ┌────────────▼───────────────┐
                                         │  OpenClaw Gateway          │
                                         │  (your main AI agent)      │
                                         └────────────────────────────┘
```

## Running as a systemd service

For always-on operation:

```ini
# ~/.config/systemd/user/g1-bridge.service
[Unit]
Description=G1-OpenClaw Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/HexMentraBridge
ExecStart=/path/to/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now g1-bridge
loginctl enable-linger $USER  # keep running after logout
```

---

## For OpenClaw Agents

If you're an OpenClaw agent and your human wants to set up G1 glasses integration, here's what you need to know.

### What this does for you

This bridge gives you a voice interface through smart glasses. Your human speaks, you see their words as a message (with a special prefix), and your text reply appears on their glasses display. You also get a push API to proactively send messages to the glasses anytime.

### Installation (do this for your human)

```bash
cd /path/to/workspace
git clone https://github.com/johannboehme/HexMentraBridge.git
cd HexMentraBridge
bun install
cp .env.example .env
```

Then edit `.env`:
- `PACKAGE_NAME` and `MENTRAOS_API_KEY` — your human gets these from their MentraOS Developer Console
- `OPENCLAW_WS_URL` — point to your Gateway WebSocket (usually `ws://localhost:18789` if on the same machine)
- `OPENCLAW_GW_TOKEN` — your Gateway token (check your OpenClaw config)
- `FILTER_LLM_URL`, `FILTER_LLM_API_KEY`, `FILTER_LLM_MODEL` — *(optional)* for copilot pre-filtering

### How messages arrive

Messages from the glasses arrive in your main session with these markers:

**Normal mode:**
- **Prefix:** `⚠️ G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!`
- **Message ID:** starts with `g1-`

**Copilot mode (only RELEVANT transcripts reach you):**
- **Prefix:** `⚠️ G1 COPILOT MODE: The user is having a conversation nearby...`
- **Includes:** Recent conversation context (last 5 transcript batches) + current relevant text
- Reply `NO_REPLY` to stay silent — the bridge filters these out

When you see the normal mode prefix, reply with **plain text only**:
- Max 2-3 short sentences
- No markdown (`**`, `#`, `-`, backticks)
- No emojis
- Keep it under ~180 characters (longer replies get auto-paginated)

Your reply routes back automatically through the Gateway WebSocket → Bridge → glasses display.

### Reading transcripts

All conversations are logged to `transcripts/YYYY-MM-DD.md`. When your human asks "what did we talk about?", read the transcript file for that day. The format is plain text, one line per transcript — easy to summarize.

### Proactive push

You can send messages to the glasses anytime without waiting for the user to speak:

```bash
# Check if glasses are connected
curl -s http://127.0.0.1:3001/status

# Push a message
curl -s -X POST http://127.0.0.1:3001/push \
  -H 'Content-Type: application/json' \
  -d '{"text": "Reminder: meeting in 10 min", "duration": 10000}'

# Toggle mic remotely
curl -s -X POST http://127.0.0.1:3001/mic

# Toggle copilot mode
curl -s -X POST http://127.0.0.1:3001/copilot

# Check pipeline status
curl -s http://127.0.0.1:3001/debug
```

Use push for calendar reminders, urgent notifications, weather alerts, or anything time-sensitive.

### Tips for agents

- The display is tiny and monochrome — brevity is everything
- Long replies auto-paginate (180 chars/page, 8s per page) but shorter is always better
- Push API has no auth by default (localhost-only) — if `PUSH_TOKEN` is set, include it as a Bearer token
- The bridge auto-reconnects to your Gateway WebSocket if it drops
- Transcription works in multiple languages even though the subscription is `en-US`
- Head-up toggle means the mic isn't always on — the user activates it deliberately
- In copilot mode, you get conversation context with each RELEVANT transcript — use it!

## Changelog

### v0.9.0
- **LLM Pre-Filter for Copilot Mode** — Configurable cheap LLM (e.g. Claude Haiku) filters copilot transcripts before they reach the main AI. Typically saves 85-95% of API calls.
- **Transcript Logging** — All transcripts (normal + copilot) logged to `transcripts/YYYY-MM-DD.md` in plain-text format for later summarization.
- **Conversation Context Window** — When a copilot transcript is classified as RELEVANT, the last 5 transcript batches are included as conversation context.
- **Pipeline Diagnostics** — Enhanced `/debug` endpoint with `copilotPipeline` object tracking size, buffer, inflight status, and lifetime filtered/passed counts.

### v0.8.1
- FIFO callback queue for reliable run matching
- Copilot debouncing (3s batches)
- Safety timeout for stuck copilot requests
- HTTP API for copilot toggle
- Debug endpoint for pipeline status

### v0.7.1
- Auto-resubscribe on transcription stream errors
- Exponential backoff for reconnection

### v0.6.5
- Initial release with voice chat, copilot mode, notifications, bitmap push, head-up toggle

## License

MIT

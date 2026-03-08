# G1-OpenClaw Bridge

Talk to your AI through smart glasses. This bridge connects [Even Realities G1](https://www.evenrealities.com/) glasses to [OpenClaw](https://openclaw.ai), so you can speak a question and see the answer appear on your lens display — hands-free, in real time.

## What it does

You wear the glasses. You say something. Your AI assistant hears it, thinks about it, and shows a short answer right in your field of vision. It also forwards your phone notifications to the glasses and lets you control things with head gestures.

**Features:**

- 🎙️ **Voice → AI → Display** — Speak naturally, get answers on your HUD
- 📲 **G1Claw App Support** — Direct WebSocket connection from the [G1Claw](https://github.com/johannboehme/g1app) Android app (no MentraOS required)
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

The bridge supports two connection methods to the G1 glasses:

**Via MentraOS (original):**
```
You speak → G1 Mic → MentraOS Cloud (speech-to-text)
  → This Bridge → OpenClaw Gateway (your AI agent)
  → Reply via WebSocket → Bridge → MentraOS → G1 HUD Display
```

**Via G1Claw App (new — better battery, no cloud middleman):**
```
You speak → G1 Mic → G1Claw App (BLE, on-device STT)
  → This Bridge (WebSocket /app-ws) → OpenClaw Gateway
  → Reply via WebSocket → Bridge → G1Claw App → G1 HUD Display
```

Both methods can run simultaneously. MentraOS is optional — if `PACKAGE_NAME` is not set, only the G1Claw WebSocket endpoint starts.

In **Copilot Mode**, there's an extra filtering step (works with both connection methods):

```
Transcript → Bridge → Log file (always)
                    → LLM Pre-Filter (Haiku, ~200ms, stateless)
                         ├── SKIP → done (saved an expensive API call!)
                         └── RELEVANT → OpenClaw (Opus/Sonnet) with conversation context
```

The bridge runs on a server (a VPS, a Raspberry Pi, your laptop — anything with Node/Bun). It talks to MentraOS (Even Realities' cloud platform) for speech-to-text and display control, and/or to the G1Claw Android app via WebSocket. It connects to OpenClaw's Gateway WebSocket for AI chat.

## Requirements

- [Even Realities G1](https://www.evenrealities.com/) smart glasses
- [OpenClaw](https://openclaw.ai) instance running with Gateway WebSocket enabled
- [Bun](https://bun.sh/) runtime (v1.0+)
- **One of:**
  - [G1Claw App](https://github.com/johannboehme/g1app) on an Android phone (recommended — no cloud dependency, better battery)
  - [MentraOS Developer Account](https://developer.mentra.glass/) with an app + API key + a server reachable from the internet
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
| `PACKAGE_NAME` | *(Optional)* Your MentraOS app package name — omit to run without MentraOS |
| `MENTRAOS_API_KEY` | *(Optional)* Your MentraOS API key — required only if `PACKAGE_NAME` is set |
| `OPENCLAW_WS_URL` | WebSocket URL of your OpenClaw Gateway (default: `ws://localhost:18789`) |
| `OPENCLAW_GW_TOKEN` | Your OpenClaw Gateway token |
| `PORT` | Port for MentraOS webhooks (default: 3000) — only used if MentraOS is enabled |
| `PUSH_PORT` | Port for Push API + G1Claw App WebSocket (default: 3001) |
| `PUSH_BIND` | Bind address — `127.0.0.1` for local only, `0.0.0.0` for external (default: `127.0.0.1`) |
| `PUSH_TOKEN` | Auth token for Push API and App WebSocket when exposed externally (generate with `openssl rand -hex 24`) |
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

**Option A — G1Claw App (recommended):**
Install the [G1Claw app](https://github.com/johannboehme/g1app) on your Android phone. In Settings, set the WebSocket URL to `ws://<your-vps>:3001/app-ws` and the auth token to your `PUSH_TOKEN`. Connect to your G1 glasses via BLE, then use Push-to-Talk or Always-On mode.

**Option B — MentraOS:**
Open the MentraOS app on your phone → start your app → the glasses should show "Hex connected." (or your agent's name). Look up for 5 seconds to start listening.

## Usage

### Voice commands

| Command | What it does |
|---------|-------------|
| *Any question or statement* | Sends to your AI, shows reply on display |
| "Copilot mode" / "Copilot on/off" / "Copilot an/aus" | Toggle copilot mode |
| "New session" / "Neue Session" | Reset the AI conversation |
| "Manual mode" / "Manueller Modus" | Buffer transcripts until you say "confirm" / "send" / "submit" |
| "Preview" / "Vorschau" | Show the full manual buffer (paginated) before sending |
| "Backspace" / "Zurück" | Remove the last entry from the manual buffer |
| "Automatic mode" / "Auto mode" | Return to normal (auto-send) mode |
| "Cancel" / "Stop" / "Abbrechen" / "Clear" / "Clear display" / "Clear buffer" | Clear the display, buffer, and cancel pagination |

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

### G1Claw App WebSocket (`/app-ws`)

The G1Claw Android app connects via WebSocket for bidirectional communication. This replaces MentraOS for G1Claw users.

**Endpoint:** `ws://<your-vps>:3001/app-ws`

**Authentication:** If `PUSH_TOKEN` is set, the app must provide it via:
- `Authorization: Bearer <token>` header on the WebSocket upgrade request, or
- `?token=<token>` query parameter

**Messages from App to Bridge:**

```json
// Transcribed text (from on-device or VPS STT)
{"type": "transcription", "text": "How's the weather?"}

// Toggle copilot mode
{"type": "set_mode", "copilot": true}

// Raw audio for server-side STT (future — not yet implemented)
{"type": "audio", "data": "<base64-encoded-pcm>"}

// Keepalive
{"type": "ping"}
```

**Messages from Bridge to App:**

```json
// AI response (display on glasses)
{"type": "ai_response", "text": "Sunny, 22 degrees."}

// Keepalive response
{"type": "pong"}
```

**Behavior:**
- Transcriptions are routed through the same OpenClaw pipeline as MentraOS (same prefixes, same copilot logic)
- Voice commands work the same: "new session"/"neue session" resets the AI, "copilot mode/on/off/an/aus" toggles copilot
- Copilot mode applies the same LLM pre-filter and debounce batching
- Push API messages (`/push`) are also forwarded to connected app clients
- Multiple app clients can connect simultaneously (each gets its own copilot state)
- The app handles all BLE communication and display rendering — the bridge just routes text

**Example (wscat):**
```bash
# Connect
wscat -c "ws://your-vps:3001/app-ws?token=YOUR_TOKEN"

# Send a transcription
> {"type":"transcription","text":"What time is it in Tokyo?"}
< {"type":"ai_response","text":"It's currently 3:42 AM in Tokyo (JST, UTC+9)."}
```

### Bitmap text helper

Generate and push text as a monochrome bitmap (pixel font):

```bash
bun scripts/push-bitmap.js "Hello World" 10000
```

## Display limitations

The G1 has a monochrome (green-on-black) display, roughly 640×200 pixels with ~576px usable width. Keep in mind:

- **No color, no grayscale** — 1-bit only
- **~4 lines of ~40 characters** visible at once
- **No scrolling** — the bridge word-wraps and auto-paginates long replies (4 lines/page, 8s per page). Say "cancel" or "stop" to dismiss.
- **No images** in replies — text only (but you can push bitmaps via the API)
- AI replies should be **2-3 short sentences max**, no markdown, no emojis

## Architecture

```
                                         ┌─────────────────────────────┐
┌─────────────┐     ┌──────────────┐     │  This Bridge (Bun/Node)     │
│  G1 Glasses │────▶│ MentraOS     │────▶│                             │
│  (mic/hud)  │◀────│ Cloud (STT)  │◀────│  Port 3000 (MentraOS)      │
└──────┬──────┘     └──────────────┘     │  (optional)                 │
       │ BLE                             │                             │
┌──────▼──────┐                          │  ┌─────────────────────┐   │
│  G1Claw App │◀────── WebSocket ───────▶│  │ Port 3001           │   │
│  (Android)  │      /app-ws :3001       │  │ Push API + App WS   │◀─── Tasker/WearOS
└─────────────┘                          │  └─────────────────────┘   │
                                         │                             │
                                         │  ┌─────────────────────┐   │
                                         │  │ Transcript Logger   │   │
                                         │  │ + LLM Pre-Filter    │   │
                                         │  └──────────┬──────────┘   │
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
- `OPENCLAW_WS_URL` — point to your Gateway WebSocket (usually `ws://localhost:18789` if on the same machine)
- `OPENCLAW_GW_TOKEN` — your Gateway master token (check your OpenClaw config)
- `PUSH_PORT` — port for Push API + G1Claw WebSocket (default: 3001)
- `PUSH_BIND` — set to `0.0.0.0` if the G1Claw app connects from a phone (not localhost)
- `PUSH_TOKEN` — auth token for Push API and G1Claw WebSocket (generate with `openssl rand -hex 24`)
- `PACKAGE_NAME` and `MENTRAOS_API_KEY` — *(optional)* your human gets these from their MentraOS Developer Console (not needed if using G1Claw app)
- `FILTER_LLM_URL`, `FILTER_LLM_API_KEY`, `FILTER_LLM_MODEL` — *(optional)* for copilot pre-filtering

Then run the one-time device pairing setup:

```bash
bun scripts/setup-device-auth.ts
```

This generates an Ed25519 keypair, saves it to `.device-auth.json`, and pairs the bridge with your Gateway so it gets `operator.read` + `operator.write` scopes. Without this step, `chat.send` will fail with `missing scope: operator.write` — the Gateway strips all scopes from clients without a verified device identity.

> **Note:** `.device-auth.json` contains your private key. It is already in `.gitignore`. Never commit it.

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
- Keep it under ~160 characters (longer replies get word-wrapped and auto-paginated)

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
- Long replies word-wrap and auto-paginate (~4 lines/page, 8s per page) but shorter is always better
- Push API has no auth by default (localhost-only) — if `PUSH_TOKEN` is set, include it as a Bearer token
- The bridge auto-reconnects to your Gateway WebSocket if it drops
- Transcription works in multiple languages even though the subscription is `en-US`
- Head-up toggle means the mic isn't always on — the user activates it deliberately
- In copilot mode, you get conversation context with each RELEVANT transcript — use it!

## Changelog

### v0.11.0
- **Modular refactor** — Split monolithic `src/index.ts` into separate modules (`bridge`, `config`, `display`, `filter`, `openclaw`, `push-server`, etc.) for maintainability.
- **Display word-wrapping** — Text now wraps at ~40 chars/line and paginates at 4 lines/page, matching the G1's actual display dimensions. Previously text could run off screen.
- **Cancel/clear voice commands** — Say "cancel", "stop", "stopp", "abbrechen", "clear buffer", or "clear display" to immediately dismiss the current display and cancel pagination.
- **Docker Compose** — Added `docker-compose.yml` for containerized deployment.

### v0.10.0
- **G1Claw App WebSocket** — New `/app-ws` WebSocket endpoint on port 3001 for direct communication with the [G1Claw](https://github.com/johannboehme/g1app) Android app. Receives transcriptions, sends AI responses back. Full copilot mode support (same filter/debounce pipeline as MentraOS sessions).
- **MentraOS now optional** — `PACKAGE_NAME` and `MENTRAOS_API_KEY` are no longer required. Omit them to run in G1Claw-only mode. Both MentraOS and G1Claw can run simultaneously.
- **Push API extended** — `/push` messages are now also forwarded to connected G1Claw app clients via WebSocket.
- **Status/Debug extended** — `/status` and `/debug` endpoints now include connected G1Claw app client information.

### v0.9.1
- **Device Auth (required)** — Bridge now performs proper Ed25519 device pairing with the OpenClaw Gateway. This grants `operator.read` + `operator.write` scopes so `chat.send` works correctly. Run `bun scripts/setup-device-auth.ts` once after install.
- **`scripts/setup-device-auth.ts`** — One-shot pairing script: generates keypair, connects to Gateway, saves device token to `.device-auth.json`.
- **Bug fix:** Previously, the bridge connected successfully but all `chat.send` calls failed with `missing scope: operator.write` because the Gateway strips scopes from clients without a verified device identity (even if the master token matches).

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

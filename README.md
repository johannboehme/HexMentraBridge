# G1-OpenClaw Bridge

Talk to your AI through smart glasses. This bridge connects [Even Realities G1](https://www.evenrealities.com/) glasses to [OpenClaw](https://openclaw.ai), so you can speak a question and see the answer appear on your lens display — hands-free, in real time.

## What it does

You wear the glasses. You say something. Your AI assistant hears it, thinks about it, and shows a short answer right in your field of vision. It also forwards your phone notifications to the glasses and lets you control things with head gestures.

**Features:**

- 🎙️ **Voice → AI → Display** — Speak naturally, get answers on your HUD
- 🔄 **Copilot Mode** — AI listens silently to your conversations and only chimes in with useful context (facts, corrections, suggestions)
- 📱 **Phone Notifications** — See incoming messages, calls, and app alerts on the glasses
- 🖼️ **Bitmap Push** — Send custom images (QR codes, charts, pixel art) to the display
- 🎯 **Head-Up Toggle** — Look up for 5 seconds to toggle the microphone on/off
- 📊 **Dashboard** — Status card visible when you glance up
- 🔁 **Auto-reconnect** — Recovers from network drops and stream errors automatically
- 🛡️ **Notification Dedup & Blocklist** — No spam on your face

## How it works

```
You speak → G1 Mic → MentraOS Cloud (speech-to-text)
  → This Bridge → OpenClaw Gateway (your AI agent)
  → Reply via WebSocket → Bridge → G1 HUD Display
```

The bridge runs on a server (a VPS, a Raspberry Pi, your laptop — anything with Node/Bun). It talks to MentraOS (Even Realities' cloud platform) for speech-to-text and display control, and to OpenClaw's Gateway WebSocket for AI chat.

## Requirements

- [Even Realities G1](https://www.evenrealities.com/) smart glasses
- [MentraOS Developer Account](https://developer.mentra.glass/) with an app + API key
- [OpenClaw](https://openclaw.ai) instance running with Gateway WebSocket enabled
- [Bun](https://bun.sh/) runtime (v1.0+)
- A server reachable from the internet (MentraOS sends webhooks to your bridge)

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
| "Copilot mode" / "Copilot on" / "Copilot off" | Toggle copilot mode |
| "New session" / "Neue Session" | Reset the AI conversation |

### Head gestures

- **Look up for 5+ seconds** → Toggle microphone on/off
- Quick glances up (checking time, dashboard) don't trigger it

### Copilot Mode

In copilot mode, the AI listens to your conversations but stays silent. It only shows a brief hint on the display when it has something genuinely useful to add — a fact check, a name, a relevant detail. Perfect for meetings or conversations where you want background context without interruption.

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

**Status check:**
```bash
curl http://localhost:3001/status
```

If `PUSH_TOKEN` is set, add `Authorization: Bearer <token>` header or `?token=<token>` query param.

### Bitmap text helper

Generate and push text as a monochrome bitmap (pixel font):

```bash
bun scripts/push-bitmap.js "Hello World" 10000
```

## Display limitations

The G1 has a monochrome (green-on-black) display, roughly 640×400 pixels. Keep in mind:

- **No color, no grayscale** — 1-bit only
- **~4 lines of text** visible at once
- **No scrolling** — the bridge auto-paginates long replies (250 chars/page, 8s per page)
- **No images** in replies — text only (but you can push bitmaps via the API)
- AI replies should be **2-3 short sentences max**, no markdown, no emojis

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  G1 Glasses │────▶│ MentraOS     │────▶│  This Bridge    │
│  (mic/hud)  │◀────│ Cloud (STT)  │◀────│  (Bun/Node)     │
└─────────────┘     └──────────────┘     │                 │
                                         │  ┌───────────┐  │
                                         │  │ Push API  │◀─── Tasker/WearOS/scripts
                                         │  └───────────┘  │
                                         └────────┬────────┘
                                                  │ WebSocket
                                         ┌────────▼────────┐
                                         │  OpenClaw       │
                                         │  Gateway        │
                                         │  (your AI agent)│
                                         └─────────────────┘
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

### How messages arrive

Messages from the glasses arrive in your main session with these markers:

- **Prefix:** `⚠️ G1 BRIDGE DISPLAY: Use only 2-3 short sentences, no markdown, no emojis!`
- **Message ID:** starts with `g1-` (e.g. `g1-1770397399536`)

When you see this prefix, reply with **plain text only**:
- Max 2-3 short sentences
- No markdown (`**`, `#`, `-`, backticks)
- No emojis
- Keep it under ~250 characters (longer replies get auto-paginated)

Your reply routes back automatically through the Gateway WebSocket → Bridge → glasses display.

### Copilot mode messages

When copilot mode is active, messages arrive with a different prefix:

`⚠️ G1 COPILOT MODE: The user is having a conversation nearby...`

In this mode, only reply if you have genuinely useful context. Reply `NO_REPLY` (or any response starting with `NO_REPLY`) to stay silent — the bridge filters these out.

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
```

Use push for calendar reminders, urgent notifications, weather alerts, or anything time-sensitive.

### Tips for agents

- The display is tiny and monochrome — brevity is everything
- Long replies auto-paginate (250 chars/page, 8s per page) but shorter is always better
- Push API has no auth by default (localhost-only) — if `PUSH_TOKEN` is set, include it as a Bearer token
- The bridge auto-reconnects to your Gateway WebSocket if it drops
- Transcription works in multiple languages even though the subscription is `en-US`
- Head-up toggle means the mic isn't always on — the user activates it deliberately

## License

MIT

# G1-OpenClaw Bridge 🧪

Bridge between **Even Realities G1** smart glasses (via MentraOS SDK) and **OpenClaw**.

Speak to your glasses → OpenClaw processes → response appears on your HUD.

## Setup

1. Install dependencies:
```bash
bun install
```

2. Copy and fill in env:
```bash
cp .env.example .env
# Edit .env with your MentraOS API key, package name, and OpenClaw details
```

3. Expose to internet (dev):
```bash
ngrok http --url=<your-static-url> 3000
```

4. Run:
```bash
bun run dev
```

5. Open MentraOS on your phone → start the app → speak!

## Architecture

```
G1 Glasses (mic) → MentraOS Cloud (transcription) → This Bridge → OpenClaw API → Bridge → MentraOS Cloud → G1 HUD Display
```

## TODO

- [ ] Test German transcription support
- [ ] OpenClaw API integration (need to verify endpoint format)
- [ ] Handle long responses (pagination/scrolling on HUD)
- [ ] Wake word / activation phrase
- [ ] Error handling & reconnection

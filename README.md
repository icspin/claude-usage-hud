# Claude Usage HUD

A translucent, always-on-top desktop overlay that shows **live cost and token usage for Claude Code** — per session, per model, per day, and per 5-hour rate-limit window. Everything is computed locally from the transcript files Claude Code already writes to `~/.claude/projects`; nothing is sent anywhere.

![overview](docs/screenshot.png)

## Why

Different models cost very different amounts (Fable 5 is $10/$50 per MTok, Opus 5 is $5/$25, Sonnet 5 is $3/$15, Haiku 4.5 is $1/$5 — and cache reads/writes bill at 0.1× / 1.25× / 2× the input rate). This HUD keeps that cost visible while you work so you can build an intuition for what different jobs and models actually consume.

On a Pro/Max subscription the numbers are **API-equivalent value**, not a bill — still the best single yardstick for "how big was that job?"

## Features

- **Compact view (default)** — resize the window and the whole panel scales with it; a tick mark on each limit bar shows where an evenly-paced user would be right now, so you can see at a glance whether you are ahead of or behind pace. The "where am I at" bars: official **Session (5h)** and **Weekly** rate-limit utilization with reset times (including model-scoped weekly limits like a separate Fable cap), current session **context fill %**, and today/week/month spend. The official percentages come from the same endpoint Claude Code's `/usage` screen uses, via the OAuth token in `~/.claude/.credentials.json`; if the token is stale, run the `claude` CLI once to refresh it (the HUD falls back to transcript-computed numbers meanwhile). Toggle compact ⇄ full with the ⤢ button.
- **Overview** — today / 7-day / month / all-time cost, the current 5-hour block with time remaining, and live sessions with per-session cost and **context-window fill %**
- **Sessions** — every session with duration, token breakdown (in / out / cache-read / cache-write), and cost
- **Models** — cost share per model, full token-type breakdown
- **Daily** — 30-day bar chart and table
- **5h Blocks** — usage grouped into the same 5-hour windows the subscription rate limits use
- **Settings** — idle opacity, refresh interval, always-on-top, launch-at-login, and a fully editable pricing table

### Overlay behavior

- Translucent when idle, fades to full opacity on hover (works in pinned mode too — hover is detected by cursor position, not CSS)
- Drag the title bar to move the window; resize from any edge
- **Pin** (📌 button, tray menu, or `Ctrl+Alt+U`): the window becomes click-through — you can click straight through it while it stays visible. To unpin: **rest the cursor on the pin button for about a second** — a ring fills as you dwell, then it releases — or press `Ctrl+Alt+U`, or use the tray icon. Hovering reaches nothing underneath, so unpinning never disturbs the app below.
- **Right-click and drag** across the panel body to set its resting opacity (the level it sits at when you are not hovering, and while pinned). A readout follows the drag.
- Lives in the system tray; closing just hides it

### Taskbar strip

A thin, brightly coloured strip laid over the empty left end of the **primary monitor's taskbar** (Windows 11 has no deskband API, so it is a topmost window kept exactly on the taskbar). With it on, the HUD starts hidden and lives behind the strip.

- **Usage panel** (violet): the official limit bars with the same even-pace notch as the HUD, plus today's and this week's spend. Stale numbers are dimmed. **Click** to show or hide the full HUD just above it.
- **Capture panel** (optional): if `captureDashboard` is set in `settings.json`, a second panel shows a local capture pipeline's state. Line 1 counts what is active (`2 REC · 1 RENDER · 1 UPLOAD · 3 QUEUED`), line 2 cycles through each item every 4 s. Colour is the most urgent state: red = recording, amber = failure / runner down / dashboard offline, blue = rendering or uploading, green = idle and healthy. **Click** to pop the dashboard up above the strip; click anywhere else and it hides.
- Hides itself while a fullscreen app covers the primary display, like the real taskbar.
- Toggle from the tray menu (**Taskbar strip**) or right-click the strip. Width and offset: `stripWidth`, `stripOffset` in `settings.json`.

```json
"captureDashboard": {
  "url": "http://127.0.0.1:8791",
  "startExe": "C:\path\to\pythonw.exe",
  "startArgs": ["C:\path\to\dashboard.py", "--port", "8791"]
}
```

The dashboard must serve `GET <url>/api/state` returning `{ inflight: [...], runners: [...], archives: [...] }`. If the URL refuses connections and `startExe` is set, the strip starts it (at most every 5 minutes).

> **PowerToys FancyZones users:** FancyZones moves and resizes newly created windows by default (*Move newly created windows to their last known zone* / *to the current active monitor*, with *Restore original size* off). That will relocate this window to another monitor and stretch it to a zone on every launch. Add `Claude Usage HUD.exe` under **FancyZones → Excluded apps** and it will stay exactly where you left it.

## Install

**From a release:** download the installer (`Claude Usage HUD-x.y.z-x64.exe`) or the portable exe from the Releases page and run it.

**From source:**

```bash
git clone https://github.com/icspin/claude-usage-hud
cd claude-usage-hud
npm install
npm start
```

Build a Windows installer + portable exe:

```bash
npm run dist
```

## How it works

Claude Code logs every assistant message — with model id and exact token usage (input, output, cache reads, and cache writes split by 5-minute vs 1-hour TTL) — to JSONL transcripts under `~/.claude/projects/`. The HUD:

1. Scans those files (incrementally — only re-parsing files that changed)
2. Deduplicates streamed messages by message id + request id
3. Prices each message with a configurable per-model rate table
4. Aggregates by session, model, day, and 5-hour block

Set `CLAUDE_CONFIG_DIR` if your Claude config lives somewhere other than `~/.claude`.

## Default pricing (USD per 1M tokens)

| Model | Input | Output |
|---|---|---|
| Fable 5 / Mythos 5 | $10 | $50 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $25 |
| Opus 4.1 / 4.0 | $15 | $75 |
| Sonnet (all) | $3 | $15 |
| Haiku 4.5 | $1 | $5 |
| Haiku 3.5 | $0.80 | $4 |

Cache read = 0.1× input · cache write = 1.25× (5m TTL) / 2× (1h TTL). All of it is editable in **Settings → Pricing** (e.g. Sonnet 5's intro pricing of $2/$10 through 2026-08-31).

## Privacy

100% local. The app reads files from your `~/.claude` directory and renders them. No network requests, no telemetry.

## License

MIT

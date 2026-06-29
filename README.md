# Hermes Agents

MetroPrints AI agent fleet — autonomous Slack bots powered by DeepSeek LLM, Socket Mode, and launchd persistence.

## Active Agents

| Agent | Role | Status |
|-------|------|--------|
| **Casey** | Case management — intake, FBI PrintDeck, compliance, escalations | ✅ Live |
| **Metro** | Ops intelligence — snapshots, briefings, pipeline health, content | ✅ Live |
| **Penny** | Finance oversight — revenue, expenses, anomaly detection | 📋 Planned |
| **Cal** | Scheduling — appointments, operator availability | 📋 Planned |

## Quick Deploy

```bash
node scripts/hermes-deploy.mjs <name> <xapp> <xoxb> <bot-user-id> "description"
```

Example:
```bash
node scripts/hermes-deploy.mjs Penny xapp-1-... xoxb-... U1234 "Finance oversight agent"
```

Creates listener, launchd plist, manifest — agent live in 30 seconds.

## Features (all agents)

- 128K context window with auto-folding at 15K tokens
- 30-minute active thread window (no @mention needed after first reply)
- Deduplication (no double responses)
- Notion API integration
- Obsidian vault knowledge loading
- Website uptime monitoring
- Gmail IMAP support (needs app password)
- launchd persistence with auto-restart

## Architecture

```
Mac (launchd)
├── com.metroprints.casey.listener  → listener.mjs (Socket Mode + LLM)
├── com.metroprints.metro.listener  → listener.mjs (Socket Mode + LLM)
│
Slack API
├── Socket Mode (xapp token) → real-time events
├── Bot Token (xoxb) → HTTP API calls
└── Slash Commands → natural interactions
```

## Documentation

- `agents/<name>/listener.mjs` — Agent source code
- `agents/<name>/manifest.json` — Slack app manifest
- `listener-template.mjs` — Canonical template for new agents
- `scripts/hermes-deploy.mjs` — One-command deploy script

## Requirements

- Node.js 22+ (native WebSocket)
- DeepSeek API key
- Slack bot + app-level tokens
- macOS (launchd) or Linux (systemd)

## License

Private — MetroPrints, LLC

---
name: configure-notify
description: >
  Help user configure Pi notification settings — platforms (native, Gotify, Telegram),
  events, and per-event routing. Guide through setup or make changes directly.
---

# Configure Notify

Help users configure the `@pi-unipi/notify` notification system.

## When to use

- User asks to set up notifications
- User asks to enable/configure Gotify, Telegram, or native notifications
- User wants to change which events trigger notifications
- User asks about notification settings

## Config location

`~/.unipi/config/notify/config.json`

## Config structure

```json
{
  "defaultPlatforms": ["native"],
  "events": {
    "workflow_end": { "enabled": true, "platforms": [] },
    "ralph_loop_end": { "enabled": true, "platforms": [] },
    "mcp_server_error": { "enabled": true, "platforms": [] },
    "agent_end": { "enabled": false, "platforms": [] },
    "memory_consolidated": { "enabled": false, "platforms": [] },
    "session_shutdown": { "enabled": false, "platforms": [] }
  },
  "native": {
    "enabled": true,
    "windowsAppId": null
  },
  "gotify": {
    "enabled": false,
    "serverUrl": null,
    "appToken": null,
    "priority": 5
  },
  "telegram": {
    "enabled": false,
    "botToken": null,
    "chatId": null
  }
}
```

## Platforms

### Native OS (default: enabled)

Desktop notifications via node-notifier. Works out of the box on Windows, macOS, Linux.

### Gotify (default: disabled)

Self-hosted push notification server. Requires:
- `serverUrl` — URL of your Gotify server (e.g. `https://gotify.example.com`)
- `appToken` — Application token from Gotify web UI (Apps → Create Application)
- `priority` — 1-10 (default: 5)

**Setup options:**
1. **Interactive overlay:** Tell user to run `/unipi:notify-set-gotify` for guided setup with connection test
2. **Manual config:** Edit `config.json` directly with the fields above
3. **Agent can write config:** Read the current config, merge changes, write back

### Telegram (default: disabled)

Bot API notifications. Requires:
- `botToken` — From @BotFather
- `chatId` — Auto-detected by `/unipi:notify-set-tg`

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:notify-settings` | TUI overlay to toggle platforms and events |
| `/unipi:notify-set-gotify` | Interactive Gotify setup wizard |
| `/unipi:notify-set-tg` | Interactive Telegram setup wizard |
| `/unipi:notify-test` | Send test notification to all enabled platforms |

## Events

| Event | Default | Description |
|-------|---------|-------------|
| `workflow_end` | On | Workflow command completes |
| `ralph_loop_end` | On | Ralph loop completes |
| `mcp_server_error` | On | MCP server error |
| `agent_end` | Off | Agent finishes responding |
| `memory_consolidated` | Off | Memory auto-saved |
| `session_shutdown` | Off | Session ends |

Each event can override `platforms` — empty array means use `defaultPlatforms`.

## Agent workflow

### Reading current config

```bash
cat ~/.unipi/config/notify/config.json
```

### Updating config programmatically

Read the JSON, make changes, write it back. Example:

```json
// To enable Gotify:
{
  "gotify": {
    "enabled": true,
    "serverUrl": "https://gotify.example.com",
    "appToken": "AT_xxxxx",
    "priority": 7
  }
}
```

### Guiding user to interactive setup

For Gotify: suggest running `/unipi:notify-set-gotify`
For Telegram: suggest running `/unipi:notify-set-tg`
For general settings: suggest `/unipi:notify-settings`

## Validation rules

- Gotify: `serverUrl` and `appToken` required when enabled
- Gotify: `priority` must be 1-10
- Telegram: `botToken` and `chatId` required when enabled

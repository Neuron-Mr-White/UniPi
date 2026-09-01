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

## Config locations

**Main config (platforms + events):** `~/.unipi/config/notify/config.json`

**ntfy config (dedicated file):**
- Global: `~/.unipi/config/notify/ntfy.json`
- Project: `<project>/.unipi/config/notify/ntfy.json`

## Config structure

```json
{
  "defaultPlatforms": ["native"],
  "events": {
    "workflow_end": { "enabled": true, "platforms": [] },
    "ralph_loop_end": { "enabled": true, "platforms": [] },
    "mcp_server_error": { "enabled": true, "platforms": [] },
    "agent_end": { "enabled": false, "platforms": [] },
    "agent_settled": { "enabled": false, "platforms": [] },
    "memory_consolidated": { "enabled": false, "platforms": [] },
    "session_shutdown": { "enabled": false, "platforms": [] },
    "ask_user_prompt": { "enabled": false, "platforms": [] },
    "permission_request": { "enabled": false, "platforms": [] }
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
  },
  "ntfy": {
    "enabled": false,
    "serverUrl": "https://ntfy.sh",
    "topic": null,
    "token": null,
    "priority": 3
  },
  "silenceAfterInput": {
    "enabled": false,
    "windowMs": 10000,
    "platforms": ["native"]
  },
  "NOTE": "ntfy section is legacy — migrated to ntfy.json on first run"
}
```

## Platforms

### Native OS (default: enabled)

Desktop notifications via node-notifier. Works out of the box on Windows, macOS, Linux.

### Silence after input

Quiet listed platforms for `windowMs` after any terminal keypress. **Default: off.** Same `config.json` as other notify settings.

```json
"silenceAfterInput": {
  "enabled": true,
  "windowMs": 10000,
  "platforms": ["native"]
}
```

- `enabled` — master switch
- `windowMs` — quiet window in milliseconds (default: 10000)
- `platforms` — channels to silence (`native`, `gotify`, `telegram`, `ntfy`). Empty list silences all enabled platforms (same as `events.*.platforms`).

TUI: `/unipi:notify-settings` → Platforms → 在操作后短暂静默 (Space), ←→ then Space for channels, +/− for the window (1s steps).

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

### ntfy (default: disabled)

Simple HTTP-based pub-sub notification service. Supports public [ntfy.sh](https://ntfy.sh) and self-hosted instances.
Requires:
- `serverUrl` — ntfy server URL (default: `https://ntfy.sh`)
- `topic` — Topic name to publish to (acts as a channel)
- `token` — Optional access token for authenticated servers
- `priority` — 1-5 (default: 3)

**Setup options:**
1. **Interactive overlay:** Run `/unipi:notify-set-ntfy` for guided setup with scope selection and connection test
2. **Manual config:** Edit `ntfy.json` directly (see Project-Level ntfy Config below)
3. **Agent can write config:** Read the current ntfy.json, merge changes, write back

### Project-Level ntfy Config

ntfy uses dedicated `ntfy.json` files at both global and project scope, with full override semantics.

**File locations:**
- Global: `~/.unipi/config/notify/ntfy.json` (all projects)
- Project: `<project>/.unipi/config/notify/ntfy.json` (this project only)

**Resolution order (at dispatch time):**
1. Project `ntfy.json` exists → use it (full override)
2. No project config → use global `ntfy.json`
3. Neither exists → ntfy is effectively disabled

**ntfy.json shape:**
```json
{
  "enabled": true,
  "serverUrl": "https://ntfy.sh",
  "topic": "my-project-alerts",
  "token": null,
  "priority": 3
}
```

**Scope selection in wizard:** When running `/unipi:notify-set-ntfy`, the wizard now asks where to save the config (Global or Project). Re-running the wizard pre-selects the current scope and pre-fills existing values.

**Settings overlay:** The ntfy line in `/unipi:notify-settings` shows topic, priority, and scope label (`[project]`, `[global]`, or "Not configured").

**Migration:** On first run, if `config.json` has ntfy settings and `ntfy.json` doesn't exist, settings are automatically migrated to `ntfy.json`. The legacy `config.json` ntfy section is left untouched for backward compatibility.

**Manual config:** Edit the appropriate `ntfy.json` file directly with the fields above.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:notify-settings` | TUI overlay to toggle platforms and events |
| `/unipi:notify-set-gotify` | Interactive Gotify setup wizard |
| `/unipi:notify-set-tg` | Interactive Telegram setup wizard |
| `/unipi:notify-set-ntfy` | Interactive ntfy setup wizard |
| `/unipi:notify-test` | Send test notification to all enabled platforms |

## Events

| Event | Default | Description |
|-------|---------|-------------|
| `workflow_end` | On | Workflow command completes |
| `ralph_loop_end` | On | Ralph loop completes |
| `mcp_server_error` | On | MCP server error |
| `agent_end` | Off | Low-level agent run ends (may fire again on retries) |
| `agent_settled` | Off | Agent fully settles after retries, compaction, and queued continuations |
| `memory_consolidated` | Off | Memory auto-saved |
| `session_shutdown` | Off | Session ends |
| `ask_user_prompt` | Off | Agent asked a question and is waiting for an answer |
| `permission_request` | Off | A permission prompt is about to be shown |

Each event can override `platforms` — empty array means use `defaultPlatforms`.

### `permission_request`

Fires on the `permissions:ui_prompt` broadcast from
[`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system),
emitted immediately before the user-facing permission UI is invoked. Policy
auto-allow, policy deny, session approvals, and infrastructure auto-allowed
requests do **not** emit it, so this event does not produce notification spam.
Forwarded subagent prompts are handled too — the parent UI session emits the
event right before showing the forwarded dialog, and the notification is
suffixed with `(forwarded)`.

The notification is formatted defensively from the payload's `agentName`,
`surface`, `value` and `message` fields:

```text
Pi — Permission Request
Current agent requested bash 'npm test'. Allow this command?
```

Enable it when you run Pi in a background pane and don't want to miss a
permission prompt. If the permission system is not installed the event simply
never fires.

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
For ntfy: suggest running `/unipi:notify-set-ntfy`
For general settings: suggest `/unipi:notify-settings`

## Validation rules

- Gotify: `serverUrl` and `appToken` required when enabled
- Gotify: `priority` must be 1-10
- Telegram: `botToken` and `chatId` required when enabled
- ntfy: `serverUrl` and `topic` required when enabled
- ntfy: `priority` must be 1-5

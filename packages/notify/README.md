# @pi-unipi/notify

Cross-platform notification extension for Pi. Sends push notifications to native OS, Gotify, and Telegram when agent lifecycle events occur.

## What it does

- Listens to Pi lifecycle events (workflow complete, Ralph loop done, MCP errors, etc.)
- Routes notifications to your configured platforms
- Provides `notify_user` tool for agent-initiated notifications
- Per-event platform configuration with sensible defaults

## Installation

Part of the `@pi-unipi/unipi` meta-package. No separate install needed.

## Platforms

### Native OS (default)

Desktop notifications via [node-notifier](https://github.com/mikaelbr/node-notifier):
- **Windows:** SnoreToast (no admin required)
- **macOS:** terminal-notifier
- **Linux:** notify-send / libnotify

Zero configuration — works out of the box.

### Gotify

Self-hosted push notification server. Configure in settings:

```json
{
  "gotify": {
    "enabled": true,
    "serverUrl": "https://your-gotify-server.com",
    "appToken": "your-app-token",
    "priority": 5
  }
}
```

### Telegram

Bot API notifications. Run setup command:

```
/unipi:notify-set-tg
```

This guides you through:
1. Creating a bot via @BotFather
2. Pasting the bot token
3. Auto-detecting your chat ID

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:notify-settings` | Open settings overlay to configure platforms and events |
| `/unipi:notify-set-tg` | Interactive Telegram bot setup |
| `/unipi:notify-test` | Send test notification to all enabled platforms |

## Agent Tool

The `notify_user` tool is available to the agent for ad-hoc notifications:

```
notify_user({
  title: "Build Failed",
  message: "TypeScript compilation failed with 12 errors.",
  priority: "high"
})
```

See the bundled `notify` skill for full parameter documentation.

## Event Configuration

Notifications are triggered by these events (configurable in settings):

| Event | Default | Description |
|-------|---------|-------------|
| `workflow_end` | On | Workflow command completes |
| `ralph_loop_end` | On | Ralph loop completes |
| `mcp_server_error` | On | MCP server error |
| `agent_end` | Off | Agent finishes responding |
| `memory_consolidated` | Off | Memory auto-saved |
| `session_shutdown` | Off | Session ends |

## Configuration

Settings stored at `~/.unipi/config/notify/config.json`. Edit via:
- Settings overlay: `/unipi:notify-settings`
- Manual JSON editing
- The agent can read config via the settings module

## Info-Screen Integration

The notify module registers with the info screen showing:
- Enabled platform count
- Active event subscriptions
- Last notification timestamp
- Total notifications sent this session

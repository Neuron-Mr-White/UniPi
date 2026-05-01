# @pi-unipi/notify

Push notifications when things happen. Workflow finishes, Ralph loop completes, MCP server errors — notify sends alerts to native OS, Gotify, Telegram, or ntfy.

Configure once, get alerts everywhere. Per-event platform routing lets you send critical errors to Telegram and routine completions to Gotify.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:notify-settings` | Open settings overlay to configure platforms and events |
| `/unipi:notify-set-gotify` | Configure Gotify server connection |
| `/unipi:notify-set-tg` | Interactive Telegram bot setup |
| `/unipi:notify-set-ntfy` | Configure ntfy topic and server |
| `/unipi:notify-recap-model` | Set model for notification recaps |
| `/unipi:notify-test` | Send test notification to all enabled platforms |

## Special Triggers

Notify subscribes to Pi lifecycle events and routes notifications based on your config:

| Event | Default | Description |
|-------|---------|-------------|
| `workflow_end` | On | Workflow command completes |
| `ralph_loop_end` | On | Ralph loop completes |
| `mcp_server_error` | On | MCP server error |
| `agent_end` | Off | Agent finishes responding |
| `memory_consolidated` | Off | Memory auto-saved |
| `session_shutdown` | Off | Session ends |

Notify registers with the info-screen dashboard, showing enabled platforms and last notification time. The footer subscribes to `NOTIFICATION_SENT` events to display notification stats.

## Agent Tool

| Tool | Description |
|------|-------------|
| `notify_user` | Send cross-platform notification |

```
notify_user({
  title: "Build Failed",
  message: "TypeScript compilation failed with 12 errors.",
  priority: "high"
})
```

## Platforms

### Native OS

Desktop notifications via [node-notifier](https://github.com/mikaelbr/node-notifier):
- **Windows:** SnoreToast (no admin required)
- **macOS:** terminal-notifier
- **Linux:** notify-send / libnotify

Zero configuration — works out of the box.

### Gotify

Self-hosted push notification server:

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

Bot API notifications. Run `/unipi:notify-set-tg` for interactive setup:
1. Create a bot via @BotFather
2. Paste the bot token
3. Auto-detect your chat ID

### ntfy

HTTP-based pub-sub notifications via [ntfy.sh](https://ntfy.sh) or self-hosted:

```json
{
  "ntfy": {
    "enabled": true,
    "serverUrl": "https://ntfy.sh",
    "topic": "your-topic-name",
    "priority": 3
  }
}
```

## Configurables

Settings stored at `~/.unipi/config/notify/config.json`. Edit via `/unipi:notify-settings` or manual JSON editing.

Per-event platform routing lets you control where each event type goes. The settings overlay shows all events with platform toggles.

## License

MIT

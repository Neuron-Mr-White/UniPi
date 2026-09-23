# @pi-unipi/notify

Push notifications when things happen. Workflow finishes, Ralph loop completes, MCP server errors — notify sends alerts to native OS, Gotify, Telegram, or ntfy.

Configure once, get alerts everywhere. Per-event platform routing lets you send critical errors to Telegram and routine completions to Gotify. Native desktop notifications can also be suppressed while the Pi window is focused.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:settings (Notify)` | Open settings overlay to configure platforms and events |
| `/unipi:notify-set-gotify` | Configure Gotify server connection |
| `/unipi:notify-set-tg` | Interactive Telegram bot setup |
| `/unipi:notify-set-ntfy` | Configure ntfy topic and server |
| `/unipi:notify-recap-model` | Set model for notification recaps |
| `/unipi:notify-event` | Toggle a single event without the TUI (`<event> <on\|off>`) — reports the new value; run `/reload` to re-register listeners |
| `/unipi:notify-test` | Send test notification to all enabled platforms |

## Special Triggers

Notify subscribes to Pi lifecycle events and routes notifications based on your config:

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
| `permission_request` | Off | A permission prompt is about to be shown (requires [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system)) |

`ask_user_prompt` and `permission_request` are **blocking** events: while one is unanswered the agent is parked, so notify re-sends it periodically (see [Re-notify unanswered prompts](#re-notify-unanswered-prompts)).

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

An explicit semantic priority overrides configured urgency for that dispatch on platforms that support it: `low`/`normal`/`high` map to Gotify `2`/`5`/`8` and ntfy `2`/`3`/`5`. Native and Telegram have no priority input and ignore it. When omitted, Gotify and ntfy retain their configured numeric priorities.

## Platforms

### Native OS

Desktop notifications via [node-notifier](https://github.com/mikaelbr/node-notifier):
- **Windows:** SnoreToast (no admin required)
- **macOS:** terminal-notifier
- **Linux:** notify-send / libnotify

Zero configuration — works out of the box. Set `native.suppressWhenFocused` to `true` to skip native notifications when the active/focused window is already Pi.

### Silence after input

After a terminal keypress, listed platforms stay quiet for `windowMs`. Default: **off**, native only, 10s. Edit in `/unipi:settings (Notify)` → Platforms (Quiet after activity + channel chips), or in `~/.unipi/config/notify/config.json`:

```json
{
  "silenceAfterInput": {
    "enabled": true,
    "windowMs": 10000,
    "platforms": ["native"]
  }
}
```

Add `gotify`, `telegram`, or `ntfy` to `platforms` to silence those channels too. Empty `platforms` silences all enabled platforms (same as `events.*.platforms`). Blocking events (`ask_user_prompt`, `permission_request`) are never silenced — see below.

### Re-notify unanswered prompts

When a blocking prompt (`ask_user_prompt`, `permission_request`) is not answered, notify re-sends the same notification every `intervalMs`, with the title suffixed `(still waiting)` and priority `high`, up to `maxRepeats` times. Default: **on**, every 2 minutes, 3 repeats. This is the one notify case where missing the push leaves the agent parked indefinitely.

```json
{
  "renotify": {
    "enabled": true,
    "intervalMs": 120000,
    "maxRepeats": 3
  }
}
```

`maxRepeats: 0` sends the initial notification only. Reminders stop as soon as any of these fires: the user presses a key, herdr reports `herdr:blocked` `active: false`, the agent starts a new turn (`agent_start`), or the session ends. Only one prompt can be outstanding at a time — arming a new one replaces the previous reminder. Reminders bypass `silenceAfterInput` because blocking events are exempt from it.

Edit in `/unipi:settings (Notify)` → Re-notify, or in `~/.unipi/config/notify/config.json`.

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

Settings stored at `~/.unipi/config/notify/config.json`. Edit via `/unipi:settings (Notify)` or manual JSON editing.

Per-event platform routing lets you control where each event type goes. The settings overlay shows all events with platform toggles.

### Recap (thinking models)

Recap summarizes the last assistant message into a one-line push notification (100-token budget). Thinking models served by llama.cpp or vLLM can spend that entire budget on reasoning and return nothing, falling back to a plain 100-character truncation. If your recap endpoint supports chat-template kwargs, set `recap.disableThinking` to skip reasoning tokens:

```json
{
  "recap": {
    "enabled": true,
    "model": "localhost/gemma-4-e4b",
    "disableThinking": true
  }
}
```

This sends `chat_template_kwargs: { enable_thinking: false, preserve_thinking: false }` with the request. Keep it `false` (the default) for strict OpenAI-compatible endpoints — they reject unknown params. Anthropic models are unaffected (thinking is opt-in there).

## License

MIT

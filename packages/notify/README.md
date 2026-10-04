# Notify

Send a notification to your desktop or phone when the agent finishes work or needs an answer.

`@pi-unipi/notify` · part of [UniPi](../../README.md)

## What it does

- Sends notifications to four platforms: native OS, [Gotify](https://gotify.net), Telegram and [ntfy](https://ntfy.sh).
- Sends a notification for each enabled event, for example when a workflow ends or the agent asks a question.
- Lets you route each event to its own platforms.
- Gives the agent a `notify_user` tool.
- Sends a question again every 2 minutes, 3 times at most, until you answer it.
- Can write a one-line summary of the last agent message with a model of your choice ("recap").

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/notify
```

Native OS notifications work with no setup. To add a phone platform:

1. Open `/unipi:settings`.
2. Select the **Notify** group.
3. Open the page for `gotify`, `telegram` or `ntfy`.
4. Set **Enabled** to on.
5. Enter the server URL, token, topic or chat ID.
6. Select **Send test notification** to make sure that it works.

For Telegram, get a bot token from @BotFather. Then enter the token and your chat ID.

## Commands

| Command | What it does |
|---|---|
| `/unipi:notify-event <event> <on\|off>` | Turns one event on or off without the TUI. Run `/reload` after it to apply the change. |

All other controls are in `/unipi:settings` → **Notify**.

## Agent tools

| Tool | What it does |
|---|---|
| `notify_user` | Sends a notification. Takes `message`, and optional `title`, `priority` (`low`, `normal`, `high`) and `platforms`. |

`priority` sets Gotify to 2, 5 or 8 and ntfy to 2, 3 or 5. Native and Telegram ignore it.

```text
notify_user({ title: "Build failed", message: "tsc found 12 errors.", priority: "high" })
```

## Events

| Event | Default | Sent when |
|---|---|---|
| `workflow_end` | on | A workflow command ends. |
| `ralph_loop_end` | on | A ralph loop ends. |
| `mcp_server_error` | on | An MCP server reports an error. |
| `agent_end` | off | One agent run ends. It can occur again after a retry. |
| `agent_settled` | off | The agent stops after all retries, compaction and queued work. |
| `memory_consolidated` | off | Memory saves facts. |
| `session_shutdown` | off | The session ends. |
| `ask_user_prompt` | off | The agent asks you a question and waits. |
| `permission_request` | off | A permission prompt opens. This needs [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system). |
| `input_needed` | off | The agent waits on any prompt while it runs. Covers prompts that send no event of their own — third-party `ask_user` tools, the permission prompt, the plan review. |

`ask_user_prompt` and `permission_request` are blocking events. The agent stops until you answer.

`input_needed` is the catch-all for the same situation: Pi fires it around every blocking prompt, including ones that emit no event of their own. It only fires while the agent is running — prompts you open yourself while the agent is idle (for example `/unipi:settings`) stay quiet — and a prompt already announced as `ask_user_prompt` or `permission_request` is not announced twice. Closing any prompt stops its reminders.

## Settings

Open `/unipi:settings` → **Notify**. The file is `~/.unipi/config/notify/config.json`. A project file at `.unipi/config/notify/config.json` overrides it.

| Key | Default | What it does |
|---|---|---|
| `events.<event>.enabled` | refer to [Events](#events) | Turns the event on or off. |
| `events.<event>.platforms` | `[]` | Platforms for the event. An empty list means all enabled platforms. |
| `native.enabled` | `true` | Turns native OS notifications on or off. |
| `native.suppressWhenFocused` | `false` | Stops native notifications when the Pi window has focus. Works on Windows only. |
| `gotify.serverUrl`, `gotify.appToken`, `gotify.priority` | priority `5` | Gotify server, token and priority (0–10). |
| `telegram.botToken`, `telegram.chatId` | unset | Telegram bot and chat. |
| `ntfy.serverUrl`, `ntfy.topic`, `ntfy.token`, `ntfy.priority` | `https://ntfy.sh`, priority `3` | ntfy server, topic, token and priority (1–5). |
| `silenceAfterInput.enabled` | `false` | Stops notifications for a time after you press a key. |
| `silenceAfterInput.windowMs` | `10000` | Length of that quiet time, in milliseconds. |
| `silenceAfterInput.platforms` | `["native"]` | Platforms to keep quiet. |
| `renotify.enabled` | `true` | Sends a blocking event again until you answer. |
| `renotify.intervalMs` | `120000` | Time between two reminders, in milliseconds. |
| `renotify.maxRepeats` | `3` | Number of reminders after the first notification. `0` sends no reminders. |
| `recap.enabled` | `false` | Summarizes the last agent message for `agent_end` and `agent_settled`. |
| `recap.model` | `openrouter/openai/gpt-oss-20b` | Model for the summary. |
| `recap.disableThinking` | `false` | Asks a llama.cpp or vLLM server to skip reasoning tokens. |

## How it works

A reminder has the text `(still waiting)` in its title and `high` priority. Reminders stop when one of these occurs:

- You press a key.
- herdr reports that the agent is not blocked.
- The agent starts a new turn.
- The prompt closes.
- The session ends.

Only one reminder runs at a time. Silence after input does not apply to blocking events.

Recap sends the last message (2,000 characters at most) to the recap model with a limit of 100 tokens. If the model gives no summary, notify uses the first 100 characters of the message. A thinking model can use all 100 tokens to reason. If your server supports chat template options, set `recap.disableThinking` to `true`. Keep it `false` for a strict OpenAI-compatible server, because that server rejects unknown fields.

Native notifications use [node-notifier](https://github.com/mikaelbr/node-notifier): SnoreToast on Windows, terminal-notifier on macOS and `notify-send` on Linux.

Each sent notification emits a `NOTIFICATION_SENT` event on the [event bus](../../docs/architecture/event-bus.md).

## See also

- [Ask User](../ask-user/README.md)
- [Settings reference](../../docs/reference/settings.md)
- [Event bus](../../docs/architecture/event-bus.md)

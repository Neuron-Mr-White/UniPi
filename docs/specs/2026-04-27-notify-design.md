---
title: "@pi-unipi/notify — Cross-Platform Notification Extension"
type: brainstorm
date: 2026-04-27
---

# @pi-unipi/notify — Cross-Platform Notification Extension

## Problem Statement

Pi users run long agent sessions (Ralph loops, subagent tasks, workflows) and step away from their terminal. When the agent finishes, errors out, or needs user input, the user has no way to know unless they actively check the terminal. Pi's built-in `ctx.ui.notify()` only shows in-app TUI notifications — useless when the user is not looking at the screen.

**Root need:** A notification system that bridges Pi's event lifecycle to external notification platforms (OS-native desktop, Gotify, Telegram), with per-event-type user-configurable toggles, so users never miss important agent activity.

## Context

**Existing patterns in Unipi:**
- `@pi-unipi/web-api`: Provider registry pattern, settings TUI, tool registration with TypeBox schemas, info-screen integration
- `@pi-unipi/memory`: Settings stored in `~/.unipi/config/<module>/`, TUI dialogs via `pi.ui.select/input/notify`
- `@pi-unipi/core`: Event types (`UNIPI_EVENTS`), module discovery via `MODULE_READY`, constants for commands/tools
- `@pi-unipi/info-screen`: Group registration with stats, data providers

**Pi extension hooks available for notifications:**
- `agent_start` / `agent_end` — agent turn lifecycle
- `turn_start` / `turn_end` — individual turns
- `tool_execution_start` / `tool_execution_end` — tool calls
- `session_start` / `session_shutdown` — session lifecycle
- `model_select` — model changes
- `unipi:workflow:start` / `unipi:workflow:end` — unipi workflow events
- `unipi:ralph:loop:start` / `unipi:ralph:loop:end` / `unipi:ralph:iteration:done` — unipi ralph events
- `unipi:mcp:server:error` — unipi mcp events
- `unipi:module:ready` / `unipi:module:gone` — module presence (for dynamic event discovery)

**Libraries researched:**
- `node-notifier` (5.9M weekly downloads): Cross-platform native notifications. Windows uses SnoreToast (no admin required), macOS uses terminal-notifier, Linux uses notify-send. All work without elevated privileges.
- `gotify` npm package: Simple send-only client, app-token based, 5 years old but stable.
- `gotify-client` npm package: Full-featured API client, zero dependencies, TypeScript, tree-shakeable.
- Telegram Bot API: Simple HTTP POST to `https://api.telegram.org/bot<token>/sendMessage`.

## Chosen Approach

**Event-Driven Notification Bus (Approach A)**

A central notification bus that:
1. Listens to pi/unipi lifecycle events via extension hooks
2. Filters events through user-configurable per-event-type toggles
3. Routes matching events to configured platforms (native OS, Gotify, Telegram)
4. Provides an agent tool `notify_user` for ad-hoc notifications
5. Auto-discovers additional events from other unipi modules (e.g., `@pi-unipi/ask-user`)

### Why This Approach

- **Leverages existing events:** Pi already emits rich lifecycle events — no need to modify other modules
- **User control:** Per-event toggles let users choose exactly what they care about
- **Multi-platform:** User can enable multiple platforms simultaneously for redundancy
- **Module discovery:** Dynamic event registration means new modules automatically extend notification capabilities
- **Agent empowerment:** The `notify_user` tool lets the agent proactively notify on critical findings

### Rejected Alternatives

- **Approach B (Simplified "Notify on Completion"):** Too limited — can't handle per-event platform routing or dynamic module events
- **Approach C (Publisher-Subscriber with Module API):** Requires modules to explicitly integrate — misses implicit pi events and creates coupling

## Design

### Architecture

```
packages/notify/
├── index.ts              # Extension entry — event hooks, module discovery
├── tools.ts              # notify_user agent tool registration
├── commands.ts           # /unipi:notify-settings, /unipi:notify-set-tg
├── settings.ts           # Config storage (~/.unipi/config/notify/)
├── platforms/
│   ├── native.ts         # node-notifier wrapper (Windows/Mac/Linux)
│   ├── gotify.ts         # Gotify client wrapper
│   └── telegram.ts       # Telegram Bot API wrapper
├── tui/
│   ├── settings-overlay.ts   # Main settings TUI
│   └── telegram-setup.ts     # /unipi:notify-set-tg animated overlay
├── events.ts             # Event subscription registry
├── types.ts              # TypeScript interfaces
├── skills/
│   └── notify/
│       └── SKILL.md      # Bundled skill
└── README.md
```

### Extension Entry (index.ts)

1. **On `session_start`:**
   - Load notification settings from `~/.unipi/config/notify/`
   - Register event listeners for all enabled event types
   - Emit `MODULE_READY` event
   - Register info-screen group

2. **On `unipi:module:ready`:**
   - Check if module exposes notification events (via module event payload)
   - Auto-register listeners for discovered events
   - Example: `@pi-unipi/ask-user` exposes `ask_user_shown`, `ask_user_responded`

3. **On `session_shutdown`:**
   - Clean up all event listeners

### Event Subscription System

**Built-in event sources** (always available):

| Event Key | Pi Hook | Description | Default |
|-----------|---------|-------------|---------|
| `agent_end` | `agent_end` | Agent finishes responding | Off |
| `workflow_end` | `unipi:workflow:end` | Workflow command completes | On |
| `ralph_loop_end` | `unipi:ralph:loop:end` | Ralph loop completes | On |
| `mcp_server_error` | `unipi:mcp:server:error` | MCP server error | On |
| `memory_consolidated` | `unipi:memory:consolidated` | Memory auto-saved | Off |
| `session_shutdown` | `session_shutdown` | Session ends | Off |
| `ask_user_shown` | Dynamic | Ask-user dialog shown | On (if ask-user present) |
| `ask_user_responded` | Dynamic | Ask-user dialog responded | Off |

**Per-event configuration:**
```typescript
interface EventNotifyConfig {
  enabled: boolean;
  platforms: ("native" | "gotify" | "telegram")[];
}
```

If `platforms` is empty, inherits global default platforms.

### Platform Configuration

**Settings stored in `~/.unipi/config/notify/config.json`:**

```typescript
interface NotifyConfig {
  /** Global default platforms for all events */
  defaultPlatforms: ("native" | "gotify" | "telegram")[];
  /** Per-event overrides */
  events: Record<string, EventNotifyConfig>;
  /** Native platform settings */
  native: {
    enabled: boolean;
    /** Windows appID to show instead of "SnoreToast" */
    windowsAppId?: string;
  };
  /** Gotify settings */
  gotify: {
    enabled: boolean;
    serverUrl?: string;
    appToken?: string;
    priority: number; // 1-10, default 5
  };
  /** Telegram settings */
  telegram: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
  };
}
```

**Native (node-notifier):**
- Zero config — works out of the box
- Windows: SnoreToast (no admin needed). Optional `windowsAppId` to replace "SnoreToast" text
- macOS: terminal-notifier
- Linux: notify-send / libnotify

**Gotify:**
- Uses `gotify` package (simple send-only client)
- Requires `serverUrl` and `appToken`
- Supports custom priority per message

**Telegram:**
- Direct HTTP POST to Bot API
- Requires `botToken` and `chatId`
- Setup via `/unipi:notify-set-tg` command

### Telegram Setup Command (`/unipi:notify-set-tg`)

An interactive TUI overlay that:
1. Shows instructions: "1. Open Telegram and message @BotFather to create a bot. 2. Copy the bot token. 3. Send any message to your bot."
2. Prompts for bot token via `pi.ui.input`
3. Shows animated overlay with spinner: "Waiting for first message from your bot..."
4. Polls `getUpdates` API every 2 seconds in background
5. On first message received → extracts `chat_id`, shows success, saves config
6. Timeout after 5 minutes

### Agent Tool: `notify_user`

**Parameters (TypeBox schema):**
```typescript
Type.Object({
  message: Type.String({ description: "Notification message body" }),
  title: Type.Optional(Type.String({ description: "Notification title" })),
  priority: Type.Optional(Type.String({
    enum: ["low", "normal", "high"],
    default: "normal",
    description: "Priority level"
  })),
  platforms: Type.Optional(Type.Array(Type.String({
    enum: ["native", "gotify", "telegram"]
  }), { description: "Override platforms for this notification" })),
})
```

**Behavior:**
1. If no platforms specified, uses global default platforms
2. Sends to all enabled platforms
3. Returns success/failure per platform
4. Content uses agent-provided title/message directly

### Notification Content Templates

**For system events** (auto-generated):
```
Title: "Pi — {event_label}"
Message: "{project_name}: {description}"

Examples:
- Title: "Pi — Ralph Complete"
  Message: "my-project: Loop 'refactor-auth' completed (5/5 iterations)"
- Title: "Pi — Workflow Done"
  Message: "my-project: /unipi:brainstorm finished in 2m 30s"
- Title: "Pi — MCP Error"
  Message: "my-project: Server 'github' failed to start"
- Title: "Pi — Ask User"
  Message: "my-project: Agent is waiting for your input"
```

**For agent tool** (user-provided):
```
Title: params.title || "Pi Notification"
Message: params.message
```

### Commands

**`/unipi:notify-settings`**
- Opens TUI overlay for configuring:
  - Enable/disable each platform
  - Configure platform credentials (Gotify URL/token, Telegram token/chatId)
  - Per-event-type toggles
  - Test notification button

**`/unipi:notify-set-tg`**
- Interactive Telegram setup with animated overlay
- Auto-detects chat ID from first bot message

**`/unipi:notify-test`**
- Sends test notification to all enabled platforms
- Shows success/failure per platform

### Info-Screen Integration

Registers group "notify" with stats:
- `enabledPlatforms`: Count of enabled platforms
- `subscribedEvents`: Count of enabled event subscriptions
- `lastNotification`: Timestamp of last notification sent
- `totalSent`: Total notifications sent this session

### Error Handling

- Each platform has independent error handling
- Failed deliveries logged to console but don't block other platforms
- No retry logic (fire-and-forget for simplicity)
- Settings validation on startup:
  - Gotify: Optional health check ping
  - Telegram: Optional `getMe` bot info check
- Invalid config gracefully degrades (skip platform, log warning)

### Platform Implementation Details

**native.ts:**
```typescript
import notifier from "node-notifier";

export async function sendNativeNotification(
  title: string,
  message: string,
  options?: { windowsAppId?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    notifier.notify(
      {
        title,
        message,
        appID: options?.windowsAppId, // Windows only
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
```

**gotify.ts:**
```typescript
import { gotify } from "gotify";

export async function sendGotifyNotification(
  serverUrl: string,
  appToken: string,
  title: string,
  message: string,
  priority: number = 5
): Promise<void> {
  await gotify({
    server: serverUrl,
    app: appToken,
    title,
    message,
    priority,
  });
}
```

**telegram.ts:**
```typescript
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  title: string,
  message: string
): Promise<void> {
  const text = `*${title}*\n${message}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }
}

export async function pollForChatId(
  botToken: string,
  signal: AbortSignal
): Promise<string | null> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (data.ok && data.result.length > 0) {
    // Return chat_id from most recent message
    const lastMsg = data.result[data.result.length - 1];
    return String(lastMsg.message?.chat?.id || lastMsg.callback_query?.message?.chat?.id);
  }
  return null;
}
```

### Constants (add to @pi-unipi/core)

```typescript
// In packages/core/constants.ts
export const MODULES = {
  // ... existing
  NOTIFY: "@pi-unipi/notify",
  // ...
} as const;

export const NOTIFY_COMMANDS = {
  SETTINGS: "notify-settings",
  SET_TG: "notify-set-tg",
  TEST: "notify-test",
} as const;

export const NOTIFY_TOOLS = {
  NOTIFY_USER: "notify_user",
} as const;

export const NOTIFY_DIRS = {
  CONFIG: "~/.unipi/config/notify",
} as const;
```

### Event Types (add to @pi-unipi/core/events.ts)

```typescript
/** Event names emitted by notify module */
export const NOTIFY_EVENTS = {
  NOTIFICATION_SENT: "unipi:notify:sent",
} as const;

/** Payload for NOTIFICATION_SENT */
export interface UnipiNotificationSentEvent {
  eventType: string;
  platforms: string[];
  success: boolean;
  timestamp: string;
}
```

### Skill: notify

```markdown
---
name: notify
description: >
  Cross-platform notification system for Pi. Use notify_user when you need
  to urgently alert the user about critical findings, errors, or completion
  of long-running tasks.
allowed-tools:
  - notify_user
---

# Notify User

Use the `notify_user` tool to send notifications to the user's configured
platforms (native OS, Gotify, Telegram).

## When to use notify_user

- Critical errors that need immediate attention
- Completion of long-running tasks (after user has been waiting)
- Security concerns or suspicious activity detected
- Results that the user explicitly asked to be notified about

## When NOT to use notify_user

- Routine status updates (use normal message instead)
- Non-urgent information (let user read at their pace)
- Every turn completion (spammy)

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | string | required | Notification body |
| `title` | string? | "Pi Notification" | Notification title |
| `priority` | string? | "normal" | "low", "normal", or "high" |
| `platforms` | string[]? | all enabled | Override which platforms to use |

## Examples

Alert on critical error:
```
notify_user({
  title: "Build Failed",
  message: "TypeScript compilation failed with 12 errors. Check src/auth.ts.",
  priority: "high"
})
```

Task completion:
```
notify_user({
  title: "Deployment Complete",
  message: "Successfully deployed to production. All health checks passed.",
  priority: "normal"
})
```
```

## Implementation Checklist

### @pi-unipi/core updates
- [x] Add `NOTIFY` to `MODULES` constant — covered in Task 1
- [x] Add `NOTIFY_COMMANDS` constant (SETTINGS, SET_TG, TEST) — covered in Task 1
- [x] Add `NOTIFY_TOOLS` constant (NOTIFY_USER) — covered in Task 1
- [x] Add `NOTIFY_DIRS` constant — covered in Task 1
- [x] Add `NOTIFY_EVENTS` and `UnipiNotificationSentEvent` to events.ts — covered in Task 1
- [x] Add `UnipiNotificationSentEvent` to `UnipiEventPayload` union — covered in Task 1

### @pi-unipi/notify package
- [x] Create `packages/notify/package.json` with proper metadata — covered in Task 2
- [x] Create `packages/notify/index.ts` — covered in Task 9 — extension entry with event hooks
- [x] Create `packages/notify/types.ts` — covered in Task 2 — TypeScript interfaces
- [x] Create `packages/notify/settings.ts` — covered in Task 3 — config load/save/validation
- [x] Create `packages/notify/events.ts` — covered in Task 5 — event subscription registry
- [x] Create `packages/notify/tools.ts` — covered in Task 6 — `notify_user` tool registration
- [x] Create `packages/notify/commands.ts` — covered in Task 7 — command handlers
- [x] Create `packages/notify/platforms/native.ts` — covered in Task 4 — node-notifier wrapper
- [x] Create `packages/notify/platforms/gotify.ts` — covered in Task 4 — Gotify client wrapper
- [x] Create `packages/notify/platforms/telegram.ts` — covered in Task 4 — Telegram Bot API wrapper
- [x] Create `packages/notify/tui/settings-overlay.ts` — covered in Task 8 — settings TUI
- [x] Create `packages/notify/tui/telegram-setup.ts` — covered in Task 8 — animated setup overlay
- [x] Create `packages/notify/skills/notify/SKILL.md` — covered in Task 11 — bundled skill
- [x] Create `packages/notify/README.md` — covered in Task 12

### @pi-unipi/unipi meta-package
- [x] Update `packages/unipi/index.ts` — covered in Task 10 — import and register notify
- [x] Update root `package.json` — covered in Task 10 — add `@pi-unipi/notify` dependency

### Testing
- [x] Test native notification on each OS — covered in Task 13 (Windows, macOS, Linux)
- [x] Test Gotify integration with custom domain — covered in Task 13
- [x] Test Telegram setup flow end-to-end — covered in Task 13
- [x] Test `notify_user` agent tool — covered in Task 13
- [x] Test per-event toggles — covered in Task 13
- [x] Test info-screen integration — covered in Task 13
- [x] Run `npm run typecheck` — covered in Tasks 1, 10, 13

## Open Questions

1. **Windows appID registration:** Should we provide a helper to register a custom appID in Windows Start Menu (required for clean notification branding), or is the default SnoreToast acceptable?
2. **Gotify client choice:** The simple `gotify` package vs full `gotify-client` — we chose `gotify` for simplicity since we only need send. Revisit if we need message management.
3. **Event payload enrichment:** Should we include more context in notifications (e.g., duration, success/failure, error details)? Current design keeps it simple.
4. **Notification deduplication:** Should we suppress identical back-to-back notifications? Not implemented in v1.

## Out of Scope

- **Pushover/ntfy/Discord/other platforms:** v1 focuses on native + Gotify + Telegram only
- **Notification history/persistence:** No log of sent notifications beyond console output
- **Rich notifications (images, buttons, actions):** Plain text only for v1
- **Scheduled/recurring notifications:** No cron-like functionality
- **Per-project notification settings:** Global settings only for v1
- **Notification sound customization:** Uses platform defaults
- **Batching multiple events:** Each event triggers independently

## Decisions Made

1. **node-notifier for native notifications:** Proven library, 5.9M weekly downloads, works without admin on all platforms. Windows uses SnoreToast which shows "SnoreToast" as app name unless appID is configured — acceptable for v1.
2. **Simple `gotify` package over `gotify-client`:** We only need send functionality. The simple `gotify` package is sufficient and has a cleaner API for our use case.
3. **Fire-and-forget delivery:** No retry logic. If a platform fails, we log and continue. This keeps complexity low and aligns with "best effort" notification semantics.
4. **Dynamic event discovery via MODULE_READY:** Other modules can expose their event types in their MODULE_READY payload, and notify auto-subscribes. No direct imports needed.
5. **Telegram setup via polling getUpdates:** The most user-friendly approach — user just sends a message to their bot, we detect it. No need to explain how to find chat IDs.
6. **Settings stored in `~/.unipi/config/notify/`:** Follows established Unipi pattern (web-api, memory both use this location).

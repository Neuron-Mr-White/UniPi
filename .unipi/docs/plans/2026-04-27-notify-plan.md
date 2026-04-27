---
title: "@pi-unipi/notify — Implementation Plan"
type: plan
date: 2026-04-27
workbranch: feat/notify
specs:
  - .unipi/docs/specs/2026-04-27-notify-design.md
---

# @pi-unipi/notify — Implementation Plan

## Overview

Implement a cross-platform notification extension for Pi that bridges agent lifecycle events to external platforms (native OS, Gotify, Telegram). Users running long Ralph loops or subagent tasks can step away and receive desktop/mobile notifications when things finish, error, or need attention.

## Tasks

- completed: Task 1 — Core constants and event types
  - Description: Add NOTIFY constants to `@pi-unipi/core` and new event types to `events.ts`
  - Dependencies: None
  - Acceptance Criteria:
    - `MODULES` constant includes `NOTIFY: "@pi-unipi/notify"`
    - `NOTIFY_COMMANDS` constant exported (SETTINGS, SET_TG, TEST)
    - `NOTIFY_TOOLS` constant exported (NOTIFY_USER)
    - `NOTIFY_DIRS` constant exported (CONFIG)
    - `NOTIFY_EVENTS` constant and `UnipiNotificationSentEvent` interface added to `events.ts`
    - `UnipiNotificationSentEvent` added to `UnipiEventPayload` union
    - `npm run typecheck` passes
  - Steps:
    1. Open `packages/core/constants.ts`
    2. Add `NOTIFY: "@pi-unipi/notify"` to `MODULES` object
    3. Add `NOTIFY_COMMANDS` constant block with SETTINGS, SET_TG, TEST
    4. Add `NOTIFY_TOOLS` constant block with NOTIFY_USER
    5. Add `NOTIFY_DIRS` constant block with CONFIG pointing to `~/.unipi/config/notify`
    6. Open `packages/core/events.ts`
    7. Add `NOTIFICATION_SENT: "unipi:notify:sent"` to `UNIPI_EVENTS`
    8. Add `UnipiNotificationSentEvent` interface with eventType, platforms, success, timestamp fields
    9. Add `UnipiNotificationSentEvent` to the `UnipiEventPayload` union type
    10. Run `npm run typecheck` from repo root

- completed: Task 2 — Package scaffolding
  - Description: Create `packages/notify/` with `package.json` and `types.ts`
  - Dependencies: Task 1
  - Acceptance Criteria:
    - `packages/notify/package.json` exists with correct name, dependencies, pi config
    - `packages/notify/types.ts` exists with all TypeScript interfaces from spec
    - Package structure matches spec architecture diagram
  - Steps:
    1. Create `packages/notify/package.json` modeled on `packages/ask-user/package.json`
       - name: `@pi-unipi/notify`
       - dependencies: `@pi-unipi/core`, `node-notifier`, `gotify`
       - peerDependencies: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`
       - pi.extensions: `["index.ts"]`, pi.skills: `["skills"]`
       - files: index.ts, tools.ts, commands.ts, settings.ts, events.ts, types.ts, platforms/*, tui/*, skills/**/*, README.md
    2. Create `packages/notify/types.ts` with interfaces:
       - `EventNotifyConfig` — enabled boolean, platforms array
       - `NotifyConfig` — defaultPlatforms, events record, native/gotify/telegram sub-configs
       - `NativeConfig` — enabled, windowsAppId
       - `GotifyConfig` — enabled, serverUrl, appToken, priority
       - `TelegramConfig` — enabled, botToken, chatId
       - `NotifyUserParams` — message, title?, priority?, platforms?
       - `NotifyResult` — platform, success, error?

- completed: Task 3 — Settings module
  - Description: Create `packages/notify/settings.ts` for config load/save/validation
  - Dependencies: Task 2
  - Acceptance Criteria:
    - Config loads from `~/.unipi/config/notify/config.json`
    - Config saves with proper directory creation
    - Default config provided when no file exists
    - Validation catches invalid configs
  - Steps:
    1. Create `packages/notify/settings.ts`
    2. Implement `DEFAULT_CONFIG` constant with sensible defaults (native enabled, gotify/telegram disabled, workflow_end and ralph_loop_end on by default)
    3. Implement `loadConfig()` — read JSON from CONFIG path, return defaults if missing
    4. Implement `saveConfig(config)` — ensure directory exists, write JSON
    5. Implement `updateConfig(partial)` — merge partial update with current config
    6. Implement `validateConfig(config)` — check required fields for enabled platforms
    7. Export config path constant from settings

- completed: Task 4 — Platform implementations
  - Description: Create native, gotify, and telegram platform wrappers
  - Dependencies: Task 2
  - Acceptance Criteria:
    - `packages/notify/platforms/native.ts` wraps node-notifier correctly
    - `packages/notify/platforms/gotify.ts` wraps gotify package correctly
    - `packages/notify/platforms/telegram.ts` implements Bot API send and chat ID polling
    - All functions are async and return Promise<void> or Promise<string>
  - Steps:
    1. Create `packages/notify/platforms/` directory
    2. Create `packages/notify/platforms/native.ts`:
       - `sendNativeNotification(title, message, options?)` — wraps node-notifier.notify
       - Handles windowsAppId option for Windows
       - Returns Promise that resolves/rejects based on callback
    3. Create `packages/notify/platforms/gotify.ts`:
       - `sendGotifyNotification(serverUrl, appToken, title, message, priority)` — uses gotify package
       - Proper error handling for network/auth failures
    4. Create `packages/notify/platforms/telegram.ts`:
       - `sendTelegramNotification(botToken, chatId, title, message)` — POST to Bot API with Markdown
       - `pollForChatId(botToken, signal)` — polls getUpdates, returns chatId from first message
       - AbortSignal support for cancellation
    5. Ensure all platform functions have consistent error types

- completed: Task 5 — Event subscription registry
  - Description: Create `packages/notify/events.ts` to manage event listeners and routing
  - Dependencies: Task 3, Task 4
  - Acceptance Criteria:
    - Built-in events mapped to pi hooks correctly
    - Dynamic event discovery via MODULE_READY works
    - Event filtering respects per-event config toggles
    - Routing sends to correct platforms based on config
  - Steps:
    1. Create `packages/notify/events.ts`
    2. Define `BUILTIN_EVENTS` map — event key → pi hook name + label for notifications
    3. Implement `EventRegistry` class or module:
       - `register(pi, config)` — attach listeners for all enabled events
       - `unregister(pi)` — detach all listeners
       - `handleModuleReady(payload)` — discover and register dynamic events
    4. For each event listener:
       - Check if event is enabled in config
       - Build notification title/message from event payload using templates
       - Route to configured platforms
       - Emit `NOTIFICATION_SENT` event after dispatch
    5. Implement notification content templates per event type:
       - agent_end → "Pi — Agent Complete"
       - workflow_end → "Pi — Workflow Done"
       - ralph_loop_end → "Pi — Ralph Complete"
       - mcp_server_error → "Pi — MCP Error"
       - session_shutdown → "Pi — Session End"
       - Dynamic events → "Pi — {module_name}"

- completed: Task 6 — Agent tool (notify_user)
  - Description: Create `packages/notify/tools.ts` with `notify_user` tool registration
  - Dependencies: Task 3, Task 4
  - Acceptance Criteria:
    - Tool registered with TypeBox schema matching spec
    - Uses global default platforms when none specified
    - Returns per-platform success/failure results
    - Tool name matches `NOTIFY_TOOLS.NOTIFY_USER`
  - Steps:
    1. Create `packages/notify/tools.ts`
    2. Define TypeBox schema for notify_user params (message required, title/priority/platforms optional)
    3. Implement tool handler:
       - Resolve platforms from params or global config
       - Send to each platform in parallel
       - Collect results with per-platform success/error
       - Return summary result object
    4. Implement `registerNotifyTools(pi)` function that calls `pi.registerTool()`
    5. Import and use `NOTIFY_TOOLS.NOTIFY_USER` as tool name

- completed: Task 7 — Commands
  - Description: Create `packages/notify/commands.ts` for slash commands
  - Dependencies: Task 3
  - Acceptance Criteria:
    - `/unipi:notify-settings` opens settings TUI
    - `/unipi:notify-set-tg` starts Telegram setup flow
    - `/unipi:notify-test` sends test notification
    - Commands registered with `NOTIFY_COMMANDS` constants
  - Steps:
    1. Create `packages/notify/commands.ts`
    2. Implement `registerNotifyCommands(pi)` function
    3. Register `/unipi:notify-settings` command — opens settings overlay (Task 8)
    4. Register `/unipi:notify-set-tg` command — opens telegram setup (Task 8)
    5. Register `/unipi:notify-test` command:
       - Load config
       - Send test message to each enabled platform
       - Show success/failure results via `pi.ui.notify()`

- completed: Task 8 — TUI overlays
  - Description: Create settings and Telegram setup TUI overlays
  - Dependencies: Task 3, Task 7
  - Acceptance Criteria:
    - Settings overlay shows platform toggles and credential inputs
    - Telegram setup overlay has animated spinner with polling
    - Both use `pi.ui` components (select, input, notify)
    - Telegram setup auto-detects chat ID
  - Steps:
    1. Create `packages/notify/tui/` directory
    2. Create `packages/notify/tui/settings-overlay.ts`:
       - Platform enable/disable toggles
       - Native: windowsAppId input
       - Gotify: serverUrl, appToken, priority inputs
       - Telegram: botToken, chatId inputs (chatId read-only if auto-detected)
       - Per-event toggle list
       - Test notification button
       - Save/cancel actions
    3. Create `packages/notify/tui/telegram-setup.ts`:
       - Instructions screen explaining BotFather flow
       - Bot token input via `pi.ui.input`
       - Animated spinner overlay: "Waiting for first message..."
       - Background polling via `pollForChatId()` with AbortSignal
       - Success: extract chat_id, show confirmation, save to config
       - Timeout after 5 minutes with error message

- completed: Task 9 — Extension entry point
  - Description: Create `packages/notify/index.ts` that ties everything together
  - Dependencies: Task 5, Task 6, Task 7
  - Acceptance Criteria:
    - Skills directory registered via `resources_discover`
    - Event listeners registered on `session_start`
    - Module announced via `MODULE_READY` event
    - Cleanup on `session_shutdown`
    - Follows same pattern as `packages/ask-user/index.ts`
  - Steps:
    1. Create `packages/notify/index.ts`
    2. Export default function taking `ExtensionAPI` parameter
    3. On `resources_discover`: return skillPaths with `./skills`
    4. Call `registerNotifyTools(pi)` and `registerNotifyCommands(pi)` at module level
    5. On `session_start`:
       - Load config via `loadConfig()`
       - Register event listeners via event registry
       - Handle dynamic module discovery via `unipi:module:ready` listener
       - Emit `MODULE_READY` with notify module info
    6. On `session_shutdown`: unregister all event listeners

- completed: Task 10 — Meta-package and root updates
  - Description: Register notify in the unipi meta-package and root config
  - Dependencies: Task 9
  - Acceptance Criteria:
    - `packages/unipi/index.ts` imports and calls notify
    - Root `package.json` includes `@pi-unipi/notify` dependency
    - `npm run typecheck` passes from repo root
  - Steps:
    1. Open `packages/unipi/index.ts`
    2. Add `import notify from "@pi-unipi/notify";`
    3. Add `notify(pi);` in the default export function
    4. Open root `package.json`
    5. Add `"@pi-unipi/notify": "*"` to dependencies
    6. Run `npm run typecheck` from repo root

- completed: Task 11 — Bundled skill
  - Description: Create the bundled notify skill for agent guidance
  - Dependencies: Task 6
  - Acceptance Criteria:
    - `packages/notify/skills/notify/SKILL.md` exists with spec content
    - Skill name, description, and allowed-tools match spec
    - Usage examples included
  - Steps:
    1. Create `packages/notify/skills/notify/` directory
    2. Create `packages/notify/skills/notify/SKILL.md` with content from spec
    3. Ensure YAML frontmatter has name, description, allowed-tools

- completed: Task 12 — README
  - Description: Create package README with usage instructions
  - Dependencies: Task 9
  - Acceptance Criteria:
    - README explains what notify does
    - Installation instructions included
    - Configuration examples for each platform
    - Command reference documented
    - Agent tool usage examples
  - Steps:
    1. Create `packages/notify/README.md`
    2. Write overview section
    3. Write installation section
    4. Write platform configuration sections (native, gotify, telegram)
    5. Write commands reference
    6. Write agent tool section
    7. Write info-screen integration section

- completed: Task 13 — Integration testing
  - Description: Verify the extension works end-to-end
  - Dependencies: Task 10
  - Acceptance Criteria:
    - Extension loads without errors in Pi
    - `/unipi:notify-settings` opens correctly
    - `/unipi:notify-test` sends native notification
    - `notify_user` tool available to agent
    - Info-screen shows notify group
    - `npm run typecheck` passes
  - Steps:
    1. Build/install dependencies if needed
    2. Run `npm run typecheck` to verify types
    3. Load extension in Pi: verify no startup errors
    4. Test `/unipi:notify-settings` — settings overlay opens
    5. Test `/unipi:notify-test` — native notification appears
    6. Test `notify_user` tool — verify it's available and callable
    7. Check info-screen for notify group stats
    8. (Optional) Test Gotify if server available
    9. (Optional) Test Telegram setup flow

## Sequencing

```
Task 1 (core constants)
    ↓
Task 2 (package scaffolding)
    ↓
Task 3 (settings)  ←→  Task 4 (platforms)
    ↓                     ↓
Task 5 (events)    Task 6 (tools)
    ↓                ↓
Task 7 (commands)
    ↓
Task 8 (TUI)
    ↓
Task 9 (entry point)
    ↓
Task 10 (meta-package)
    ↓
Task 13 (testing)
```

Tasks 3 and 4 can run in parallel after Task 2.
Tasks 5 and 6 can run in parallel after Tasks 3+4.
Task 7 needs Task 3; Task 8 needs Task 7.
Tasks 11 and 12 can run any time after their dependencies.

## Risks

- **node-notifier Windows behavior:** SnoreToast shows "SnoreToast" as app name by default. Acceptable for v1 per spec decision, but could be jarring. Mitigated by optional windowsAppId config.
- **Gotify package stability:** The `gotify` npm package is 5 years old. Low risk since it's simple send-only, but monitor for issues.
- **Telegram polling UX:** 5-minute timeout might be too short or too long depending on user. Could make configurable in v2.
- **No retry logic:** Fire-and-forget means transient network failures lose notifications. Acceptable for v1 — notifications are best-effort.
- **Dynamic event discovery:** MODULE_READY payload from other modules must include event info. If a module doesn't provide it, those events won't be auto-discovered. Fallback: built-in events cover the most important cases.

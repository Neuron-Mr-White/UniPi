---
title: "ntfy Notification Platform"
type: brainstorm
date: 2026-04-29
---

# ntfy Notification Platform

## Problem Statement

The notify package supports Native OS, Gotify, and Telegram but lacks ntfy — a popular self-hosted and public push notification service. Users who prefer ntfy (or already run an ntfy server) cannot route Pi notifications to it.

## Context

- Existing pattern: each platform has a `platforms/*.ts` send function, `tui/*-setup.ts` interactive overlay, and wiring through types/settings/events/commands.
- Gotify is the closest analog (self-hosted HTTP push), so ntfy follows a similar structure.
- ntfy API is simpler: POST to `{serverUrl}/{topic}` with plain text body, optional `Title`, `Priority`, `Tags`, and `Authorization` headers.
- ntfy priority range is 1-5 (vs Gotify's 1-10). Default: 3 (normal).

## Chosen Approach

Add ntfy as a fourth platform, mirroring the Gotify pattern:

1. **Platform file** `platforms/ntfy.ts` — `sendNtfyNotification(serverUrl, topic, title, message, priority, token?)`
2. **TUI setup overlay** `tui/ntfy-setup.ts` — interactive wizard: server URL (default ntfy.sh) → topic → optional token → priority → test connection
3. **Type additions** — `NtfyConfig` interface, add `"ntfy"` to `NotifyPlatform` union
4. **Settings wiring** — add `ntfy` section to DEFAULT_CONFIG, validation rules, merge logic
5. **Event dispatch** — add ntfy case to `sendToPlatform` and `dispatchNotification` platform filter
6. **Command registration** — `/unipi:notify-set-ntfy` command
7. **Core constants** — `NOTIFY_COMMANDS.SET_NTFY`
8. **Index announcement** — add to MODULE_READY commands list
9. **Settings overlay** — add ntfy to platforms list in settings TUI
10. **Update SKILL.md** — document ntfy in configure-notify skill

## Why This Approach

- Mirrors established pattern — minimal cognitive overhead
- Gotify is the closest analog, ntfy follows same shape
- Interactive TUI setup with connection test (user requested "similar settings tui as tg and gotify")

## Design

### ntfy API Details

```
POST {serverUrl}/{topic}
Headers:
  Title: {title}
  Priority: {1-5}
  Authorization: Bearer {token}  (optional, for private topics)
Body: plain text message
```

Server URL defaults to `https://ntfy.sh`. Topic is required. Token is optional (for access-controlled topics).

### Config Shape

```json
{
  "ntfy": {
    "enabled": false,
    "serverUrl": "https://ntfy.sh",
    "topic": null,
    "token": null,
    "priority": 3
  }
}
```

### TUI Flow

1. **Instructions** — explain ntfy, link to docs, pre-fill from existing config
2. **Server URL** — default `https://ntfy.sh`, user can change for self-hosted
3. **Topic** — required, the topic to publish to
4. **Token** — optional, for private topics (can skip with Enter)
5. **Priority** — 1-5 (default 3)
6. **Test** — send test notification, show success/failure
7. **Save** — write config

### Validation

- `serverUrl` required when enabled
- `topic` required when enabled
- `priority` must be 1-5
- `token` optional

## Implementation Checklist

- [x] Create `platforms/ntfy.ts` with `sendNtfyNotification()`
- [x] Create `tui/ntfy-setup.ts` with `NtfySetupOverlay`
- [x] Add `NtfyConfig` to `types.ts`, update `NotifyPlatform` union
- [x] Update `settings.ts` — DEFAULT_CONFIG, validation, merge
- [x] Update `events.ts` — sendToPlatform, dispatchNotification filter
- [x] Update `commands.ts` — register `/unipi:notify-set-ntfy`
- [x] Update `packages/core/constants.ts` — NOTIFY_COMMANDS.SET_NTFY
- [x] Update `index.ts` — add to MODULE_READY announcement
- [x] Update `tui/settings-overlay.ts` — add ntfy to platforms list
- [x] Update `skills/configure-notify/SKILL.md` — document ntfy
- [x] Build and verify TypeScript compilation

## Open Questions

- None — pattern is well-established.

## Out of Scope

- ntfy attachments/file uploads
- ntfy click actions
- ntfy scheduling/delay

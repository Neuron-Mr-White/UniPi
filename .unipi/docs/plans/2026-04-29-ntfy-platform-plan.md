---
title: "ntfy Notification Platform — Implementation Plan"
type: plan
date: 2026-04-29
workbranch: feat/ntfy
specs:
  - .unipi/docs/specs/2026-04-29-ntfy-platform-design.md
---

# ntfy Notification Platform — Implementation Plan

## Overview

Add ntfy as a fourth notification platform alongside native, Gotify, and Telegram. ntfy is a popular self-hosted and public push notification service with a simple HTTP API (POST to `{serverUrl}/{topic}`). Implementation mirrors the established Gotify pattern.

## Tasks

- completed: Task 1 — Add NOTIFY_COMMANDS.SET_NTFY to core constants
- completed: Task 2 — Add NtfyConfig type and update NotifyPlatform union
- completed: Task 3 — Create platforms/ntfy.ts with sendNtfyNotification()
- completed: Task 4 — Update settings.ts — DEFAULT_CONFIG, validation, merge
- completed: Task 5 — Update events.ts — sendToPlatform and dispatchNotification
- completed: Task 6 — Create tui/ntfy-setup.ts with NtfySetupOverlay
- completed: Task 7 — Update commands.ts — register /unipi:notify-set-ntfy
- completed: Task 8 — Update index.ts — add ntfy to MODULE_READY announcement
- completed: Task 9 — Update tui/settings-overlay.ts — add ntfy to platforms list
- completed: Task 10 — Update skills/configure-notify/SKILL.md — document ntfy
- completed: Task 11 — Build and verify TypeScript compilation (zero errors)

---

## Reviewer Remarks

REVIEWER-REMARK: Done
- All 11 tasks complete, verified against actual implementation in worktree `feat/ntfy`
- Task 1: `SET_NTFY` constant added to `packages/core/constants.ts` ✓
- Task 2: `NtfyConfig` interface and `"ntfy"` added to `NotifyPlatform` union in `packages/notify/types.ts` ✓
- Task 3: `sendNtfyNotification()` in `packages/notify/platforms/ntfy.ts` — 38 lines, clean HTTP POST with Bearer auth support ✓
- Task 4: Default config, validation (serverUrl/topic required when enabled, priority 1-5), merge in `packages/notify/settings.ts` ✓
- Task 5: `sendToPlatform` case + `dispatchNotification` filter + import in `packages/notify/events.ts` ✓
- Task 6: `NtfySetupOverlay` in `packages/notify/tui/ntfy-setup.ts` — 599 lines, multi-phase setup wizard with connection test ✓
- Task 7: `/unipi:notify-set-ntfy` command registered in `packages/notify/commands.ts` + ntfy test block in `/unipi:notify-test` ✓
- Task 8: ntfy added to MODULE_READY commands list in `packages/notify/index.ts` ✓
- Task 9: ntfy added to settings overlay platform list (maxItems 4, toggle, render) in `packages/notify/tui/settings-overlay.ts` ✓
- Task 10: ntfy documented in `packages/notify/skills/configure-notify/SKILL.md` — config schema, platform docs, commands table, setup suggestions, validation rules ✓
- Task 11: TypeScript compilation passes (tsc --noEmit --skipLibCheck — zero errors) ✓

Codebase Checks:
- ⚠ Lint: No lint script configured (not a task issue)
- ✓ Type check passed (zero errors)
- ✓ Tests passed: 69 pass, 0 fail (web-api/workflow missing test scripts — pre-existing, unrelated)
- ⚠ Build: No build script (monorepo publishes directly)

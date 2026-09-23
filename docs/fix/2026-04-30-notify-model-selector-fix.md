---
title: "Notify Model Selector Crash — Quick Fix"
type: quick-fix
date: 2026-04-30
---

# Notify Model Selector Crash — Quick Fix

## Bug
Pressing "M" to change the recap model in `/unipi:notify-settings` crashes with `TypeError: tui.custom is not a function` at `commands.ts:44`.

## Root Cause
In `packages/notify/commands.ts`, the `onOpenModelSelector` callback called `tui.custom(...)` to open a nested overlay. However, `tui` is the internal render object passed to the `ctx.ui.custom()` callback — it only exposes `requestRender()`, not `custom()`. The `custom()` method belongs to `ctx.ui` (the ExtensionAPI).

## Fix
Changed `tui.custom(...)` to `ctx.ui.custom(...)` in the `onOpenModelSelector` callback. `ctx` is available via closure from the outer handler.

### Files Modified
- `packages/notify/commands.ts` — Changed `tui.custom` to `ctx.ui.custom` in the nested overlay opener (line 44)

## Verification
- TypeScript compiles cleanly with no errors
- The fix correctly uses `ctx.ui.custom()` which is the same pattern used by all other overlay openers in the file

## Notes
This is a classic scope confusion: the inner `tui` parameter (render callback object) was confused with the outer `ctx.ui` (ExtensionAPI). All other overlay openers in the file correctly use `ctx.ui.custom()`.

---
title: "pi.off is not a function in notify events — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# pi.off is not a function in notify events — Quick Fix

## Bug
During session teardown (e.g., `/clear`), `unregisterEventListeners()` in `packages/notify/events.ts` threw `pi.off is not a function` at line 53. The cleanup closures captured `pi` and called `pi.off()` to unsubscribe event listeners, but the `ExtensionAPI` interface only exposes `on()` — there is no `off()` method.

## Root Cause
The code assumed `ExtensionAPI` supports both `on()` and `off()` for event subscription management (like Node's `EventEmitter`). In reality, `ExtensionAPI` only has typed `on()` overloads — no `off()`, `removeListener()`, or similar unsubscription API. The `(pi as any).off(...)` cast bypassed TypeScript's type checking but failed at runtime.

## Fix
Removed the broken cleanup logic entirely. Since `unregisterEventListeners()` is only called during `session_shutdown` (process teardown), listener unsubscription is unnecessary — the session is ending and all state is discarded. Removed the unused `cleanupFns` array and the unused `loadConfig` import.

### Files Modified
- `packages/notify/events.ts` — Removed `cleanupFns` array, removed `off()` calls from cleanup closures, simplified `unregisterEventListeners()` to a no-op, removed unused `loadConfig` import.

## Verification
- `npx tsc --noEmit --skipLibCheck` passes with no errors.

## Notes
- `ExtensionAPI` has an `events: EventBus` property that may support `off()` for custom events, but built-in lifecycle hooks (`on(event, handler)`) don't support unsubscription.

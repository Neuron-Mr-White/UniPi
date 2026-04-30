---
title: "Notifications Block Foreground Work — Quick Fix"
type: quick-fix
date: 2026-04-30
---

# Notifications Block Foreground Work — Quick Fix

## Bug
When pi sends a notification (via `notify_user` tool or event-triggered like `agent_end`, `workflow_end`, etc.), the dispatch is **awaited** (foreground blocking). This causes the agent or event emitter to stall while network requests (HTTP to Gotify/Telegram/ntfy) or native notifications complete. Most critically:

- The `agent_end` recap path blocks while making an LLM API call to summarize
- The `notify_user` tool blocks the agent's tool execution
- Event handlers block the pi event emitter pipeline

## Root Cause
In `events.ts`, all event handlers were `async` functions that `await dispatchNotification(...)`. In `tools.ts`, `execute` was `async` and awaited the dispatch result. The `dispatchNotification` function itself awaits all platform sends (native, HTTP, etc.) before resolving.

## Fix
Made all notification dispatches **fire-and-forget** (non-blocking):

### Files Modified
- `packages/notify/events.ts` — Event handlers no longer `await` notification dispatch
  - Built-in events (workflow_end, ralph_loop_end, etc.): handler is now synchronous, calls `dispatchNotification().catch(...)` in background
  - `agent_end` handler: recap summarization + dispatch runs as a `.then()` chain; non-recap path dispatches in background immediately
- `packages/notify/tools.ts` — `notify_user` tool's `execute` fires dispatch in background
  - Returns immediately with platform list; no longer awaits `dispatchNotification`
  - Removed unused `NotifyDispatchResult` import

### Key design decisions
- All background dispatches have `.catch()` handlers that log to stderr, so failures are visible in logs
- The `agent_end` recap path preserves the full async chain (getApiKey → summarize → dispatch) but runs it outside the event handler's control flow
- `dispatchNotification` itself remains async — it's the *callers* that changed from `await` to fire-and-forget

## Verification
- TypeScript compilation: notify package passes (`npx tsc --noEmit`), no notify-related errors
- Two pre-existing errors in `utility/src` (unrelated to this change)

## Notes
- Notification failures are logged to stderr but no longer bubble up to the caller — acceptable trade-off for non-blocking behavior
- If a notification fails, the user won't know via the tool's return — but the console error provides traceability

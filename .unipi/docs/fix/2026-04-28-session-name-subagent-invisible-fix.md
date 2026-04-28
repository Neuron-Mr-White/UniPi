---
title: "Session Name Subagent Invisible to Main Agent — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Session Name Subagent Invisible to Main Agent — Quick Fix

## Bug
When the session name generation subagent completed, it sent a `<task-notification>` message to the main agent's conversation. The main agent could see:

```xml
<task-notification>
<task-id>...</task-id>
<status>Done</status>
<summary>Agent "Generate session name" completed</summary>
<result>Unipi Extension Suite Development</result>
...
</task-notification>
```

This leaked internal subagent details to the main agent, which should have zero knowledge of the session name generation process.

## Root Cause
The subagent completion callback in `packages/subagents/src/index.ts` sends a notification message for ALL completed background agents. The `AgentRecord` type has a `resultConsumed` flag that suppresses this notification, but it was never set for session name generation agents.

## Fix
Set `record.resultConsumed = true` for session name generation agents after extracting and applying the name. This suppresses the `<task-notification>` message, keeping the main agent completely unaware of the subagent.

The main agent only sees the session name change via `pi.setSessionName()` (which updates the UI badge), with no knowledge of how it was generated.

### Files Modified
- `packages/subagents/src/index.ts` — added `record.resultConsumed = true` in the "Generate session name" completion handler

## Verification
- `cd packages/subagents && npx tsc --noEmit` — compiles cleanly
- The `resultConsumed` flag is already checked by the existing notification logic:
  ```ts
  if (!record.resultConsumed) {
    pi.sendMessage<NotificationDetails>(...)
  }
  ```

## Notes
- This follows the existing pattern where `get_helper_result` also sets `resultConsumed = true` to suppress duplicate notifications.
- The session name is still set via `pi.setSessionName()` and the badge overlay updates via polling.

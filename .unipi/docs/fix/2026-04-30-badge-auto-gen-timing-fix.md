---
title: "Badge Auto-Generation Fires Too Early — Fix Report"
type: fix
date: 2026-04-30
status: fixed
---

# Badge Auto-Generation Fires Too Early — Fix Report

## Summary
Deferred badge auto-generation from the `input` event to the `agent_end` event so the background agent receives full conversation context (user + assistant) instead of just the user's first message.

## Root Cause
The `BADGE_GENERATE_REQUEST` event was emitted immediately on the first `input` event, before the agent had responded. The background name-gen agent received only the user's first message text, producing generic or prompt-echoing titles.

## Changes Made

### Files Modified
- `packages/utility/src/index.ts` — Deferred badge generation to `agent_end` lifecycle event
- `packages/subagents/src/__tests__/badge-generation.test.ts` — Updated tests for new valid lifecycle events and deferred generation pattern

### Code Changes

**`packages/utility/src/index.ts`:**
1. Added `firstUserText` and `firstInputCtx` module-level variables to capture state across events
2. Changed `input` handler to only capture + store user text and ctx (no longer emits `BADGE_GENERATE_REQUEST`)
3. Added `agent_end` handler that:
   - Checks if `firstInputCtx` is set (first response pending)
   - Consumes the flag (only triggers once)
   - Checks `pi.getSessionName()` for manual overrides
   - Shows badge overlay
   - Builds conversation summary from `event.messages` (user text + assistant response)
   - Emits `BADGE_GENERATE_REQUEST` with full context
4. Added cleanup of new state variables in `session_shutdown` handler

**`packages/subagents/src/__tests__/badge-generation.test.ts`:**
1. Added `"agent_end"` and `"before_agent_start"` to `validLifecycleEvents` (they are legitimate lifecycle events)
2. Updated "event flow" test to verify BADGE_GENERATE_REQUEST is emitted in `agent_end` handler, not `input` handler

## Fix Strategy

1. `input` event → store user text + ctx, set flag
2. `agent_end` event → build full conversation summary (User: ... + Assistant: ...) → emit `BADGE_GENERATE_REQUEST`
3. Background agent now gets real conversation context → generates meaningful title

## Verification

### Test Results
- ✓ All 19 badge generation tests pass
- ✓ All 69 project tests pass
- ✓ TypeScript compilation clean (no errors)
- ✓ Manual `badge-gen` command path unchanged (uses `nameBadgeState.generate()` directly)

### Regression Check
- ✓ Manual badge generation (`/unipi:badge-gen`) still works (separate code path via `nameBadgeState.generate()`)
- ✓ Badge overlay still shows on first input (moved to `agent_end` handler)
- ✓ `session_shutdown` cleanup properly resets all state

## Risks & Mitigations
- **Race condition (manual name set before agent_end):** Mitigated by `pi.getSessionName()` check in `agent_end` handler
- **Multiple agent_end fires:** Mitigated by `firstInputCtx` being consumed on first trigger
- **Agent uses tools (multiple turns):** `agent_end` fires after each agent turn; first `agent_end` after first input is the correct trigger

## Notes
- The conversation summary is truncated to 800 chars (up from 500) to accommodate both user and assistant text
- The `source: "input-hook"` identifier is preserved for event tracing compatibility

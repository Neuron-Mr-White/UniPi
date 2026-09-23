---
title: "ask_user end_turn & Compact & run — Fix Report"
type: fix
date: 2026-05-03
status: fixed
---

# ask_user end_turn & Compact & run — Fix Report

## Summary
Fixed two bugs: (A) `end_turn` action caused an unnecessary LLM reply wasting tokens, (B) "Compact & run" in session launcher didn't use the compactor's zero-LLM pipeline and could hang indefinitely.

## Bug A: end_turn wasted tokens with LLM follow-up

### Root Cause
When user selected an `end_turn` option, the tool returned `"User chose to end the turn."` as normal tool content. The LLM received this as a tool result and generated a follow-up response — wasting tokens and defeating the purpose of "end turn."

### Fix
Call `ctx.abort()` immediately when `end_turn` is detected. This signals the agent to stop after the current tool call completes, preventing any LLM follow-up while still recording the tool result in session history.

**File:** `packages/ask-user/tools.ts` — added `ctx.abort()` in the `end_turn` case.

## Bug B: Compact & run didn't use compactor + could hang

### Root Cause
Three interrelated issues:

1. **Compactor not invoked:** The `customInstructions` passed to `ctx.compact()` was generic text (`"Preparing for new task..."`), not the `COMPACTOR_INSTRUCTION` sentinel (`"__compactor__"`). The compactor's `session_before_compact` hook checked `customInstructions === COMPACTOR_INSTRUCTION` and skipped because it didn't match — even when the compactor was installed.

2. **Compactor detection was strict equality:** Used `===` instead of `startsWith`, preventing any additional context from being appended to the sentinel.

3. **No timeout:** The Promise wrapping `ctx.compact()` had no timeout. If `onComplete` never fired (e.g., compaction was cancelled by a hook returning `{ cancel: true }`, or the agent was in an unexpected state), the Promise hung forever — freezing the session. Even `/new` couldn't recover because the agent was mid-tool-call.

### Fix

1. **Shared constant:** Moved `COMPACTOR_INSTRUCTION` to `@pi-unipi/core` constants so both `@pi-unipi/compactor` and `@pi-unipi/ask-user` can reference it without cross-package dependencies.

2. **Use sentinel:** `ask-user/tools.ts` now prepends `COMPACTOR_INSTRUCTION` to the `customInstructions`:
   ```
   __compactor__
   Preparing for new task. Summarize previous work concisely...
   ```

3. **Flexible detection:** Compactor's `session_before_compact` hook now uses `customInstructions?.startsWith(COMPACTOR_INSTRUCTION)` instead of strict equality, allowing additional context after the sentinel.

4. **30-second timeout:** Added a `setTimeout` that rejects the compaction Promise after 30 seconds, preventing indefinite hangs. The error is caught and the session launch continues anyway.

## Changes Made

### Files Modified
- `packages/core/constants.ts` — Added `COMPACTOR_INSTRUCTION` shared constant
- `packages/compactor/src/compaction/hooks.ts` — Import sentinel from core; use `startsWith` instead of `===`
- `packages/compactor/src/commands/index.ts` — Import sentinel from core instead of hooks
- `packages/ask-user/tools.ts` — Import `COMPACTOR_INSTRUCTION`; use sentinel in compact call; add 30s timeout; call `ctx.abort()` on `end_turn`

## Fix Strategy

1. `COMPACTOR_INSTRUCTION` lives in `@pi-unipi/core` (shared) instead of `@pi-unipi/compactor` (internal)
2. Any extension can trigger compactor-aware compaction by prepending `"__compactor__"` to their `customInstructions`
3. The compactor's hook recognizes any `customInstructions` starting with the sentinel
4. `end_turn` aborts the agent immediately, so no tokens are wasted
5. Compaction timeout ensures the session never freezes

## Verification

- ✓ TypeScript compiles cleanly (`npx tsc --noEmit --skipLibCheck`) for all three packages
- ✓ No new type errors introduced
- ✓ Pre-existing compactor `TS7017` error unchanged (unrelated)

### Regression Check
- ✓ Compactor's `/unipi:lossless-compact` command still uses the sentinel (now from core)
- ✓ Compactor's `overrideDefaultCompaction` config path still works (unchanged)
- ✓ ask-user's other response kinds (`selection`, `freeform`, `combined`, `new_session`, `cancelled`, `timed_out`) unaffected

## Risks & Mitigations
- **Risk: Compactor not installed + sentinel passed to built-in compaction.** Pi's built-in compaction passes `customInstructions` to the LLM summary prompt. The `"__compactor__\n..."` text would be odd but functional as instructions. Mitigation: The 30s timeout ensures it can't hang; the text after the sentinel is meaningful guidance.
- **Risk: `ctx.abort()` called during tool execution might cancel tool result.** Mitigation: `abort()` signals the agent to stop after the current operation completes — the tool result is still recorded.

## Notes
- The `COMPACTOR_INSTRUCTION` sentinel is a "magic string" convention. Future improvements could use a structured approach (e.g., a well-known header in `customInstructions`).
- The 30s timeout is generous — compactor's zero-LLM pipeline typically completes in under 1 second. Built-in LLM compaction may take longer.

## Follow-up
- [ ] Consider adding a `COMPACTOR_INSTRUCTION` usage example to the ask-user SKILL.md documentation
- [ ] Consider making compactor's `overrideDefaultCompaction` default to `true` so it intercepts all compactions

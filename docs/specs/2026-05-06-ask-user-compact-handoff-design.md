---
title: "ask_user Compact Handoff Auto-Run"
type: brainstorm
date: 2026-05-06
---

# ask_user Compact Handoff Auto-Run

## Problem Statement

`ask_user` handoff choices that use `action: "new_session"` can currently stall when the user selects **Compact & run**. The launcher starts compaction from inside the `ask_user` tool call and waits for `ctx.compact()` callbacks before returning. In practice, compaction may not complete until the active agent/tool turn becomes idle, while the active tool is waiting for compaction to complete. The user sees `working...` for a long time, then compaction happens or times out, and the suggested workflow command such as `/unipi:plan ...` or `/unipi:work ...` is not continued reliably.

The real need is not a literal new Pi session. The need is a fast, reliable workflow handoff: when a user accepts a suggested next command, Pi should compact without blocking the tool spinner and then automatically submit the command.

## Context

Current `packages/ask-user/tools.ts` behavior:

- `new_session` responses open `renderLauncherUI()` with **Compact & run**, **Run directly**, and **Cancel**.
- **Compact & run** prepends the shared `COMPACTOR_INSTRUCTION` sentinel and calls `ctx.compact()`.
- The code wraps `ctx.compact()` in a Promise and awaits `onComplete` or `onError`, with a 30-second timeout.
- After waiting, the tool returns text like `User chose to proceed (compacted): /unipi:plan ...` and relies on the LLM to continue.

Relevant Pi APIs and prior art:

- `/unipi:lossless-compact` calls `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION, ... })` without blocking the agent on a Promise, which is why it feels instant to the user.
- Tools receive `ExtensionContext`, not `ExtensionCommandContext`, so they cannot call `ctx.newSession()` or command-only helpers.
- The `registerAskUserTools(pi)` closure has access to `pi`, and Pi documents `pi.sendUserMessage("/some-command", { deliverAs: "followUp" })` as a valid way for tools to queue a slash command after the current turn.
- `ctx.abort()` is already used for `end_turn` to stop unnecessary LLM follow-up after a tool result.
- `ctx.ui.setEditorText()` exists and can serve as a last-resort prefill fallback if automatic command delivery fails.

## Chosen Approach

Use a **fire-and-handoff helper** for `ask_user` `new_session` launcher actions.

For **Run directly**, the tool should enqueue the prefill command immediately with `pi.sendUserMessage(prefill, { deliverAs: "followUp" })`, then call `ctx.abort()` so the current LLM turn does not waste tokens explaining the selection.

For **Compact & run**, the tool should start compaction with the same sentinel used by `/unipi:lossless-compact`, but it should not await compaction inside the tool call. Instead, it should return immediately, abort the current LLM follow-up, and enqueue the prefill command from the compaction callback. A short fallback timer should enqueue the command if the compaction callback does not fire quickly.

## Why This Approach

This approach optimizes for the user's main success criteria: no long `working...` spinner and automatic continuation into the selected workflow command.

Alternatives considered:

1. **Queue `/unipi:lossless-compact` and then queue the prefill command.** This matches the command the user knows is instant, but it depends on slash-command queue ordering from inside a tool and introduces a command-chaining dependency that is harder to reason about.
2. **Prefill only after compaction.** This is safest from an automation perspective, but it fails the user's preference for automatic continuation and still requires manual Enter.
3. **Keep awaiting `ctx.compact()` but reduce timeout.** This reduces the stall duration but preserves the self-wait failure mode and still relies on the LLM to continue after the tool returns.

The fire-and-handoff helper keeps the existing UI, uses documented Pi APIs, and addresses the root issue: do not block a tool call waiting for a session operation that may require the tool turn to finish first.

## Design

### Architecture

Keep the existing `ask_user` UI and `renderLauncherUI()` unchanged unless result wording needs minor adjustments. Add a small handoff helper in `packages/ask-user/tools.ts` or a local helper module such as `packages/ask-user/handoff.ts`.

The helper owns:

- prefill validation
- direct command delivery
- compact-then-deliver scheduling
- idempotency so a fallback timer and callback cannot submit the command twice
- status/notification text for success or fallback paths
- editor prefill fallback if automatic delivery throws unexpectedly

### Data Flow

1. The agent calls `ask_user` with an option using `action: "new_session"` and a `prefill`, commonly a slash command like `/unipi:plan specs:...`.
2. The user selects that option.
3. `ask_user` opens the existing launcher overlay.
4. If the user selects **Cancel**, return the existing cancellation result.
5. If the user selects **Run directly**:
   - validate that `prefill.trim()` is non-empty;
   - call `pi.sendUserMessage(prefill, { deliverAs: "followUp" })`;
   - call `ctx.abort()`;
   - return a concise tool result such as `Queued direct handoff: /unipi:plan ...`.
6. If the user selects **Compact & run**:
   - validate that `prefill.trim()` is non-empty;
   - create a `deliverOnce(reason)` closure with a `delivered` flag;
   - call `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION + "\nPreparing for new task...", onComplete: () => deliverOnce("compacted"), onError: () => deliverOnce("compaction-error") })`;
   - start a short fallback timer that calls `deliverOnce("fallback-timeout")` if no callback fires quickly;
   - call `ctx.abort()`;
   - return immediately with `Queued compact handoff: /unipi:plan ...`.

### Error Handling

- Empty or missing `prefill`: cancel gracefully and do not abort unless the user explicitly chose to end the turn.
- `ctx.compact()` throws synchronously: notify/status the failure and still call `deliverOnce("compact-start-failed")`.
- `onError` from compaction: show a non-blocking status/notification and still continue with the selected command.
- Callback and timer race: `deliverOnce` ensures only one `pi.sendUserMessage()` call occurs.
- `pi.sendUserMessage()` throws: set the editor text to the prefill command with `ctx.ui.setEditorText(prefill)` and notify the user to press Enter.
- No UI available: preserve existing non-interactive cancellation behavior.

### Testing

Manual or automated coverage should verify:

- Compact & run returns immediately from the `ask_user` tool rather than waiting for the old 30-second timeout.
- Compact & run auto-submits `/unipi:plan ...` or `/unipi:work ...` after compaction completes.
- If compaction callback never fires, the fallback submits the command exactly once.
- Run directly auto-submits immediately and does not produce an unnecessary LLM follow-up.
- Cancel returns gracefully.
- Normal `ask_user` selection, freeform, combined, timed-out, and `end_turn` behavior is unchanged.
- Rendered tool result text is accurate for queued direct and queued compact handoffs.

## Implementation Checklist

- [x] Add an ask-user handoff helper for validating `prefill`, delivering commands with `pi.sendUserMessage(..., { deliverAs: "followUp" })`, and falling back to `ctx.ui.setEditorText()` on delivery failure — covered by Plan Task 1.
- [x] Change `packages/ask-user/tools.ts` direct launcher path to enqueue the prefill command, abort the current turn, and return immediately — covered by Plan Task 2.
- [x] Change `packages/ask-user/tools.ts` compact launcher path to start `ctx.compact()` without awaiting it, deliver the command from callbacks, add a short idempotent fallback timer, abort the current turn, and return immediately — covered by Plan Task 2.
- [x] Update ask-user render/result wording to distinguish queued direct handoff, queued compact handoff, cancelled handoff, and fallback-to-editor cases — covered by Plan Task 3.
- [x] Add or update tests/manual verification notes for compact handoff, direct handoff, cancellation, callback timeout fallback, and unchanged non-`new_session` responses — covered by Plan Task 4.
- [x] Review related workflow skill handoff examples so suggested next commands use `action: "new_session"` consistently where automatic handoff is desired — covered by Plan Task 5.

## Open Questions

- What exact fallback timer should be used? The design recommends a short 1–2 second timer because `/unipi:lossless-compact` is normally instant and the user values no spinner stall.
- Should automatic delivery be limited to prefill values beginning with `/`, or should non-command prompts also be auto-submitted? The design allows generic non-empty prefill but recommends clear result text because `new_session` is a deliberate user-selected action.
- Should the helper emit a structured event for telemetry/status when a compact handoff is queued, delivered, or falls back to editor prefill?

## Out of Scope

- Creating a literal new Pi session, tab, or worktree as part of this launcher.
- Rewriting compactor internals or changing `/unipi:lossless-compact` behavior.
- Changing the brainstorm, plan, or work workflow semantics beyond using the fixed generic ask-user handoff.
- Implementing code during the brainstorm phase.

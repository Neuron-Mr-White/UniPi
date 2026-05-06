---
title: "ask_user Compact Handoff Auto-Run — Implementation Plan"
type: plan
date: 2026-05-06
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-06-ask-user-compact-handoff-design.md
---

# ask_user Compact Handoff Auto-Run — Implementation Plan

## Overview

Implement a reliable `ask_user` `new_session` handoff that queues the selected prefill command instead of relying on the LLM to continue after the tool result. The plan keeps the existing launcher UI, moves compact/direct launch behavior into a small reusable helper, avoids awaiting `ctx.compact()`, aborts the current LLM follow-up after scheduling, and documents/manual-verifies the changed behavior.

Planning decisions:
- Work directly on the current/main branch (`workbranch: ""`).
- Use a 1500 ms compact fallback timer: short enough to avoid the old spinner stall, long enough for the zero-LLM compactor callback to win in normal cases.
- Accept any non-empty `prefill`, not only slash commands, because `new_session` is an explicit user-selected handoff action. Result text must make queued delivery clear.
- Do not add structured telemetry in this pass; use non-blocking UI notifications/status text for errors and fallback-to-editor paths.

## Tasks

- completed: Task 1 — Add ask-user handoff helper
  - Description: Create a focused helper for validating prefill text, delivering follow-up user messages, compact-then-deliver scheduling, idempotent fallback behavior, and editor-prefill fallback on delivery failure.
  - Dependencies: None
  - Acceptance Criteria: Helper compiles under `npm run typecheck`; direct delivery uses `pi.sendUserMessage(prefill, { deliverAs: "followUp" })`; compact delivery calls `ctx.compact()` without awaiting; callback/fallback races can only deliver once; empty prefill is handled gracefully without queuing; `ctx.ui.setEditorText(prefill)` is used if automatic delivery throws.
  - Steps:
    1. Add `packages/ask-user/handoff.ts` or an equivalent local helper section in `packages/ask-user/tools.ts`.
    2. Define a `COMPACT_HANDOFF_FALLBACK_MS` constant set to `1500`.
    3. Add a prefill normalization/validation function that trims input and returns a clear cancellation/error result for empty prefill.
    4. Add a command delivery function that wraps `pi.sendUserMessage(prefill, { deliverAs: "followUp" })` in `try/catch`.
    5. On delivery failure, set the editor text to the original prefill and notify the user to press Enter.
    6. Add an idempotent `deliverOnce(reason)` closure for compact handoff, clearing the fallback timer when delivery wins.
    7. Ensure the compact path starts `ctx.compact({ customInstructions, onComplete, onError })` and treats synchronous compact-start errors as a reason to deliver anyway.

- completed: Task 2 — Rewire `ask_user` launcher actions to fire and hand off
  - Description: Replace the current compact Promise/30-second timeout flow in `packages/ask-user/tools.ts` with the helper so both launcher actions queue the selected prefill and return/abort immediately.
  - Dependencies: Task 1
  - Acceptance Criteria: `Run directly` queues the prefill immediately, calls `ctx.abort()`, and returns concise queued-handoff text; `Compact & run` starts compaction without awaiting, schedules callback/fallback delivery, calls `ctx.abort()`, and returns concise queued-handoff text; `Cancel`, no-UI, normal selection/freeform/combined/timed-out, and `end_turn` behavior remain unchanged; old 30-second timeout logic is removed.
  - Steps:
    1. Import or define the handoff helper in `packages/ask-user/tools.ts`.
    2. Preserve existing launcher UI invocation and cancellation branch.
    3. For `launcherResult.action === "direct"`, call the direct handoff helper, then abort the current turn if a non-empty prefill was queued or editor-prefilled.
    4. For `launcherResult.action === "compact"`, build compact instructions with the shared `COMPACTOR_INSTRUCTION` sentinel, call the compact handoff helper, then abort the current turn if a non-empty prefill was queued or editor-prefilled.
    5. Return details that preserve `response.kind === "new_session"`, `response.prefill`, and `launchedWith`, with an added launch status/reason if useful for rendering.
    6. Keep cancellation and empty-prefill responses as cancelled/error-like tool results without accidental command delivery.

- completed: Task 3 — Update result rendering, types, and ask-user docs
  - Description: Align user-facing result text and documentation with queued handoff semantics rather than the old "compacted/running then LLM continues" wording.
  - Dependencies: Task 2
  - Acceptance Criteria: `createRenderResult()` shows clear labels such as `queued compact →` and `queued direct →`; fallback-to-editor paths use warning wording where the returned metadata can reflect them; `packages/ask-user/types.ts` has any needed metadata type additions without `any` where practical; `packages/ask-user/skills/ask-user/SKILL.md` and `packages/ask-user/README.md` describe Compact & run, Run directly, cancellation, and editor fallback accurately.
  - Steps:
    1. Extend the relevant launch metadata type(s), keeping backwards compatibility with existing `AskUserResponse` fields.
    2. Update `createRenderResult()` for `new_session` results to distinguish queued compact, queued direct, cancelled, and known editor-prefill fallback states.
    3. Update raw tool result text in `tools.ts` to say `Queued compact handoff: ...` or `Queued direct handoff: ...`.
    4. Update the ask-user skill documentation's Action Types and Session Launcher sections to say the launcher queues/submits the prefill command and aborts unnecessary LLM follow-up.
    5. Update the ask-user README session-launcher documentation if it contains the old return-to-LLM behavior.

- completed: Task 4 — Add verification coverage and manual test notes
  - Description: Verify the compact/direct handoff behavior with the strongest available project checks, and document manual scenarios for UI behavior that cannot be exercised by the current test harness.
  - Dependencies: Task 3
  - Acceptance Criteria: `npm run typecheck` passes; if a suitable test harness exists, helper-level tests cover direct queue, compact callback, compact fallback timeout, cancellation/empty prefill, and send failure editor fallback; if no suitable harness exists, the plan receives manual verification notes covering those scenarios; normal non-`new_session` ask_user responses are explicitly regression-checked.
  - Steps:
    1. Inspect repository scripts and existing tests before deciding whether to add automated tests or manual-only notes.
    2. Add helper-level tests only if they can run with existing dependencies and without creating a new test framework.
    3. Run `npm run typecheck`.
    4. Manually verify or document how to verify: Compact & run immediate return, callback delivery, fallback delivery exactly once, Run directly immediate delivery, Cancel, send failure fallback-to-editor, and unchanged normal ask_user selection/freeform/combined/timed-out/end_turn behavior.
    5. Record verification results in the plan's Reviewer Remarks during `/unipi:work` or `/unipi:review-work`.

- completed: Task 5 — Audit workflow handoff examples for `new_session` usage
  - Description: Review related workflow and ask-user handoff examples so suggested next workflow commands can benefit from the fixed automatic handoff when `ask_user` is available.
  - Dependencies: Task 3
  - Acceptance Criteria: Handoff sections in relevant workflow skills are audited; at minimum `brainstorm`, `plan`, `work`, and `review-work` handoffs either use `ask_user` options with `action: "new_session"` and `prefill` for suggested next commands, or explicitly preserve text-only fallback when `ask_user` is unavailable; no workflow phase semantics are changed beyond the handoff mechanism; documentation still provides copyable slash commands.
  - Steps:
    1. Search workflow skills for handoff sections that present next slash commands.
    2. Update the most relevant handoff instructions to prefer `ask_user` `new_session` options for automatic continuation.
    3. Keep copyable command examples in the docs for non-interactive/manual fallback.
    4. Avoid broad rewrites of workflow semantics, task lifecycles, or branch/worktree behavior.
    5. Re-run `npm run typecheck` if TypeScript files changed after the first check.

## Sequencing

```
Task 1 (helper)
  ↓
Task 2 (tool launcher wiring)
  ↓
Task 3 (rendering/types/docs)
  ↓
Task 4 (verification)
  ↘
   Task 5 (workflow handoff audit; can start after Task 3 and run alongside final verification)
```

Tasks 1–3 are the core behavior change and should be completed in order. Task 4 validates the behavior. Task 5 is documentation/skill hygiene and should not block the core fix unless it reveals a contradiction in handoff semantics.

## Reviewer Remarks

### /unipi:work verification — 2026-05-06

- Added `packages/ask-user/tests/handoff.test.ts` using the existing Node test style; coverage includes direct follow-up queuing, empty-prefill cancellation, send failure editor fallback, compact completion callback delivery, compact fallback timer delivery, idempotency, and synchronous compact-start failure.
- Ran `npm test --workspace @pi-unipi/ask-user` — pass (6 tests).
- Ran `npm run typecheck` — pass.
- Audited workflow handoff sections in `brainstorm`, `plan`, `work`, and `review-work`; each now prefers `ask_user` `action: "new_session"` handoffs when available while retaining copyable slash-command fallbacks.
- Manual UI scenarios still recommended before release: exercise the launcher with Compact & run immediate return, Run directly immediate return, Cancel, and normal selection/freeform/combined/timed-out/end_turn responses in a live Pi TUI.

## Risks

1. **Abort timing:** Calling `ctx.abort()` too early could hide the tool result or interfere with queued delivery. Mitigation: schedule delivery first, then abort, matching existing `end_turn` behavior and preserving returned tool details.
2. **Compact callback lifecycle:** The compaction callback may fire after the tool call has returned and after the current turn aborts. Mitigation: close over only stable `pi`, `ctx.ui`, and prefill values; use idempotent delivery and non-blocking notification.
3. **Timer leaks or duplicate delivery:** Fallback timer and callbacks can race. Mitigation: centralize all delivery through `deliverOnce(reason)`, clear the timer when delivery happens, and do not call `pi.sendUserMessage()` anywhere else for the same launcher action.
4. **No existing test runner:** The repo currently exposes typecheck but may not have a package-level test harness for TUI/tool helpers. Mitigation: keep helper logic small and dependency-injectable; document manual verification if automated tests would require adding new infrastructure.
5. **Over-broad workflow doc edits:** Many skills suggest next commands. Mitigation: audit broadly but edit narrowly, preserving copyable commands and existing workflow semantics.

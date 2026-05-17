---
title: "Compactor Percent Threshold — Implementation Plan"
type: plan
date: 2026-05-18
workbranch: ""
specs: []
source_issue: "https://github.com/Neuron-Mr-White/UniPi/issues/7"
---

# Compactor Percent Threshold — Implementation Plan

## Overview

Plan an extension-managed percentage-based auto-compaction trigger for Issue #7. Pi core currently auto-compacts from an absolute reserve-token rule (`contextTokens > contextWindow - reserveTokens`), which triggers very late on 1M-context models. UniPi should add an optional compactor setting that triggers its zero-LLM compaction earlier based on context usage percentage while still allowing safe repeated compactions over a long session and avoiding duplicate/looping compactions.

Branch strategy: work directly on main (`workbranch: ""`) per user selection.

No brainstorm spec was provided; this plan is based on the issue text plus read-only review of the current compactor implementation.

## Scope

In scope:
- Add optional percentage-based auto-compaction settings to UniPi compactor config.
- Trigger UniPi compaction from extension runtime using `ctx.getContextUsage()` and `ctx.compact()`.
- Use `COMPACTOR_INSTRUCTION` so triggered compactions use the existing zero-LLM compactor hook.
- Add loop/repeat safeguards so compaction can happen multiple times across a session without retriggering continuously after one compaction.
- Expose settings through config migration, defaults, TUI settings, and docs.
- Add tests for trigger decisions and config migration.

Out of scope for this plan:
- Changing Pi core settings/schema (`~/.pi/agent/settings.json`).
- Per-tool-family thresholds (the issue mentions this as a possible future idea). Keep this plan to one global percentage trigger.
- Changing compaction summary content or cut-point behavior beyond what is necessary for triggered compaction.

## Tasks

- completed: Task 1 — Define auto-compaction percentage config
  - Description: Add a typed top-level config section for UniPi-managed percentage auto-compaction.
  - Dependencies: None.
  - Acceptance Criteria:
    - `CompactorConfig` includes a clearly named setting group for percentage triggering.
    - `DEFAULT_COMPACTOR_CONFIG` includes backward-compatible defaults.
    - `migrateConfig()` fills the new section when old config files omit it.
    - Existing presets still produce valid configs.
  - Steps:
    1. Add an `autoCompaction` or similarly clear config object to `packages/compactor/src/types.ts`.
    2. Include fields such as `enabled`, `thresholdPercent`, `cooldownMs`, `repeatMinGrowthTokens`, and `notify`.
    3. Choose safe defaults: disabled by default, `thresholdPercent` around 80, bounded cooldown, and a modest repeat growth guard.
    4. Update `packages/compactor/src/config/schema.ts` with defaults.
    5. Update `packages/compactor/src/config/manager.ts` migration to merge the new object.
    6. Update preset generation if needed so preset hashes/detection remain stable and intentional.

- completed: Task 2 — Add a pure trigger-decision helper
  - Description: Implement percentage-trigger decision logic in a small pure module before wiring it into extension events.
  - Dependencies: Task 1.
  - Acceptance Criteria:
    - Helper can decide: disabled, unknown usage, below threshold, crossing threshold, already in-flight, cooldown active, and repeated compaction after sufficient context growth.
    - Helper handles Pi's post-compaction `null` usage state without triggering.
    - Helper is unit-testable without Pi runtime.
  - Steps:
    1. Create a helper module such as `packages/compactor/src/compaction/auto-trigger.ts`.
    2. Define explicit state: previous percent/tokens, in-flight flag, last trigger timestamp, and post-compaction baseline if needed.
    3. Trigger on percentage crossing from below to at/above threshold.
    4. Allow repeated compaction when still above threshold only after cooldown plus enough token growth since the post-compaction/high-water baseline.
    5. Return structured decisions (`shouldTrigger`, `reason`, updated state) so event wiring can notify/debug without duplicating logic.

- completed: Task 3 — Wire the trigger into compactor extension runtime
  - Description: Register a `turn_end` handler in `packages/compactor/src/index.ts` that checks live context usage and triggers UniPi compaction when the helper says to compact.
  - Dependencies: Task 2.
  - Acceptance Criteria:
    - Uses `ctx.getContextUsage()` and ignores `undefined`/`null` token or percent values.
    - Calls `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION, onComplete, onError })` when eligible.
    - Does not trigger while a UniPi-triggered compaction is already in flight.
    - Resets in-flight state on both completion and error.
    - Does not block Pi core overflow/threshold compaction; this trigger only provides an earlier optional threshold.
  - Steps:
    1. Import `COMPACTOR_INSTRUCTION` where the runtime trigger is implemented.
    2. Load project-aware config in the handler using `loadConfig(ctx.cwd ?? process.cwd())`.
    3. Pass context usage and current time into the pure helper.
    4. If the helper returns `shouldTrigger`, call `ctx.compact()` with the compactor sentinel.
    5. On completion, mark state as completed and optionally notify with percentage/token context.
    6. On error/cancel, clear in-flight state and optionally notify without immediately retriggering.
    7. Preserve existing `session_before_compact`/`session_compact` behavior.

- completed: Task 4 — Expose settings in TUI and commands/docs
  - Description: Make the new percentage trigger discoverable and configurable.
  - Dependencies: Task 1.
  - Acceptance Criteria:
    - `/unipi:compact-settings` exposes enable/disable and threshold percent at minimum.
    - README/config docs describe how this differs from Pi's `compaction.reserveTokens`.
    - Help text mentions percentage auto-trigger if enabled.
  - Steps:
    1. Add an Auto Compaction/Trigger section or settings rows in `packages/compactor/src/tui/settings-overlay.ts`.
    2. Add rows for enabled state and threshold percent; include cooldown/repeat settings if the existing TUI pattern can represent them cleanly.
    3. Update `packages/compactor/README.md` configurables with example JSON.
    4. Update `/unipi:compact-help` text in `packages/compactor/src/commands/index.ts` if needed.

- completed: Task 5 — Update context-budget reporting if useful
  - Description: Align budget messaging with percentage-trigger semantics without changing core behavior.
  - Dependencies: Task 1.
  - Acceptance Criteria:
    - `context_budget` advice can mention the configured percent trigger when available, or remains unchanged if the tool lacks live ctx access.
    - No misleading claim that compaction will happen if the feature is disabled.
  - Steps:
    1. Review `packages/compactor/src/tools/context-budget.ts` and `packages/compactor/src/tools/register.ts`.
    2. If practical, pass live `ctx.getContextUsage()` into the tool instead of only using rough `tokensBefore` defaults.
    3. Otherwise, defer this as documentation-only and avoid broadening the implementation.

- completed: Task 6 — Add tests for config and repeated-trigger safeguards
  - Description: Verify migration/defaults and the pure auto-trigger helper.
  - Dependencies: Tasks 1 and 2.
  - Acceptance Criteria:
    - Config migration tests cover old partial configs and new defaults.
    - Auto-trigger tests cover first crossing, repeated crossing after compaction, no trigger during cooldown, no trigger while in-flight, and no trigger for `null` usage.
    - Existing compactor tests remain valid or are updated for intentional default changes.
  - Steps:
    1. Extend `packages/compactor/tests/config.test.ts` for new config fields.
    2. Add `packages/compactor/tests/auto-trigger.test.ts` or similar.
    3. Include specific regression cases for repeated compaction: after a completed trigger and a fresh below-threshold baseline, crossing threshold again should trigger.
    4. Include anti-loop cases: after a completed trigger with unknown/null usage or unchanged high usage, it should not immediately trigger repeatedly.

- completed: Task 7 — Validate with typecheck and tests
  - Description: Run project validation after implementation.
  - Dependencies: Tasks 1–6.
  - Acceptance Criteria:
    - `npm run typecheck` passes.
    - `npm test` passes.
    - Manual or lightweight smoke check confirms the extension imports/loads with the new config shape.
  - Steps:
    1. Run `npm run typecheck`.
    2. Run `npm test`.
    3. If tests reveal existing unrelated failures, document them and keep changes scoped.
    4. Smoke-test a mocked or local trigger path if possible.

## Sequencing

1. Task 1 establishes schema/defaults and migration.
2. Task 2 adds pure logic so repeated-compaction behavior is explicit and testable before runtime wiring.
3. Task 3 wires the helper into Pi extension events.
4. Task 4 makes the feature user-configurable/discoverable.
5. Task 5 is optional refinement; do it only if it stays small.
6. Task 6 adds regression tests for the core behavior.
7. Task 7 validates the whole change.

Dependency graph:

```txt
Task 1 ─┬─> Task 2 ─> Task 3 ─┐
        ├─> Task 4 ───────────┤
        └─> Task 6 <──────────┘
Task 5 ───────────────────────┤
Task 7 <──────────────────────┘
```

## Repeated-Compaction Safeguard Design Notes

The implementation should support multiple compactions in a long session, but not a rapid compaction loop. The planned behavior:

- Ignore unknown usage: Pi reports `tokens: null` and `percent: null` immediately after compaction until a fresh LLM response.
- Track in-flight compaction: never call `ctx.compact()` again until `onComplete` or `onError` fires.
- Trigger on crossing: if previous known percent was below threshold and current percent is at/above threshold, trigger.
- Permit repeat while still high only with guardrails: if context remains above threshold after a completed compaction, require cooldown plus meaningful token growth before another trigger.
- Reset baseline after a successful compaction and after the next known usage sample.
- Keep Pi core overflow recovery intact; UniPi's trigger is an early optional trigger, not a replacement for Pi core safety.

## Risks

- Event ordering risk: Pi core may run its own auto-compaction near the same time as the UniPi trigger. The implementation needs in-flight/cooldown checks and should tolerate `ctx.compact()` returning `Already compacted` or cancellation.
- Threshold default risk: enabling an 80% trigger by default would change existing behavior. Plan uses disabled-by-default for backward compatibility unless the user explicitly chooses otherwise during implementation.
- TUI complexity risk: existing settings overlay is optimized for mode/toggle rows. Numeric threshold editing may require a simple value cycling approach or a follow-up TUI enhancement.
- Test harness risk: compactor tests use `bun:test` imports while repository validation runs through npm. Implementation should follow the existing test style and rely on the current root `npm test --workspaces --if-present` behavior.
- Current test drift: existing `config.test.ts` appears to assert an old `overrideDefaultCompaction` default. If validation exposes this, update tests only where behavior is intentionally defined.

## Work Log

- Implemented typed `autoCompaction` config with disabled-by-default percentage trigger settings.
- Added pure `auto-trigger` decision helper with cooldown, in-flight, null-usage, and repeat-growth safeguards.
- Wired `turn_end` runtime handling to call `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION })` when eligible.
- Added `/unipi:compact-settings` Auto tab, help/README documentation, and context-budget messaging.
- Added compactor test script plus config and auto-trigger tests.
- Validation passed:
  - `npm run typecheck`
  - `npm test`
  - `node --import tsx -e "import('./packages/compactor/src/index.ts').then(()=>console.log('compactor extension import ok'))"`

## Acceptance Summary

The work is complete when a user can enable percentage auto-compaction, set a threshold, and have UniPi trigger zero-LLM compaction at that percentage on large-context models, with tests proving it can compact again later without immediately re-triggering in a loop.

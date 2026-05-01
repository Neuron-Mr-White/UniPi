---
title: "ask_user Session Launcher — Implementation Plan"
type: plan
date: 2026-05-02
workbranch:
specs:
  - .unipi/docs/specs/2026-05-02-ask-user-session-launcher-design.md
---

# ask_user Session Launcher — Implementation Plan

## Overview

Add a two-step launcher overlay to `@pi-unipi/ask-user`. When the user selects a `new_session` option from `ask_user`, a secondary TUI appears offering "Compact & run" or "Run directly". Compaction uses `ctx.compact()` wrapped in a Promise. The prefill text is then returned to the LLM as the tool result.

All changes live in `packages/ask-user/`. No Pi core changes needed.

## Tasks

- completed: Task 1 — Add `SessionLauncherResult` type to `types.ts`
  - Description: Add the result interface for the launcher UI component.
  - Dependencies: None
  - Acceptance Criteria: Type compiles, no runtime impact (type-only change).
  - Steps:
    1. Open `packages/ask-user/types.ts`
    2. Add `SessionLauncherResult` interface after existing types:
       ```typescript
       /** Result from the session launcher UI */
       export interface SessionLauncherResult {
         action: "compact" | "direct" | "cancel";
         prefill: string;
       }
       ```

- completed: Task 2 — Create `packages/ask-user/launcher-ui.ts`
  - Description: Build the standalone launcher TUI component following the same factory pattern as `ask-ui.ts`. Three fixed options: Compact & run, Run directly, Cancel. Shows the prefill command in a header.
  - Dependencies: Task 1 (needs `SessionLauncherResult` type)
  - Acceptance Criteria:
    - Factory function `renderLauncherUI({ prefill })` returns `(tui, theme, kb, done) => Component`
    - Three options rendered with ↑↓ navigation and Enter to select
    - Escape cancels
    - Header shows truncated prefill command
    - Visual style matches `ask-ui.ts` (border, spacing, theme usage)
  - Steps:
    1. Create `packages/ask-user/launcher-ui.ts`
    2. Import `Key`, `matchesKey`, `Text`, `truncateToWidth`, `visibleWidth` from `@mariozechner/pi-tui`
    3. Import `SessionLauncherResult` from `./types.js`
    4. Define 3 options array: `🧹 Compact & run` → `{ action: "compact" }`, `▶ Run directly` → `{ action: "direct" }`, `✕ Cancel` → `{ action: "cancel" }`
    5. Implement factory function following `ask-ui.ts` pattern:
       - State: `optionIndex`, `cachedLines`
       - `handleInput`: ↑↓ arrows change `optionIndex`, Enter calls `done()` with result, Escape calls `done(null)`
       - `render`: Box border with header showing prefill (truncated), option list with `>` cursor, footer hint line
       - Return `{ render, invalidate, handleInput }`
    6. No Editor, no timeout, no multi-select — this is a simple single-select picker

- completed: Task 3 — Modify `tools.ts` execute() to intercept `new_session` and launch overlay
  - Description: After the existing `ctx.ui.custom()` call returns, detect `new_session` response kind. Open the launcher UI. Handle compact/direct/cancel paths.
  - Dependencies: Task 2 (needs `renderLauncherUI`)
  - Acceptance Criteria:
    - Non-`new_session` responses pass through unchanged
    - `new_session` response opens launcher overlay
    - "Compact & run" triggers `ctx.compact()` with Promise wrapper, waits for completion, returns prefill text
    - "Run directly" returns prefill text immediately
    - "Cancel" / Escape returns cancellation text
    - Compaction errors are caught and surfaced gracefully
  - Steps:
    1. Open `packages/ask-user/tools.ts`
    2. Import `renderLauncherUI` from `./launcher-ui.js`
    3. Import `SessionLauncherResult` from `./types.js`
    4. After the existing `result` from `ctx.ui.custom()` is resolved and `response` is extracted, add a block:
       ```
       if (response.kind === "new_session") {
         const prefill = response.prefill || "";
         const launcherResult = await ctx.ui.custom<SessionLauncherResult | null>(
           renderLauncherUI({ prefill })
         );
         
         if (!launcherResult || launcherResult.action === "cancel") {
           return { content: [{ type: "text", text: "User cancelled the session launch" }], details: { ... } };
         }
         
         if (launcherResult.action === "compact") {
           await new Promise<void>((resolve, reject) => {
             ctx.compact({
               customInstructions: `Preparing for new task. Summarize previous work concisely, preserving only what's essential for: ${prefill}`,
               onComplete: () => resolve(),
               onError: (err) => reject(err),
             });
           }).catch((err) => { /* log warning, continue anyway */ });
         }
         
         contentText = `User chose to proceed: ${prefill}`;
         // Add launchedWith to response
       }
       ```
    5. Ensure the rest of the function continues to build and return the tool result correctly
    6. Add `launchedWith` field to the response when launcher was used:
       ```typescript
       response: {
         ...response,
         launchedWith: launcherResult.action, // "compact" | "direct"
       }
       ```

- completed: Task 4 — Update `renderResult` in `ask-ui.ts` to display launcher outcome
  - Description: Modify `createRenderResult()` to show launcher-specific text when `launchedWith` is present on a `new_session` response.
  - Dependencies: Task 3 (needs `launchedWith` field on response)
  - Acceptance Criteria:
    - Compact path shows: `✓ compacted → /unipi:plan specs:...`
    - Direct path shows: `✓ running → /unipi:plan specs:...`
    - Non-launcher `new_session` still shows existing `✓ new session: ...` text
  - Steps:
    1. Open `packages/ask-user/ask-ui.ts`
    2. In `createRenderResult()`, find the `case "new_session"` block
    3. Check for `response.launchedWith`:
       - If `"compact"`: return `✓ compacted → {prefill}`
       - If `"direct"`: return `✓ running → {prefill}`
       - Otherwise: keep existing behavior (`✓ new session: {prefill}`)

- completed: Task 5 — Update `package.json` files array
  - Description: Add `launcher-ui.ts` to the package files list so it's included in publishes.
  - Dependencies: Task 2 (file must exist)
  - Acceptance Criteria: `launcher-ui.ts` listed in `files` array in `package.json`.
  - Steps:
    1. Open `packages/ask-user/package.json`
    2. Add `"launcher-ui.ts"` to the `files` array

- completed: Task 6 — Update SKILL.md with launcher behavior docs
  - Description: Document the new launcher overlay behavior in the ask-user skill file so LLMs understand what happens with `new_session` options.
  - Dependencies: Task 3 (behavior must be finalized)
  - Acceptance Criteria: SKILL.md mentions the launcher overlay and its Compact/Run/Cancel options.
  - Steps:
    1. Open `packages/ask-user/skills/ask-user/SKILL.md`
    2. In the Action Types section, update the `"new_session"` row description to mention the launcher overlay
    3. Optionally add a note about the two-step flow

## Sequencing

```
Task 1 (types)
  → Task 2 (launcher-ui.ts) ─┐
                              ├→ Task 3 (tools.ts integration)
  ────────────────────────────┘       │
                                       ├→ Task 4 (renderResult)
                                       ├→ Task 5 (package.json)
                                       └→ Task 6 (SKILL.md)
```

Tasks 4, 5, 6 are independent of each other but all depend on Task 3.

## Risks

- **`ctx.compact()` fire-and-forget**: The Promise wrapper must handle the case where `onComplete` is never called (e.g., compaction is aborted). Add a timeout safeguard or catch and continue.
- **Tool execution timeout**: Compaction takes time (LLM call). The tool execution might hit a timeout. This is unlikely in practice since compaction is fast, but worth noting.
- **UI state after compaction**: After compaction, the session is reloaded. The tool must return its result before this happens — the `await` on the Promise ensures this ordering since `ctx.compact()` triggers async but the tool returns synchronously after `onComplete`.

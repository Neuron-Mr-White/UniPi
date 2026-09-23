---
title: "ask_user Session Launcher"
type: brainstorm
date: 2026-05-02
---

# ask_user Session Launcher

## Problem Statement

When the LLM presents a `new_session` action option via `ask_user` (e.g., "start new session: /unipi:plan specs:..."), selecting it currently returns plain text to the LLM. The LLM runs the command in the same session with full stale context. There is no way for the user to prepare their context (compact) before running the suggested command.

## Context

- `ask_user` tool receives `ExtensionContext` which has `ctx.compact()` — Pi's built-in compaction, always available
- `@pi-unipi/compactor` extension enhances compaction via `session_before_compact` hook, but compaction works without it
- The tool already uses `ctx.ui.custom()` for interactive TUI overlays
- No Pi core changes needed — everything lives in `@pi-unipi/ask-user`
- The `new_session` response kind is already defined in types and handled in the UI

## Chosen Approach

**Two-step overlay**: When the user selects a `new_session` option from `ask_user`, the tool detects the response kind, then opens a second launcher TUI offering "Compact & run" or "Run directly". The tool blocks on compaction (via `ctx.compact()` with `onComplete` callback wrapped in a Promise), then returns the prefill text to the LLM.

## Why This Approach

- **No Pi core changes** — all APIs needed are on `ExtensionContext` (`ctx.compact()`, `ctx.ui.custom()`)
- **Clean separation** — the launcher is a standalone component, ask_user UI stays unchanged
- **Compaction always works** — `ctx.compact()` is Pi's built-in feature; compactor extension enhances it when present
- **Simple UX** — two clear choices + cancel, nothing to configure

**Alternatives rejected:**
- Inline expansion within ask_user UI (Approach B) — significant refactoring of ask-ui.ts, tight coupling
- Pi core PR to add `newSession()` to `ExtensionContext` — unnecessary complexity for what is fundamentally a "compact then run" feature

## Design

### Architecture

```
ask_user UI → user selects new_session option
         ↓
   tools.ts detects kind === "new_session"
         ↓
   ctx.ui.custom() → renderLauncherUI({ prefill })
         ↓
   ┌─────────────────────────────────┐
   │  🚀 Next: /unipi:plan specs:... │
   │                                 │
   │  > 🧹 Compact & run            │
   │    ▶ Run directly              │
   │    ✕ Cancel                    │
   └─────────────────────────────────┘
         ↓
   User picks action
         ↓
   If "compact": await ctx.compact({ onComplete })
         ↓
   Return prefill text to LLM
```

### Components

#### `packages/ask-user/launcher-ui.ts` (NEW)

Launcher TUI component following same pattern as `ask-ui.ts`:

- **Factory function**: `renderLauncherUI({ prefill: string })` returns `(tui, theme, kb, done) => { render, handleInput, invalidate }`
- **Options**: 3 fixed items — Compact & run, Run directly, Cancel
- **Navigation**: ↑↓ arrows, Enter to select, Escape to cancel
- **Header**: Shows the prefill command (truncated to available width)
- **Visual style**: Same border/spacing as ask_user's UI for consistency

#### `packages/ask-user/types.ts`

Add `SessionLauncherResult`:
```typescript
export interface SessionLauncherResult {
  action: "compact" | "direct" | "cancel";
  prefill: string;
}
```

#### `packages/ask-user/tools.ts`

Modified `execute()` flow — after the existing `ctx.ui.custom()` call:

1. If result is null (cancelled) or response kind is not `new_session` → existing handling (unchanged)
2. If response kind is `new_session`:
   a. Extract `prefill` from response
   b. Open launcher: `await ctx.ui.custom<SessionLauncherResult>(renderLauncherUI({ prefill }))`
   c. If launcher returns null or `action === "cancel"` → return cancellation text
   d. If `action === "compact"` → `await` compaction via Promise-wrapped `ctx.compact()`
   e. Return prefill text to LLM: `"User chose to proceed: {prefill}"`

### Compaction Behavior

```typescript
await new Promise<void>((resolve, reject) => {
  ctx.compact({
    customInstructions: `Preparing for new task. Summarize previous work concisely, preserving only what's essential for: ${prefill}`,
    onComplete: () => resolve(),
    onError: (err) => reject(err),
  });
});
```

- **With `@pi-unipi/compactor` installed**: The compactor extension's `session_before_compact` hook intercepts and provides enhanced compaction (better summaries, FTS5 indexing)
- **Without compactor**: Pi's built-in compaction runs — compresses conversation into a summary via the LLM

### Render Result Display

Update `createRenderResult()` to handle launcher outcomes:

- Compact path: `✓ compacted → {prefill}`
- Direct path: `✓ running → {prefill}`
- Cancelled: `Cancelled`

### Response Details

The tool result `details` object gains a `launchedWith` field:

```typescript
details: {
  question,
  options: normalizedOptions.map(o => o.label),
  response: {
    kind: "new_session",
    prefill,
    launchedWith: "compact" | "direct",
  },
}
```

## Implementation Checklist

- [x] Create `packages/ask-user/launcher-ui.ts` — launcher TUI component with 3 options, same visual style as ask-ui.ts — covered in Task 2
- [x] Add `SessionLauncherResult` interface to `packages/ask-user/types.ts` — covered in Task 1
- [x] Modify `packages/ask-user/tools.ts` execute() — detect `new_session` response, open launcher, handle compact/direct/cancel — covered in Task 3
- [x] Modify `packages/ask-user/tools.ts` renderResult — display launcher outcome (compacted → / running →) — covered in Task 4
- [ ] Test: ask_user with new_session option → launcher appears → compact & run works
- [ ] Test: ask_user with new_session option → launcher appears → run directly works
- [ ] Test: ask_user with new_session option → launcher → cancel returns gracefully
- [ ] Test: ask_user without new_session option → no launcher, existing behavior unchanged

## Open Questions

- Should the launcher show context usage stats (current % of context window) to help the user decide whether to compact? This would use `ctx.getContextUsage()`.
- Should the compaction `customInstructions` mention the specific skill being launched (e.g., "for plan phase")?

## Out of Scope

- Opening a literal new Pi session/tab (requires Pi core changes)
- `sendUserMessage` with command expansion (Pi's `prompt()` with `expandPromptTemplates: true`)
- Modifying the `new_session` action semantics in the skill system
- Changes to `@pi-unipi/compactor` package

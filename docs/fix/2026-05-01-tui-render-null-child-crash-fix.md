---
title: "TUI crash — renderResult null child — Fix Report"
type: fix
date: 2026-05-01
debug-report: docs/debug/2026-04-30-tui-child-render-promise-crash-debug.md
status: fixed
---

# TUI Crash — `renderResult` null child — Fix Report

## Summary
Replaced all four `return null as any;` paths in the diff-wrapper `renderResult` functions (write tool + edit tool) with valid Component-like objects that implement `render(width)`. This prevents `Container.render()` from crashing when it calls `child.render(width)` on a null child.

## Debug Report Reference
- Report: `docs/debug/2026-04-30-tui-child-render-promise-crash-debug.md`
- Root Cause: `ToolExecutionComponent` + `Container` unconditionally call `.render()` on children; the diff wrapper's `renderResult` returns `null` on error/empty/catch paths, which crashes the TUI.

## Changes Made

### Files Modified
- `packages/utility/src/diff/wrapper.ts` — Replaced 4 `return null as any;` with valid renderable components

### Code Changes

**Write tool — empty/details guard (was line 161):**
```ts
// Before:
return null as any;

// After:
const msg = result?.content?.[0]?.text ?? "";
return {
  setText: () => {},
  text: msg,
  render: (width: number) => (width > 0 ? [msg.slice(0, width)] : [msg]),
} as any;
```

**Write tool — catch block (was line 195):**
```ts
// Before:
return null as any;

// After:
const fallback = "(diff rendering failed)";
return {
  setText: () => {},
  text: fallback,
  render: (width: number) => (width > 0 ? [fallback.slice(0, width)] : [fallback]),
} as any;
```

**Edit tool — empty/details guard (was line 281):** Same pattern as write tool empty guard.
**Edit tool — catch block (was line 309):** Same pattern as write tool catch block.

## Fix Strategy
1. For the "no details" guard (edit fails → `details: undefined`): Extract the error message from `result.content[0].text` ("Could not find text to replace...") and render it inline. This gives the user visible feedback about what went wrong.
2. For the catch block (rendering exception): Return a static "(diff rendering failed)" text so the TUI never sees a null child.
3. Both return objects with `setText`, `text`, and `render(width)` — matching the duck-typed component interface the TUI expects.

## Verification

### Test Results
- ✓ TypeScript compilation passes (`npx tsc --noEmit` — clean)
- ✓ No remaining `return null` in renderResult functions (only `readFileSafe` utility retains `return null`, which is unrelated to rendering)
- ✓ Original bug path: `edit` with mismatched `oldText` → error message rendered inline instead of crash
- ✓ Catch path: any rendering exception → fallback text instead of crash

### Regression Check
- ✓ Normal diff rendering (successful write/edit) is unchanged — the code paths with actual diffs are untouched
- ✓ `readFileSafe` utility behavior unchanged

## Risks & Mitigations
- **Risk**: Error text might not match exact width constraints of nested containers.
  **Mitigation**: Uses `width` parameter from `render()` to truncate; same approach as the normal diff renderer.
- **Risk**: `result.content[0].text` might be undefined for edge cases.
  **Mitigation**: Nullish coalescing `?? ""` fallback.

## Notes
- The prior debug report (`2026-04-30`) diagnosed the async/Promise variant of this same architectural gap. The `null` variant was latent and surfaced when the AI attempted edits with mismatched `oldText`.
- A defensive null guard in `Container.addChild` (pi-tui) would be the most robust long-term fix but requires changes to an external dependency.
- This fix is purely in unipi-controlled code and covers all 4 known `renderResult → null` paths.

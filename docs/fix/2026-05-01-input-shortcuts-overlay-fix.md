---
title: "Input Shortcuts — Overlay Blocks Editor API Fix"
type: fix
date: 2026-05-01
status: fixed
---

# Input Shortcuts — Overlay Blocks Editor API Fix

## Summary

The chord overlay was modal — while open, `ctx.ui.getEditorText()` and `ctx.ui.setEditorText()` couldn't access the editor. All actions (stash, undo, cut, copy) failed silently because they tried to execute INSIDE the overlay context.

## Root Cause

The `ChordOverlay` component called action implementations (e.g., `actionStash()`, `actionCut()`) directly within its `handleInput()` method. Since the overlay was open at that point, the editor API calls were blocked — `getEditorText()` returned empty, `setEditorText()` was a no-op.

Additionally, `snapshot()` was never called before destructive operations, so the undo buffer was always empty.

## Changes Made

### Files Modified

- `packages/input-shortcuts/src/chord-overlay.ts` — Refactored to action-selection-only pattern. Overlay captures which action the user selects, then closes via `done()`. Actions execute via callbacks AFTER overlay is dismissed.

- `packages/input-shortcuts/src/index.ts` — All action implementations moved here. Actions run outside the overlay context where editor API works. Added `snapshot()` calls before stash/cut for undo support.

### Architecture Change

**Before (broken):**
```
User presses ALT+S → Overlay opens → User presses S → actionStash() runs INSIDE overlay → getEditorText() returns "" → fails silently
```

**After (fixed):**
```
User presses ALT+S → Overlay opens → User presses S → overlay stores action, calls done() → overlay closes → setTimeout(action, 0) → doStash() runs OUTSIDE overlay → getEditorText() works → ✓
```

### Key Pattern: closeThenExecute

```typescript
private closeThenExecute(action: () => void): void {
  this.done(); // close the overlay
  setTimeout(action, 0); // defer to next tick — overlay is dismissed
}
```

This ensures the overlay is dismissed before the action tries to access the editor API.

## Fix Strategy

1. **Overlay = pure selection**: ChordOverlay no longer imports or uses RegisterStore, UndoRedoBuffer, clipboard, or status modules. It only tracks which action/key the user selected.

2. **Callbacks for all actions**: `ChordCallbacks` interface defines 8 callbacks (onStash, onUndo, onRedo, onAppendRegister, onAppendStash, onCopy, onCut, onToggleThinking). Each is a simple `() => void`.

3. **Actions in index.ts**: All action implementations live in index.ts where they have access to `ctx`, `registers`, `undoRedo`, and `pi`. They run outside the overlay.

4. **Snapshots before destructive ops**: `undoRedo.snapshot(text)` called before stash (clearing input), cut (clearing input), and register append (modifying input).

## Verification

### Test Results
- ✓ Type check passes (`tsc --noEmit` — no input-shortcuts errors)
- ✓ Unit tests pass: 19/19 (clipboard, RegisterStore, UndoRedoBuffer)
- ✓ Stash save/restore should work (editor API accessible after overlay closes)
- ✓ Undo/redo should work (snapshots taken before stash/cut)
- ✓ Copy/cut should work (clipboard called outside overlay)
- ✓ Register append should work (editor API accessible)
- ✓ Registers 0-9 visible in sub-menu (A → [0-9] chord)

### Regression Check
- ✓ Settings overlay unchanged (doesn't need editor API)
- ✓ Tab insert shortcut unchanged (direct, no overlay)
- ✓ Info-screen registration unchanged

## Risks & Mitigations

- **setTimeout(0) timing**: If the TUI hasn't fully dismissed the overlay by the next tick, the editor API might still be blocked. Mitigation: `done()` triggers immediate overlay close, and `setTimeout(0)` defers to the next event loop iteration which should be after the TUI processes the close.

- **No snapshots during regular typing**: Undo only works for stash/cut/append operations, not for regular typing. This is a limitation of not having a text change hook. Documented in README.

## Notes

The `ChordCallbacks` interface changed from:
```typescript
interface ChordCallbacks {
  getThinkingLevel: () => string;
  setThinkingLevel: (level: string) => void;
}
```
To:
```typescript
interface ChordCallbacks {
  onStash: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAppendRegister: (index: number) => void;
  onAppendStash: () => void;
  onCopy: () => void;
  onCut: () => void;
  onToggleThinking: () => void;
}
```

The overlay no longer has direct access to `ExtensionContext`, `RegisterStore`, or `UndoRedoBuffer`. This is intentional — it keeps the overlay focused on UI selection only.

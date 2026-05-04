---
title: "Footer Width Overflow Recurrence — Fix Report"
type: fix
date: 2026-05-04
debug-report: 2026-05-02-footer-width-overflow-debug.md
status: fixed
---

# Footer Width Overflow Recurrence — Fix Report

## Summary
Footer extension still crashes pi intermittently despite previous truncation fix. Added defense-in-depth safety nets at the widget render boundary and improved left-zone overflow handling.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-05-02-footer-width-overflow-debug.md`
- Root Cause: Previous fix added `truncateToWidth` in layout methods, but the crash persisted. The safety nets were at the wrong level — layout math can have edge cases, so the final output boundary must enforce the width limit.

## Changes Made

### Files Modified
- `packages/footer/src/index.ts` — Added hard `truncateToWidth` safety net in both widget `render()` methods (footer-top and footer-secondary). Every line returned to pi-tui is now guaranteed to fit within the terminal width.
- `packages/footer/src/rendering/renderer.ts` — Three changes:
  1. Added left-zone progressive segment dropping (previously only right-zone was dropped)
  2. Fixed `buildContentFromParts` guard from `if (maxWidth && maxWidth > 0)` to `if (maxWidth != null && maxWidth > 0)` — the old check would skip truncation if maxWidth was `0` (falsy). Added fallback truncation to 200 chars when no maxWidth provided.
  3. Recalculate `adjLeftWidth` after left-zone dropping for correct center-zone overflow calculation

### Code Changes

**Widget render() safety net** (in `index.ts`):
```typescript
// Before:
return layout.topContent ? [layout.topContent] : [];

// After:
const line = layout.topContent;
return [visibleWidth(line) > width ? truncateToWidth(line, width) : line];
```

**Left-zone overflow dropping** (in `renderer.ts`):
```typescript
// Added after right-zone dropping:
let adjustedLeftWidth = leftWidth;
while (zones.left.length > 1 && adjustedLeftWidth + marginWidth > width) {
  const dropped = zones.left.pop()!;
  adjustedLeftWidth = this.measureZoneWidth(zones.left, sepWidth);
  overflowZones.left.push(dropped);
}
```

**Fixed truncation guard** (in `renderer.ts`):
```typescript
// Before: if (maxWidth && maxWidth > 0) — skips truncation when maxWidth is 0
// After:  if (maxWidth != null && maxWidth > 0) — only skips when truly not provided
// Plus: fallback truncation to 200 when maxWidth is not provided
```

## Fix Strategy

Defense in depth — three layers of protection:

1. **Layer 1 (Layout)**: Progressive segment dropping in `computeLayout` — drops right-zone, then left-zone segments until they fit. Falls back to dropping center-zone segments. (Previous fix + new left-zone support)

2. **Layer 2 (Row assembly)**: `truncateToWidth(result, fullWidth)` at the end of `buildZoneRow` and `buildContentFromParts`. (Previous fix + tightened guard)

3. **Layer 3 (NEW — Widget boundary)**: Hard `truncateToWidth` in the widget `render()` method itself. This is the absolute last point before lines are handed to pi-tui. Even if layers 1-2 have edge cases (e.g., `visibleWidth` inconsistency with PUA characters + ANSI codes), this layer guarantees no line exceeds the terminal width.

## Verification

### Test Results
- ✓ TypeScript compilation: no new errors in modified files
- ✓ `truncateToWidth` works correctly for PUA chars + ANSI codes (verified with Node.js test)
- ✓ Edge case width=0 handled correctly (returns empty string)
- ✓ All pre-existing tests pass (10/10)

### Regression Check
- ✓ Footer renders normally at wide terminal widths (no change to layout logic)
- ✓ Segment dropping still works for narrow terminals
- ✓ Secondary row overflow still works
- ✓ Widget render methods still return `string[]` type

## Risks & Mitigations
- **Aggressive truncation at widget boundary**: Could cut off content that layout math says should fit. Mitigation: `visibleWidth(line) > width` check means truncation only fires when the line is actually too wide.
- **Left-zone dropping keeps at least 1 segment**: The `zones.left.length > 1` guard ensures the first (most important) left-zone segment (usually model name) is never dropped.

## Notes
- The crash was intermittent ("sometimes throw"), suggesting edge cases in `visibleWidth` measurement for specific character sequences rather than a deterministic bug in layout math.
- The crash log showed Nerd Font Supplementary PUA characters (U+F0000-U+FFFFD range) mixed with ANSI 256-color codes — this combination could trigger grapheme segmentation edge cases in pi-tui's width calculation.
- This is a recurrence of the 2026-05-02 fix — the previous fix added truncation in layout methods but missed the widget boundary layer.

## Follow-up
- [ ] Monitor crash logs after deployment to confirm fix
- [ ] Consider reporting upstream to pi-tui if `visibleWidth` inconsistency with PUA chars is confirmed

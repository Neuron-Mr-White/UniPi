---
title: "Footer: Remove wf/rl text, show dash for no workflow, fix confusing session ID"
type: quick-fix
date: 2026-05-01
---

# Footer: Remove wf/rl text, show dash for no workflow, fix confusing session ID

## Bug
Three issues in the footer display:
1. "wf" and "rl" text labels appeared alongside Nerd Font icons for workflow and ralph segments — redundant and cluttered
2. When no workflow was active, the workflow segment disappeared entirely instead of showing a placeholder
3. The last stat in the footer showed a confusing `019ddfb6` — which was the session ID (first 8 chars), not meaningful to users

## Root Cause
1. The text/emoji icon sets had fallback labels ("wf", "rlp") that appeared when `getIcon()` was called, even in nerd mode via `withIcon()`
2. `renderCurrentCommandSegment` returned `visible: false` when no command was set
3. The `session` segment showed `sessionId.slice(0, 8)` — an opaque hex ID. It was included in full/nerd preset secondary rows

## Fix
1. Set workflow and ralph icons to empty string (`""`) in both emoji and text icon sets — only the hardcoded Nerd Font glyphs (`\uf52e`, `\udb81\udf09`) render now
2. Changed `renderCurrentCommandSegment` to show `{WORKFLOW_ICON} -` when no command instead of returning `visible: false`
3. Removed `session` from secondary row segments in full and nerd presets. The segment definition remains available as a hidden segment if users want it back

### Files Modified
- `packages/footer/src/rendering/icons.ts` — Cleared ralph/workflow icons in emoji and text icon sets
- `packages/footer/src/segments/workflow.ts` — Show dash when no workflow active
- `packages/footer/src/presets.ts` — Removed `session` from full/nerd secondary segments

## Verification
- TypeScript compilation: `npx tsc --noEmit` passes
- All 41 tests pass: `npm test` in packages/footer

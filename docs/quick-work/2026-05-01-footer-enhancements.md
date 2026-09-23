---
title: "Footer Enhancements: Thinking Colors, Workflow/Ralph/Mem Icons"
type: quick-work
date: 2026-05-01
---

# Footer Enhancements: Thinking Colors, Workflow/Ralph/Mem Icons

## Task
4 enhancements to the footer package:
1. Add thinking level option with different color per level, xhigh rainbow + rainbow input bar
2. Replace "wf" text with  icon for workflow, each workflow type slightly different color
3. Ralph loop: use 󰼉 icon, green dot + stats when on, red dot when off
4. Memory: use  icon, display project/total format (e.g. 76/102)

## Changes

- **`packages/footer/src/types.ts`**: Added new semantic colors: `ralphOn`, `ralphOff`, `workflowBrainstorm`, `workflowPlan`, `workflowWork`, `workflowReview`, `workflowAuto`, `workflowOther`, `thinkingHigh`, `thinkingXhigh`

- **`packages/footer/src/rendering/theme.ts`**: Added default color mappings for all new semantic colors. Each thinking level maps to its dedicated theme color (thinkingMinimal, thinkingLow, etc.). Workflow types map to different theme colors for visual differentiation.

- **`packages/footer/src/rendering/icons.ts`**: Updated Nerd Font icons for ralph segments (󰼉), workflow segments (), and memory segments (). Updated emoji and text icon sets for consistency.

- **`packages/footer/src/segments/core.ts`**: 
  - Added `rainbowText()` function for per-character rainbow coloring using ANSI 256-color palette
  - Added `rainbowBorder()` function for rainbow border line rendering
  - Added `getThinkingLevel()` helper exported for use by index.ts
  - Thinking segment now uses per-level semantic colors (thinkingHigh, thinkingXhigh added)
  - xhigh level renders with rainbow text coloring

- **`packages/footer/src/segments/workflow.ts`**: 
  - Uses  icon instead of default terminal icon
  - `getWorkflowSemanticColor()` maps command names to distinct colors
  - brainstorm=warning, plan=success, work=accent, review=muted, auto=thinkingHigh

- **`packages/footer/src/segments/ralph.ts`**: 
  - Uses 󰼉 icon for all ralph segments
  - Green dot (●) with iteration stats when loop is active (e.g. "󰼉 ● 1/3")
  - Red dot (●) when loop is off (e.g. "󰼉 ●")
  - Dots use explicit ANSI codes to preserve their color independently of theme wrapping

- **`packages/footer/src/segments/memory.ts`**: 
  - Uses  icon for all memory segments
  - `project_count` now shows combined format "76/102" when both project and total counts are available
  - `total_count` is hidden when project_count already shows the combined view

- **`packages/footer/src/index.ts`**: 
  - Imports `getThinkingLevel` and `rainbowBorder` from core segments
  - `footer-secondary` widget now renders a rainbow border line below the editor when thinking level is xhigh

## Verification
- TypeScript compilation: `npx tsc --noEmit` passes with no errors
- All 41 existing tests pass: `npm test` in packages/footer

## Notes
- The rainbow border for the input bar is rendered as a widget line in the `belowEditor` placement. It appears as a rainbow ── line when xhigh thinking is active.
- The editor border color itself is still managed by pi's interactive mode (using theme.getThinkingBorderColor). The rainbow widget line is an additional visual indicator below the editor.
- The ralph segment dots use explicit ANSI escape codes rather than theme colors to ensure they always render as green/red regardless of the active theme.

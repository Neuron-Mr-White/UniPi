---
title: "Footer Four Fixes"
type: quick-work
date: 2026-05-01
---

# Footer Four Fixes

## Task
Four fixes for the footer package:
1. Change API State label to WEB (matches @pi-unipi/web-api package name)
2. Footer enable should work immediately without restart
3. Refactor footer-settings TUI to use pi-tui SettingsList (like compactor)
4. Fix icon inconsistency — memory segments used hardcoded icon instead of withIcon()

## Changes
- `packages/footer/src/segments/core.ts`: Renamed "API State" → "WEB", display text "ok" → "WEB"
- `packages/footer/src/index.ts`: Exported FooterState, added setupUI callback field for live UI re-registration
- `packages/footer/src/commands.ts`: Added setupUI to state interface, call it when enabling footer (toggle and "on" command)
- `packages/footer/src/segments/memory.ts`: Replaced hardcoded MEMORY_ICON constant with proper withIcon() calls using segment IDs ("projectCount", "totalCount", "consolidations")
- `packages/footer/src/tui/settings-tui.ts`: Full rewrite — replaced custom overlay with pi-tui SettingsList (vim/arrow keybindings, search, tabbed sections for groups/segments, consistent with compactor settings overlay)

## Verification
- `tsc --noEmit` passes cleanly
- All 41 footer tests pass (5 empty test files are pre-existing failures)

## Notes
- The setupUI pattern stores a closure that captures `setupFooterUI` from the session_start handler, so it can re-register footer + widgets after they've been disposed by "off"
- The SettingsList refactor adds fuzzy search (`/` key) to both groups and segments sections, matching the compactor UX
- Tab key switches between Groups and Segments sections; Enter in groups mode enters segments for the focused group

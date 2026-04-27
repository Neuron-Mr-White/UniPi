---
title: "Enhanced TUI Autocomplete for /unipi:* Commands — Implementation Plan"
type: plan
date: 2026-04-28
workbranch: ""
specs:
  - .unipi/docs/specs/2026-04-28-autocomplete-enhancement-design.md
---

# Enhanced TUI Autocomplete for `/unipi:*` Commands — Implementation Plan

## Overview

Create a self-contained extension (`@pi-unipi/command-enchantment`) that intercepts `/unipi:*` autocomplete and returns enhanced items with package-colored tags and sorted grouping. Zero changes to existing packages or pi core.

## Tasks

- completed: Task 1 — Create package scaffold and constants
  - Description: Set up `packages/autocomplete/` with `package.json`, define `COMMAND_REGISTRY`, `PACKAGE_ORDER`, and `PACKAGE_COLORS` constants
  - Dependencies: None
  - Acceptance Criteria:
    - `packages/autocomplete/package.json` exists with correct name and dependencies
    - `COMMAND_REGISTRY` maps all 52 verified commands to their packages
    - `PACKAGE_ORDER` and `PACKAGE_COLORS` defined with ANSI codes
  - Steps:
    1. Create `packages/autocomplete/package.json` with name `@pi-unipi/command-enchantment`
    2. Create `packages/autocomplete/src/constants.ts` with full `COMMAND_REGISTRY` (52 commands)
    3. Define `PACKAGE_ORDER` array (workflow, ralph, memory, mcp, utility, ask-user, info, web-api, compact, notify)
    4. Define `PACKAGE_COLORS` mapping with ANSI bright codes

- completed: Task 2 — Implement autocomplete provider logic
  - Description: Create the main provider file with `getSuggestions`, fuzzy matching, and item formatting
  - Dependencies: Task 1
  - Acceptance Criteria:
    - Provider intercepts `/unipi:*` input and returns enhanced items
    - Non-unipi commands pass through unchanged
    - Items sorted by package order, then alphabetically within each package
    - `[package]` tags rendered with correct ANSI colors
    - Descriptions extracted from base suggestions (option 1 from spec review)
    - Fuzzy matching works for partial input
  - Steps:
    1. Create `packages/autocomplete/src/provider.ts`
    2. Import `fuzzyFilter` from `@mariozechner/pi-tui`
    3. Implement `getSuggestions()`:
      - Check if input starts with `/`
      - Call `current.getSuggestions()` to get base suggestions
      - Filter out unipi items, save their descriptions
      - Generate enhanced unipi items using `COMMAND_REGISTRY`
      - Merge non-unipi + enhanced items
    4. Implement `applyCompletion()` delegating to `current`
    5. Implement `shouldTriggerFileCompletion()` delegating to `current`
    6. Implement `getEnhancedUnipiItems()` with sorting and formatting
    7. Implement simple fuzzy matching for filtering commands

- completed: Task 3 — Implement settings and extension entry point
  - Description: Add `autocompleteEnhanced` setting toggle and create the extension entry point that registers the provider on `session_start`
  - Dependencies: Task 2
  - Acceptance Criteria:
    - Extension registers autocomplete provider via `ctx.ui.addAutocompleteProvider()` on `session_start`
    - `autocompleteEnhanced` setting defaults to `true`
    - When disabled, provider delegates entirely to base without interception
    - Settings stored in `~/.unipi/config/command-enchantment/config.json`
  - Steps:
    1. Create `packages/autocomplete/src/settings.ts` following web-api pattern
    2. Define `CommandEnchantmentConfig` interface with `autocompleteEnhanced: boolean`
    3. Implement `loadConfig()` / `saveConfig()` functions
    4. Create `packages/autocomplete/src/index.ts` extension entry point
    5. Register provider in `session_start` handler (check settings before registering)
    6. Export default function taking `ExtensionAPI`

- completed: Task 4 — Register extension in main unipi index
  - Description: Import and call the new extension in `packages/unipi/index.ts`
  - Dependencies: Task 3
  - Acceptance Criteria:
    - `packages/unipi/index.ts` imports and calls `commandEnchantment`
    - Extension loads without errors
  - Steps:
    1. Add import for `@pi-unipi/command-enchantment` in `packages/unipi/index.ts`
    2. Call `commandEnchantment(pi)` alongside other extensions

- in-progress: Task 5 — Manual testing and verification
  - Description: Test all command categories, edge cases, and settings toggle
  - Dependencies: Task 4
  - Acceptance Criteria:
    - Type `/` — verify merged list with all commands
    - Type `/brain` — verify workflow commands filtered correctly
    - Type `/mem` — verify memory commands filtered correctly
    - Type `/mcp` — verify mcp commands filtered correctly
    - Type `/compact` — verify compact commands filtered correctly
    - Type `/notify` — verify notify commands filtered correctly
    - Type `/model`, `/quit` — verify non-unipi commands show normally
    - Type `/unipi:nonexistent` — verify no crash, graceful fallback
    - Disable setting — verify plain autocomplete returns
    - Verify argument completions work (e.g., `/unipi:plan specs:`)
  - Steps:
    1. Run `pnpm build` to compile
    2. Start pi with the extension loaded
    3. Test each command category with fuzzy input
    4. Test non-unipi commands pass through
    5. Test empty prefix shows all commands
    6. Test settings toggle (disable, verify plain autocomplete)
    7. Test argument completions for commands with parameters
    8. Verify ANSI colors render correctly in terminal

## Sequencing

```
Task 1 (constants) → Task 2 (provider) → Task 3 (settings + entry) → Task 4 (register) → Task 5 (test)
```

Linear dependency chain — each task builds on the previous.

## Risks

1. **ANSI rendering:** Some terminals may not render ANSI codes in autocomplete descriptions. Mitigation: feature is toggleable via settings.
2. **fuzzyFilter import:** Need to verify `@mariozechner/pi-tui` exports `fuzzyFilter` (confirmed in github-issue-autocomplete example).
3. **Command drift:** Commands added in future won't appear in `COMMAND_REGISTRY`. Mitigation: add startup validation that logs warnings for missing commands.
4. **Performance:** 52 commands with fuzzy matching should be fast (no network calls), but worth verifying.

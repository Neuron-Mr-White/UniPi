---
title: "CocoIndex commands sent as string instead of being handled — Quick Fix"
type: quick-fix
date: 2026-05-05
---

# CocoIndex commands sent as string instead of being handled — Quick Fix

## Bug
All cocoindex commands (`/unipi:cocoindex-update`, `/unipi:cocoindex-status`, `/unipi:cocoindex-init`, `/unipi:cocoindex-settings`) were being sent to the LLM as plain text strings instead of being handled by their registered command handlers.

## Root Cause
Two issues prevented cocoindex commands from being registered:

1. **Missing npm symlink:** The `@pi-unipi/cocoindex` package was listed in `package.json` as a dependency but was not installed in `node_modules/@pi-unipi/cocoindex/`. Pi's extension loader references `node_modules/@pi-unipi/cocoindex/index.ts`, so the extension silently failed to load. When a command isn't registered, Pi's `_tryExecuteExtensionCommand()` returns `false`, and the command text falls through as a regular user message string.

2. **Missing from all-in-one entry:** The `packages/unipi/index.ts` barrel file (used with `--no-extensions -e packages/unipi/index.ts` mode) did not import or call the cocoindex extension, so even the all-in-one loading path missed it.

The unipi command registry (`packages/autocomplete/src/constants.ts`) already had all 4 cocoindex commands properly registered — the autocomplete suggestions appeared fine, but the actual command handlers never loaded.

## Fix

1. Ran `npm install` to create the missing symlink for `@pi-unipi/cocoindex` in `node_modules/`.
2. Added cocoindex import and invocation to `packages/unipi/index.ts`.

### Files Modified
- `packages/unipi/index.ts` — Added `import cocoindex from "@pi-unipi/cocoindex"` and `cocoindex(pi)` call

## Verification
- `npx tsc --noEmit --skipLibCheck` passes with no errors
- `node_modules/@pi-unipi/cocoindex/index.ts` symlink exists
- Autocomplete registry already had all 4 commands registered
- All 5 autocomplete data structures (PACKAGE_ORDER, PACKAGE_COLORS, COMMAND_REGISTRY, COMMAND_DESCRIPTIONS, PACKAGE_LABELS) already included cocoindex entries

## Notes
- The register-extension chore doc (`.unipi/docs/chore/register-extension.md`) documents all required registration points. The cocoindex package had most of them done correctly — only the npm install and all-in-one entry were missing.
- The root barrel file (`packages/cocoindex/index.ts`) was already correct.
- The `MODULES.COCOINDEX` constant was already in `packages/core/constants.ts`.

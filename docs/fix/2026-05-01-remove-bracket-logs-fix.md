---
title: "Remove bracket-prefixed console logs causing TUI rendering issues — Quick Fix"
type: quick-fix
date: 2026-05-01
---

# Remove bracket-prefixed console logs causing TUI rendering issues — Quick Fix

## Bug
Console output (console.log, console.warn, console.error) with bracket-prefixed messages like `[footer]`, `[compactor]`, `[notify]`, `[kanboard]`, `[smart-fetch]`, `[command-enchantment]`, `[pi-diff]`, `[MCP]` was writing to stdout/stderr during TUI operation, causing rendering artifacts and layout shifts in the terminal UI.

## Root Cause
43 active `console.log/warn/error` calls across 12 source files were writing bracketed log messages to stdout/stderr. In a TUI (terminal user interface) context, any stdout/stderr output that isn't part of the Ink/React rendering pipeline corrupts the screen layout — the raw text appears at the cursor position and pushes rendered content, causing visual glitches.

## Fix
Removed all active `console.log/warn/error` calls in non-test source files. Each was replaced with either:
- A silent `catch {}` block with a comment explaining why
- A disabled/no-op function body for debug loggers
- Direct removal of the log statement, keeping only the side effects

The pattern follows the existing convention already established in other files (memory, mcp, kanboard, milestone) where previous console calls were commented out with `// Removed console.log/warn — ...` explanations.

### Files Modified
- `packages/footer/src/events.ts` — Removed 17 `console.error("[footer] ...")` calls in event handlers
- `packages/footer/src/config.ts` — Removed 3 `console.warn("[footer] ...")` calls in settings read/write/parse
- `packages/footer/src/registry/index.ts` — Disabled debug logger that wrote `[footer-registry:...]` messages
- `packages/footer/src/tui/settings-tui.ts` — Removed `console.error("[footer] ...")` in overlay error handler
- `packages/notify/tools.ts` — Removed `console.error("[notify] ...")` in background dispatch catch
- `packages/notify/events.ts` — Removed 4 `console.error("[notify] ...")` calls in event/notification handlers
- `packages/autocomplete/src/settings.ts` — Removed `console.error("[command-enchantment] ...")` in config load
- `packages/web-api/src/settings.ts` — Removed 2 `console.error("[web-api] ...")` calls in auth/config load
- `packages/web-api/src/engine/extract.ts` — Removed `console.warn("[smart-fetch] ...")` in defuddle fallback
- `packages/web-api/src/engine/profiles.ts` — Removed `console.warn("[smart-fetch] ...")` in unknown profile
- `packages/utility/src/diff/highlighter.ts` — Removed `console.warn("[pi-diff] ...")` in Shiki load error
- `packages/kanboard/server/index.ts` — Removed `console.error("[kanboard] ...")` in route error handler
- `packages/mcp/src/index.ts` — Removed `console.error("[MCP] ...")` in server restart error
- `packages/compactor/src/index.ts` — Disabled `createDebugLogger` that wrote `[compactor:...]`; removed 2 `console.error` in init failures
- `packages/compactor/src/commands/index.ts` — Disabled `deprecationLog` that wrote `[compactor] DEPRECATED:`
- `packages/compactor/src/compaction/hooks.ts` — Disabled `dbg` debug logger that wrote `[compactor:...]`
- `packages/compactor/src/tools/register.ts` — Disabled `deprecationLog` that wrote `[compactor] DEPRECATED:`

## Verification
- TypeScript compilation (`tsc --noEmit`) passes with no errors
- All 43 console calls confirmed removed via `rg` search
- No functional behavior changed — errors are still caught and handled, just not logged to stdout/stderr
- Existing error tracking mechanisms (info-screen, registry state, result objects) remain intact

## Notes
- Error information is still captured through proper channels: info-screen data providers, registry state, result objects, and UI notifications
- Debug logging for compactor can be re-enabled through a file-based log or proper logging library if needed in the future
- The compactor deprecation logs were also removed — deprecation is communicated through command descriptions and tool descriptions, not stdout

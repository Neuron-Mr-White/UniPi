---
title: "Notify TUI — kitty-protocol keys & empty model selector fix"
type: fix
issue: 27
date: 2026-08-18
---

# Notify TUI Overlays — Normalized Key Handling & Live Model Registry

## Bug (issue #27)

Reported against `@pi-unipi/notify` 2.5.0 in Ghostty/Herdr, verified in Herdr 0.8.x:

1. **Up/Down arrows and Escape dead** in `/unipi:notify-settings` and the
   Recap Model Selector, while `j`/`k`, Tab, Space, and Enter worked.
2. **Model selector empty** (`/0 models · No models found`) even though Pi had
   models configured.

## Root Cause

### 1. Raw byte-sequence key matching

Both overlays compared `handleInput(data)` against exact legacy strings:
`"\x1b[A"` / `"\x1b[B"` (arrows), `"\x1b"` (Escape). Pi requests the kitty
keyboard protocol with flags 7 (disambiguate + event types + alternate keys);
Herdr then delivers **Escape as `\x1b[27u`** and Ctrl+C as `\x1b[99;5u` —
sequences that never equal the legacy strings, so Escape silently did nothing
(and the selector trapped the user: even Ctrl+C fell through). Printable keys
are single unmodified bytes in every encoding, which is why they kept working.

Verified empirically: `herdr pane send-keys <pane> esc` against `cat -v`
prints `^[[27u` once the pane app enables the protocol.

### 2. Selector read only the optional cache file

`RecapModelSelectorOverlay` called `readModelCache()` (reads
`~/.unipi/config/models-cache.json`, returns `[]` when absent). That cache has
a single producer — the utility package's `session_start` hook — so the
selector was empty whenever utility was not loaded or the hook had not run,
even with a fully populated model registry.

## Fix

- `packages/notify/tui/settings-overlay.ts` — all special keys matched via
  `matchesKey(data, "up"|"down"|"space"|"tab"|"enter"|"escape")` from
  `@earendil-works/pi-tui` (handles legacy CSI, SS3, kitty CSI-u, and
  modifyOtherKeys encodings); `ctrl+c` always closes; `m`/`M` both open the
  model selector.
- `packages/notify/tui/recap-model-selector.ts` — same normalized matching in
  both normal and filter mode (Enter/Backspace included); `ctrl+c` closes even
  mid-filter; arrows navigate inside filter mode; empty state distinguishes
  "no models anywhere" (actionable hint pointing at `~/.pi/agent/models.json`)
  from "no filter match"; constructor accepts injected models.
- `packages/notify/commands.ts` — `registryModels(ctx)` collects models from
  the live `ctx.modelRegistry` (`getAvailable()` → `getAll()` fallback) and
  injects them into both selector entry points; new non-TUI command
  `/unipi:notify-event <event> <on|off>` (escape hatch requested in the issue;
  reports the new value and reminds to `/reload`).
- `packages/core/constants.ts` — `NOTIFY_COMMANDS.NOTIFY_EVENT` added.
- `packages/core/model-cache.ts` — cache paths resolved lazily (respects
  `HOME` changes; required for test isolation).

## Verification

- `packages/notify`: **52/52 tests pass** (`tsc --noEmit` + node:test), incl.
  new `src/__tests__/tui-input.test.ts` feeding every Up/Down/Escape/Enter/
  Backspace encoding (legacy CSI, SS3, kitty CSI-u, modifyOtherKeys) into both
  overlays, model injection, cache fallback, and actionable empty state.
- Root `npm run typecheck` passes.
- **Live Herdr E2E (before/after)**, pi booted in a herdr pane with isolated
  `HOME` (no `models-cache.json`, reproducing the reporter's environment):
  - *Old code*: arrow Down did not move selection; `j` did; Escape left the
    overlay open; selector showed `/0 models`; Escape did not close it.
  - *Fixed code*: Down/Up navigate (settings + selector), Escape closes both,
    selector lists 5 live-registry models (`zai/*` from auth) with the current
    model pre-selected, Enter persists `recap.model`, and
    `/unipi:notify-event agent_end on` reports + persists.

## Notes

- `matchesKey` covers `\x1b[57419u`/`\x1b[57420u` (kitty CSI-u arrows) and
  `\x1b[1;1A` (modified legacy) in addition to plain legacy/SS3 forms — the
  overlays are now encoding-agnostic.
- Precedent: same class of fix as `.unipi/docs/fix/2026-05-01-updater-tui-fix.md`
  and the comment in `packages/image/src/tui/model-selector.ts`.

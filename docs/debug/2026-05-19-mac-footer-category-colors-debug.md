---
title: "Footer category colors do not appear on macOS terminals — Debug Report"
type: debug
date: 2026-05-19
severity: medium
status: root-caused
---

# Footer category colors do not appear on macOS terminals — Debug Report

## Summary
`@pi-unipi/footer` colour-codes the workflow segment by category (brainstorm = red, plan = orange, work = yellow, review = green, etc.). On macOS — both in Apple Terminal.app and inside the “Unipi agent” terminal (Claude Code / Cursor / Zed agent transcript) — those colours are not visible: the footer renders as plain (or default-fg) text and the category distinction is lost.

## Expected Behavior
The current_command footer segment renders each workflow category in its own colour, as defined in `packages/footer/src/rendering/theme.ts`:

| Category                                  | Semantic color        | Hex      |
| ----------------------------------------- | --------------------- | -------- |
| brainstorm / debug / gather-context / quick-* / chore-create | `workflowBrainstorm` | `#e06c75` (red)    |
| plan / chore-execute                      | `workflowChoreExec`   | `#d19a66` (orange) |
| work                                      | `workflowWork`        | `#e5c07b` (yellow) |
| review / review-work                      | `workflowReview`      | `#82cc6f` (green)  |
| auto                                      | `workflowAuto`        | `#c792ea` (purple) |
| worktree-*                                | `worktree`            | `#61afef` (blue)   |
| (idle)                                    | `workflowNone`        | `#4a6a7a` (muted)  |

(Confirmed in `packages/footer/src/segments/workflow.ts:24-60` and `packages/footer/src/rendering/theme.ts:18-66`.)

## Actual Behavior
- In Apple Terminal.app: the workflow segment shows text with no colour difference between categories (often plain default-fg, or with only the icon coloured by theme).
- In the agent terminal (Claude Code / Cursor / etc.) on macOS: the rendered footer also shows no category colour; the ANSI escape bytes are stripped/printed literally by the agent’s transcript renderer.
- Other coloured footer segments that use a hex value (model, session, ralph, kanboard, …) suffer the same problem in the same environments.

## Reproduction Steps
1. Open `Terminal.app` (the default macOS terminal) on macOS 13+ / 14+ / 15+.
2. Run a unipi-enabled pi-coding-agent session (or simulate by emitting the same escapes):
   ```bash
   printf 'truecolor: \x1b[38;2;224;108;117mBRAINSTORM\x1b[0m\n'
   printf '256-color : \x1b[38;5;203mBRAINSTORM\x1b[0m\n'
   ```
   - `truecolor` line appears uncoloured (Apple Terminal silently drops `\e[38;2;…m`).
   - `256-color` line renders correctly in red — proving the terminal does support ANSI colour, just not 24-bit.
3. Trigger a workflow command (e.g. `/unipi:work`) and observe the footer’s `current_command` segment: no red/orange/green differentiation.

For the agent transcript case:
1. Run the same agent on any macOS terminal.
2. Inspect the agent UI’s rendering of a tool result containing ANSI escapes — the bytes are shown literally (e.g. `[38;2;231;108;117mHELLO[0m`) or stripped entirely.

## Environment
- macOS (Darwin 25.x — Sonoma / Sequoia / Tahoe).
- Apple Terminal.app — `TERM=xterm-256color`, `TERM_PROGRAM=Apple_Terminal`, `COLORTERM` **unset**.
- iTerm2 / WezTerm / Ghostty / Alacritty / Zed integrated terminal — `COLORTERM=truecolor` (these DO render correctly; verified in the current Zed terminal: `COLORTERM=truecolor`, `TERM_PROGRAM=zed`).
- “Unipi agent” terminal: pty wrapped by Claude Code / Cursor; the user-facing transcript view does not interpret ANSI escapes for tool output.

## Root Cause Analysis

### Failure Chain
1. Workflow segment computes a semantic colour via `getWorkflowSemanticColor(command)` → `applyColor(semantic, …)` in `packages/footer/src/segments/workflow.ts:82`.
2. `applyColor` looks up the colour value and — because every workflow category value is a hex string like `#e06c75` — takes the **hex branch** in `packages/footer/src/rendering/theme.ts:113-121`:
   ```ts
   if (colorValue.startsWith("#")) {
     // Hex color — we need to emit ANSI directly
     const r = parseInt(hex.slice(0, 2), 16);
     const g = parseInt(hex.slice(2, 4), 16);
     const b = parseInt(hex.slice(4, 6), 16);
     return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
   }
   ```
3. The renderer pushes the resulting string into pi’s `setFooter(...)` (see `packages/footer/src/index.ts:152`).
4. The escape sequence emitted is **24-bit truecolor** (`CSI 38;2;R;G;B m`).
5. The terminal receiving that sequence on macOS is one of:
   - **Apple Terminal.app** — does not support 24-bit truecolor (long-standing limitation, still true on macOS 26). It silently swallows `\e[38;2;…m`, leaving text uncoloured.
   - **An agent UI’s tool-output panel** — strips or literalises ANSI; never displays colour for tool stdout regardless of terminal capability.
6. Result: every category prints with the **same** appearance — no visual differentiation.

### Root Cause
The footer renderer hard-codes **24-bit truecolor** escape sequences for every hex semantic color, with **no capability check**. It does not fall back to 256-colour (`\e[38;5;Nm`) when the terminal lacks truecolor support, and it does not consult the capability detector that already exists in `@pi-unipi/utility`.

A secondary defect compounds this: `packages/utility/src/display/capabilities.ts:46-62` declares `xterm-256color`, `screen-256color`, and `tmux-256color` as “truecolor terms” — those terminfo names indicate **256-colour**, not truecolor. Even if the footer started consulting `detectColorSupport()`, Apple Terminal.app (which exports `TERM=xterm-256color`) would be misclassified as truecolor-capable and the bug would persist. The list also lacks the well-known opt-out: an explicit check that `TERM_PROGRAM === "Apple_Terminal"` should force `truecolor: false`.

### Evidence
- `packages/footer/src/rendering/theme.ts:101-126` — `applyColor()` unconditionally emits `\x1b[38;2;R;G;Bm` for any hex value. No `if (truecolor)` gate, no fallback path.
- `packages/footer/src/rendering/theme.ts:18-66` — every workflow / status hex (`#c792ea`, `#e06c75`, `#d19a66`, `#e5c07b`, `#82cc6f`, `#61afef`, `#4a6a7a`) routes through that branch.
- `packages/footer/src/segments/workflow.ts:75,82,90,108` — every workflow segment call site uses `applyColor`, so all of them are affected.
- `packages/footer/src/segments/{mcp,notify,core,kanboard,…}.ts` — same pattern; all coloured segments share the bug.
- `packages/utility/src/display/capabilities.ts:46-62` — truecolor allow-list incorrectly includes 256-colour terminfo names and is missing an Apple_Terminal opt-out.
- `packages/utility/src/display/capabilities.ts` is never imported by `packages/footer/**` — verified by `grep -rn "capabilities\|detectColorSupport\|detectCapabilities" packages/footer/`.
- Live env probe (Zed terminal, current session): `COLORTERM=truecolor`, `TERM=xterm-256color`, `TERM_PROGRAM=zed` — Zed renders correctly, which is consistent with “truecolor works only when the terminal advertises it”.

## Affected Files
- `packages/footer/src/rendering/theme.ts` — `applyColor()` always emits 24-bit codes for hex.
- `packages/footer/src/segments/workflow.ts` — primary symptom site (the user-visible category colouring).
- `packages/footer/src/segments/{mcp,notify,core,kanboard,memory,context,ralph,…}.ts` — same bug class.
- `packages/utility/src/display/capabilities.ts` — buggy truecolor detector, not wired into the footer.

## Suggested Fix
High-level approach — gate truecolor emission on detected capability, with a clean 256-colour fallback.

### Fix Strategy
1. **Make `applyColor` capability-aware** (`packages/footer/src/rendering/theme.ts`):
   - Cache a `colorMode = "truecolor" | "256" | "none"` once per process (or per render tick) via `detectCapabilities()` from `@pi-unipi/utility`, with explicit overrides honoured (`NO_COLOR`, `FORCE_COLOR`, and a new footer setting `footer.colorMode`).
   - For hex values:
     - `truecolor` → emit `\x1b[38;2;R;G;Bm` (today’s behaviour).
     - `256` → map to nearest xterm-256 index (a small lookup or the standard cube/grayscale formula) and emit `\x1b[38;5;Nm`.
     - `none` → return plain text.
2. **Fix `detectColorSupport`** (`packages/utility/src/display/capabilities.ts`):
   - Remove `xterm-256color`, `screen-256color`, `tmux-256color` from the truecolor list — those imply only 256-colour.
   - Add explicit `Apple_Terminal` opt-out: if `TERM_PROGRAM === "Apple_Terminal"` → `truecolor: false` (even if some pty has `COLORTERM=truecolor` leaked in by error).
   - Require either `COLORTERM in {truecolor, 24bit}` or a known-good `TERM_PROGRAM` (`iTerm.app`, `WezTerm`, `Alacritty`, `kitty`, `ghostty`, `vscode`, `zed`, `cursor`, `Warp`) before reporting `truecolor: true`.
3. **Surface the colour mode in footer settings** (`packages/footer/src/config.ts` + `tui/settings-tui.ts`):
   - Add `colorMode: "auto" | "truecolor" | "256" | "none"` with default `auto`.
   - Allow user override so people on Apple Terminal can force `256` (or anyone can force `none`).
4. **Document** the macOS Apple Terminal limitation in `packages/footer/README.md` so users know to use iTerm2/WezTerm/Ghostty/etc. or enable `colorMode=256`.
5. **(Out-of-scope but worth noting)** The agent transcript (Claude Code / Cursor) strips ANSI from tool output by design. The footer fix will restore colours in the real terminal pty hosting the agent, but the agent’s in-app log view is not the footer’s concern — flag this in the user-facing message.

### Risk Assessment
- **Risk:** Nearest-256 mapping shifts brand colours slightly on 256-colour terminals. **Mitigation:** Pick palette colours that already have good 256 neighbours; allow per-semantic override via `ColorScheme`.
- **Risk:** Misclassifying an obscure terminal as non-truecolor (downgrade-from-correct). **Mitigation:** `auto` defaults are conservative; users can override via `FORCE_COLOR=3` or `footer.colorMode=truecolor`.
- **Risk:** Removing names from the truecolor list could regress users who relied on the incorrect heuristic. **Mitigation:** Still treat any `COLORTERM=truecolor` as truecolor — which is what most well-configured truecolor terminals already export.

## Verification Plan
1. **Unit tests** (`packages/footer/tests/`):
   - New test: with `COLORTERM` unset and `TERM=xterm-256color`, `applyColor("workflowBrainstorm", "x", …)` emits `\x1b[38;5;Nm` (256), not `\x1b[38;2;…m`.
   - New test: with `COLORTERM=truecolor`, emits `\x1b[38;2;224;108;117m`.
   - New test: with `NO_COLOR=1`, emits no escape.
   - Capability test: `TERM_PROGRAM=Apple_Terminal` ⇒ `truecolor === false` regardless of `TERM`.
2. **Manual checks**:
   - Apple Terminal.app on macOS → run unipi; confirm distinct category colours via 256-colour fallback.
   - iTerm2 / WezTerm / Ghostty → unchanged (still truecolor).
   - `NO_COLOR=1` → no escapes; plain text.
   - `FORCE_COLOR=3` inside Apple Terminal → truecolor escapes emitted (user-forced — accepted even if visually they don’t render; documents the override).
3. **Regression**:
   - Run `packages/footer/tests/segments.test.ts` and `config.test.ts`.
   - Visually compare the secondary-row layout: ANSI byte count differs between modes, so check `visibleWidth` accounting still produces correct truncation/zone math.

## Related Issues
- macOS Apple Terminal.app 24-bit colour: known and ongoing limitation; tracked widely in the dev tooling community (no upstream fix).
- Many TUI libraries (chalk, ansi-colors, etc.) already implement this exact downgrade — reference their lookup tables for the nearest-256 mapping.

## Notes
- Today’s capability detector exists but is **dead code** for the footer; wiring it in (and fixing the false positives) is the cheapest reliable fix.
- The agent terminal’s in-app log/transcript view is a separate concern (it strips ANSI for safety). The fix above resolves the host-terminal case, which is what most users see when they `cd` into the project and run `pi` directly. For the agent in-app view, the most we can do is make sure the footer is **also** legible without colour (e.g., short labels like `WRK`/`REV`/`PLAN`), which the footer already supports via the “labeled” mode.

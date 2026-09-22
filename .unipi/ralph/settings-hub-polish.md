# Settings hub POLISH — make it actually UX friendly

User screenshot (2026-09-22, running in **herdr** tabs, real terminal): three defects.
Goal: a panel that FITS the screen, PAINTS uniformly, and NAVIGATES everywhere.

## Defects (from the screenshot — fix 1:1)
1. **Too tall / no viewport** — all ~80 rows render at once; panel runs off screen (cuts at Base URL), hint line invisible. FIX: fixed-height viewport (terminal height minus chrome margin), window of rows around the cursor, scroll indicators (`↑3 more` / `↓5 more`) in the frame, hint line ALWAYS visible. Cursor never leaves the window (auto-scroll to keep cursor visible).
2. **Inconsistent bg paint** — bands differ in width per row; paint leaks past the frame edges on some rows. Root cause: rows mix ANSI-wrapped segments then measure widths (padValue uses visibleWidth on styled strings, bold() wraps ANSI again) → truncateToWidth miscounts → short/long bg. FIX: build every row as PLAIN TEXT at EXACTLY `inner` visible cells (fixed label column, value right-aligned with ellipsis on overflow), THEN apply styling to whole segments (styling never changes visible width). Unit test: EVERY rendered line has visibleWidth(line) === inner.
3. **Cannot navigate** — raw string matching `data === "\x1b[A"` misses real terminals/herdr: arrows may arrive as SS3 (`\x1bOA`), kitty/extended encodings (`\x1b[1;…`), or **split chunks** (a lone `\x1b` currently hits my Esc case and CLOSES the panel!). FIX: pi-tui `parseKey`-based key router with escape-sequence buffering (lone ESC that gets no continuation within the same read = real Esc; partial sequences buffer). Handle: ↑/↓ + k/j (all encodings), PageUp/PageDown, Home/End, Tab, Space, Enter (\r and \n), Esc, "/".

## Phase 1 — layout engine (viewport + uniform paint)
- [x] Row layout as plain-text columns (EXACT inner cells, style-after-measure, ellipsis truncation): `  label` (truncated with …) + right-aligned value + hint, EXACTLY inner cells; styling applied after measurement (fg/bold wrap only). Section header rows: full-width band style, same exact width. Selected row visibly highlighted (bg or bold on the whole row).
- [x] Viewport: hub.render(width) — maxRows = terminalRows-7 (−7 reserve when editor/picker open), window around cursor, ↑/↓ more indicators, hint ALWAYS visible, auto-scroll keeps cursor in window. terminalRows injectable for tests. → max height = terminalHeight - margin (take height from tui? or from render width heuristic... check what pi passes: render(width) only — get height via tui/ctx or render only N rows + indicators; investigate pi overlay height contract first). Window logic: keep cursor within [scroll, scroll+maxRows), scroll indicators top/bottom.
- [x] Unit tests: all-lines-exact-width at 80/100/160 (and with picker+editor open), ellipsis truncation, viewport fits short terminals with indicators, cursor-keeps-visible scrolling. 22/22 green.

## Phase 2 — key router (fix navigation everywhere)
- [ ] Key decoding via pi-tui `parseKey`/Key matching + internal escape-sequence buffer (handle split chunks; lone ESC = close only when no continuation follows). Replace ALL raw `data ===` matching.
- [ ] Keys: up/down (k/j) all encodings, PageUp/PageDown, Home/End, Tab, Space, Enter, Esc, "/" — each per the ORIGINAL spec (instant apply; search/edit/picker modes unchanged).
- [ ] Tests: SS3 arrows, CSI arrows, split "\x1b" then "[A" chunks, j/k, pgup/pgdn.

## Phase 3 — visual polish
- [ ] Remove duplicate title (frame title + body "⚙ unipi settings" both show). One clean header line with shortcuts hint.
- [ ] Value ellipsis for long values (openrouter/google/gemini-3-pro-image…), stable column, [G]/[P] tags consistent, section bands distinct from field rows but uniform width.
- [ ] Hint line shows the keys that matter for the cursor's row type.

## Phase 4 — verify
- [ ] tmux on coffee + PC (extended-keys OFF), full drive: open (fits screen!), scroll top→bottom (pgdn/pgdn), toggle, edit, picker, search — capture evidence each.
- [ ] Herdr-path key test if reachable; at minimum SS3/split-sequence unit coverage.
- [ ] typecheck 0; full suite EXIT:0; sync coffee; commit per phase; memory + v3-tasks at end.

## Guardrails
- Do NOT change the interaction spec (space/tab/enter/esc semantics stay).
- Instant-apply only. Non-blocking errors.
- Keep /unipi:settings command + engine writes unchanged.
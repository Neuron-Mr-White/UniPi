# Settings hub UX rewrite + complete module adoption

Authoritative spec (user, 2026-09-22). Test on **coffee** via tmux (`ssh coffee`, absolute pi path,
`~/pi-test`), also verify on PC. Everything applies INSTANTLY (no staged state).

## The interaction spec (exact)
- **Up/k, Down/j** move. **`/`** search (Esc exits search; second Esc closes panel). **Esc** closes panel when not searching/editing.
- **Space**: booleans → instant toggle. string/number/secret → inline input DIRECTLY BELOW the row, prefilled with existing value; Enter saves (instant write), Esc cancels input (Esc again closes panel). Invalid number → error hint under input, stays open.
- **Tab**: booleans → toggle; enums → cycle. Plain enums ignore Space. Enums with `allowCustom` (schema opt-in): Tab cycles options ending in `custom…`; Space on ANY position jumps to custom + opens the inline input (prefilled with current raw value).
- **Model fields** (new schema type `model`): Space or Tab opens a searchable picker — search box + EXACTLY 5 visible rows inline below the row; typing filters; ↑/↓ (j/k) walk the full filtered list; Enter picks (instant); Esc cancels. Catalog source: `~/.pi/agent/models.json` providers → `provider/model` ids (what `pi --list-models` shows). Applies to judge.model, verifierModel, badge.generationModel (+ any model fields found in inventory).
- **Scope row** stays first: Tab switches global ↔ project (project dimmed when unsupported). Per-row key hints (`[Space]`/`[Tab]`) only where meaningful.
- (If user confirms `d` = reset-to-default per field, add it; otherwise skip.)

## Phase 1 — COMPLETE settings inventory (nothing hidden)
- [x] Audit EVERY package for settings surfaces: grep for `.unipi/config`, `~/.pi/agent/settings.json` unipi.* keys, homedir config paths, project-level config files, env-var settings, defaults objects. Produce `docs/settings-inventory.md`: module → settings shape → current storage path → registered-in-engine (y/n) → schema fields planned.
- [x] Include modules never touched yet: fusion (preset.json + project fusion-preset), image, mcp, web-api (wigolo config), input-shortcuts, subagents (config + missions/schedules config), background-tasks (config.ts), btw, info-screen, memory (config.json + MemPalace flags), compactor's REMAINING depth (strategy modes, pipeline opts), footer's remaining depth (groups/segments toggles, separators), notify's remaining depth (event matrix, gotify/telegram/ntfy platform configs — ntfy.json is a second file), long-horizon remaining (none left), workflow/kanboard (if they still have config), updater, ask-user (done), utility (done: badge; skill-discovery?).
- [ ] Distinguish: settings (hub) vs secrets (env/api keys — hub secret fields) vs state (NOT hub).

## Phase 2 — hub rewrite (core/src/settings/hub.ts)
- [ ] Rewrite SettingsHub per spec: new key handling (space/tab/enter/esc/search), inline input below row (insert row, prefill), enum allowCustom cycling + custom input, model picker component (search + 5 rows), scope row, per-row hints, instant writes via engine (setSettings per change), layered value display (show effective + which layer? keep [G]/[P] tags).
- [ ] schema.ts: add `allowCustom?: boolean` to enum fields; add `{ type: "model" }` field type (+ catalog loader util reading ~/.pi/agent/models.json — injectable for tests).
- [ ] Unit tests: key handling per field type, inline input prefill/save/cancel, enum custom flow, model picker filter/nav/5-rows, scope switching, invalid number rejection. No network (catalog from fixture).

## Phase 3 — register ALL modules from inventory
- [ ] Register + migrate reads for every module in the inventory not yet on the engine (fusion, image, mcp, web-api, input-shortcuts, subagents, background-tasks, btw, info-screen, memory, + depth fields of footer/compactor/notify). Keep module APIs stable (same load/save functions, engine underneath). Legacy imports where files predate the engine (follow existing patterns: A_KEY imports, one-time importers).
- [ ] EVERY schema: model-ish fields get type "model"; enums that need free values get allowCustom; secrets (API keys/tokens: notify gotify/telegram/ntfy tokens, mcp env, web-api keys) become secret fields.
- [ ] Update per-module tests for engine semantics (resetSettingsGates in HOME-swap tests; path assertions to canonical layout).

## Phase 4 — verification
- [ ] tmux on coffee: /unipi:settings opens; every module section visible (count vs inventory); drive: toggle a boolean, edit a string (prefilled), enum cycle, enum custom input, model picker search+5rows+pick; capture-pane evidence each step; writes land in ~/.unipi/config/<ns>/config.json (or ./.unipi/config for project scope); fresh session reads changed value.
- [ ] PC tmux: same flow once.
- [ ] `npm run typecheck` 0 errors; full `npm test` EXIT:0; sync repo to coffee (rsync alias pattern).
- [ ] Commit per phase; update docs/v3-tasks.md checkboxes + memory at end.

## Guardrails
- Instant-apply only — NO staged/pending state anywhere.
- Extensions never abort a turn: hub errors are non-blocking (same try/catch pattern).
- Prefix-cache discipline irrelevant here (UI-only), but keep deterministic rendering.
- Do not regress the shipped behaviors: /unipi:settings command name, engine layering, migration gates.
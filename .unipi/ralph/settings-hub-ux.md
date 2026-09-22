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
- [x] Distinguish settings vs secrets vs state — documented in docs/settings-inventory.md (web-api auth.json stays a secrets file; registers/missions/schedules = state, not hub).

## Phase 2 — hub rewrite (core/src/settings/hub.ts)
- [x] Rewrite SettingsHub per spec: new key handling (space/tab/enter/esc/search), inline input below row (insert row, prefill), enum allowCustom cycling + custom input, model picker component (search + 5 rows), scope row, per-row hints, instant writes via engine (setSettings per change), layered value display (show effective + which layer? keep [G]/[P] tags).
- [x] schema.ts: allowCustom + model type + isCustomEnumValue; catalog.ts (parseModelCatalog/loadModelCatalog, injectable).
- [x] Unit tests: 15 hub tests green (all key flows, 5-row window, scope write, invalid-number rejection; catalog from fixture). GOTCHA learned: pi-tui Input setValue leaves cursor at 0 — send \x1b[F (End) after prefill; ctrl-U does NOT clear.

## Phase 3 — register ALL modules from inventory
- [x] Register + migrate reads: ALL modules adopted — image, web-api, updater, info-screen, memory, input-shortcuts, subagents (engine layering replaces manual merge; raw loaders on engine paths), background-tasks (corrupt-file warnings preserved in importer), fusion (default-pair engine overlay; curated lists stay with /unipi:fusion-preset), notify-ntfy (folded into notify ns). mcp SKIPPED by design (server registry = content, not settings). REMAINING: footer/compactor/notify depth fields (optional polish).
- [x] Model fields: judge.model/verifierModel, badge.generationModel, image generate/recognize, memory embedding, fusion default pair. allowCustom: input-shortcuts keys. Secrets: judge.apiKey (web-api/gotify/telegram tokens stay in their own secrets files by design).
- [x] Per-module tests updated along the way (image HOME-swap+canonical paths, background-tasks lazy-write + corrupt-warning importer, subagents raw loaders, utility project path, long-horizon engine-file semantics + resetSettingsGates).

## Phase 4 — verification
- [x] tmux on coffee VERIFIED: panel opens (15 modules/10 sections per screen); boolean toggle on→off→on (judge.enabled, engine file verified both ways); number edit prefilled inline (threshold 0.6→0.7→0.6); enum cycle (updater autoUpdate notify→auto→disabled→notify); model picker (verifierModel: search glm → 5-row window → down → enter → engine write verified); scope Tab global→project + project write landed in ./pi-test/.unipi/config/notify/config.json. FIXES during verification: word-wise AND search across label+section+module (single-string search emptied the panel on 'judge model'); judge.model/verifierModel/badge.generationModel retyped string→model. GOTCHAs: session-name badge overlay must be dismissed (Esc) before driving; tmux extended-keys ON breaks Space/Enter encoding — keep OFF.
- [x] PC tmux VERIFIED (pi 0.86.1): panel opens, sections render, Tab navigation + boolean toggles + scope switch + PROJECT-scope writes all verified (ask-user enabled toggle landed in ./pi-test/.unipi/config/ask-user/config.json). pi 0.86 delivers Enter as \n in overlay paths — added \r||\n handling (coffee's 0.87 uses \r).
- [x] typecheck 0 errors · full suite EXIT:0 · synced to coffee.
- [ ] Commit per phase; update docs/v3-tasks.md checkboxes + memory at end.

## Guardrails
- Instant-apply only — NO staged/pending state anywhere.
- Extensions never abort a turn: hub errors are non-blocking (same try/catch pattern).
- Prefix-cache discipline irrelevant here (UI-only), but keep deterministic rendering.
- Do not regress the shipped behaviors: /unipi:settings command name, engine layering, migration gates.
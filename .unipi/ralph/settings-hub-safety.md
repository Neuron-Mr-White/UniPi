# Settings hub round 3 — safety net + progressive disclosure + per-category flows

User feedback (2026-09-22, 6 items). Learn-from-omp principle adopted: **defaults are
always one key away** (recoverable by construction), not staged buffers.

## Phase 1 — recovery safety net (item 1)
- [x] Snapshot-at-open baseline (lazy per-namespace at first load); `u` undo stack; `d` schema-default reset; `R` baseline revert. Hint advertises `u undo · d default · R revert` (u shown only with history).
- [x] u pops {key, prev, scope, label}, rewrites through the engine; toast row (`undo:`/`default:`/`reverted:`) shows exactly one render; stack capped 50 (LIFO).
- [x] Tests: undo file-evidence + one-render toast, default reset, baseline revert, 50-cap LIFO across toggles, empty-stack no-op. 35/35 green.

## Phase 2 — scope into the title (item 2)
- [ ] Frame title becomes ` unipi settings — global [tab] ` (scope segment IN the title, Tab toggles from anywhere). DELETE the Write-scope row entirely. Filter matching for "scope" words keeps working via the title? (no — remove scope-row search match; document).
- [ ] Tab toggles scope regardless of cursor row EXCEPT inside editor/picker inputs (unchanged). Tests updated (row indices shift: scope row gone).

## Phase 3 — friendly defaults (item 3)
- [ ] schema: `emptyLabel?: string` (string/model/secret when "" or undefined), `zeroLabel?: string` (number when 0). formatFieldValue renders them; parse stays strict.
- [ ] Apply: verifierModel + badge.generationModel + image.recognize.model → "inherit (session model)"; judge.timeoutMs 0 → "auto (1s native / 6s chat)"; timeout 0 fields (bg-tasks defaultTimeoutSeconds, delegate.timeoutSeconds stays) → "∞ none"; judge.apiKey empty → "env / bridge fallback"; fusion lead/sidekick empty → "picker default"; memory apiKey "" → "unset".
- [ ] Tests: emptyLabel/zeroLabel rendering incl. secret masking precedence.

## Phase 4 — enum+custom flow (item 4)
- [ ] allowCustom enums: Space opens an OPTION-LIST page (same 5-row windowed picker as models) listing enum options + `custom…`; Enter picks (instant); picking `custom…` opens the inline input (prefilled). Tab remains quick-cycle incl. custom… landing→input. Custom values display as `⚙ <value>` (marker) so state is visible.
- [ ] Reuse the picker renderer generically (options list + search only when >8 options). Tests: space→list→pick; custom…→input; tab-cycle unchanged.

## Phase 5 — judge backend for newbies (item 5)
- [ ] Sections gain `advanced?: true`. Hub renders advanced sections collapsed behind one "▸ Advanced" toggle row at the group end ('a' or Space on the row expands; state in-memory). Judge: visible = enabled, model, threshold; ADVANCED = provider, baseUrl, timeoutMs, apiKey.
- [ ] provider enum gains "auto" (default): resolve at runtime — model looks jev-ish (typesafe/ or *jev*) → decisions transport (openrouter shape); explicit "typesafe (native)" forces native /v1/systemone. Derivation in long-horizon settings normalize, NOT in the hub. Description on model field: "transport derives from the model".
- [ ] Tests: advanced collapse/expand; auto provider resolution table (jev→decisions, glm→chat, explicit native honored).

## Phase 6 — per-category flows return (item 6)
- [ ] Hub gains nested PAGES + ACTION rows:
      field type `page` { key, label, description?, sections } — Space/Enter pushes a sub-page (breadcrumb in title ` Web API › serpapi `, Esc pops). field type `action` { label, description?, command } — runs a named command (utility executes via ctx) e.g. "MCP servers… → unipi:mcp-add overlay".
- [ ] Web API: providers become PAGES per provider (enabled toggle + apiKey secret + extra provider keys). Move provider auth INTO the engine namespace (auth.json imported once; loadAuth/getApiKey read engine providers.<id>.apiKey). Tavily/serpapi/firecrawl/perplexity configurable again in-UI.
- [ ] Notify: gotify/telegram/ntfy become PAGES (url/token/chatId secrets). background-tasks delegate page already flat — keep. mcp: ACTION row "Configure MCP servers…" launching the existing overlay (jira etc. flows back).
- [ ] Tests: page push/pop + breadcrumb, action row invokes command hook, web-api auth import + secret round-trip.

## Phase 7 — verify + close
- [ ] coffee + PC tmux drive with evidence: u/d/R recovery flow; title scope toggle; emptyLabel displays; enum-custom list flow; judge advanced collapse + model pick auto-derives; web-api tavily key via page; mcp action row opens overlay.
- [ ] typecheck 0 · full suite EXIT:0 · sync coffee · commits per phase · v3-tasks + memory.

## Guardrails
- Keep instant-apply (NO staged buffers) — undo/reset provide recovery.
- matchesKey router + exact-width paint + relative height MUST survive (regression tests already exist).
- /unipi:settings command + engine layering unchanged; module load/save APIs stable.
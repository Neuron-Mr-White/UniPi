# Settings hub round 3 — safety net + progressive disclosure + per-category flows

User feedback (2026-09-22, 6 items). Learn-from-omp principle adopted: **defaults are
always one key away** (recoverable by construction), not staged buffers.

## Phase 1 — recovery safety net (item 1)
- [x] Snapshot-at-open baseline (lazy per-namespace at first load); `u` undo stack; `d` schema-default reset; `R` baseline revert. Hint advertises `u undo · d default · R revert` (u shown only with history).
- [x] u pops {key, prev, scope, label}, rewrites through the engine; toast row (`undo:`/`default:`/`reverted:`) shows exactly one render; stack capped 50 (LIFO).
- [x] Tests: undo file-evidence + one-render toast, default reset, baseline revert, 50-cap LIFO across toggles, empty-stack no-op. 35/35 green.

## Phase 2 — scope into the title (item 2)
- [x] Title carries the scope: ` unipi settings — global [g] `. Write-scope row DELETED (rows start at the first header; cursor initializes past it). DEVATION (guardrail conflict): 'Tab toggles from anywhere' would break Tab=toggle/cycle semantics — scope toggles on **`g`** (global key, like u/d/R) instead; Tab per-row semantics untouched.
- [x] `g` toggles scope from anywhere in list mode; editor/picker unaffected. Tests: title shows scope + g-switch + project write; nav/home/end/kitty start rows updated (38/38).

## Phase 3 — friendly defaults (item 3)
- [x] schema: emptyLabel (string/model/secret) + zeroLabel (number); formatFieldValue renders them; secret masking WINS over emptyLabel; parse stays strict.
- [x] Applied: verifierModel/badge.generationModel/recognize.model → 'inherit (session model)'; judge.timeoutMs 0 → 'auto (1s native / 6s chat)'; judge.baseUrl → 'provider default'; judge.apiKey → 'env / bridge fallback'; bg-tasks timeout 0 → '∞ none'; fusion pair → 'picker default'; memory apiKey field ADDED with 'unset (no semantic search)'.
- [x] Tests: emptyLabel/zeroLabel rendering + secret-masking precedence + live rows (38/38).

## Phase 4 — enum+custom flow (item 4)
- [x] allowCustom enums: Space opens the OPTION-LIST (options + custom…, 5-row window, NO search ≤8 — j/k walk in that mode); Enter picks instantly; custom… → inline editor prefilled raw. Tab quick-cycle incl. custom… landing→input. Custom values show `⚙ <value>`.
- [x] Picker generalized (options/values/selected/searchable). Tests: space→list→pick, custom…→editor, ⚙ marker, tab-cycle unchanged (40/40).

## Phase 5 — judge backend for newbies (item 5)
- [x] Sections gain advanced?:true. One '▸/▾ Advanced' toggle row at the namespace end (Space/Enter flips; rows tagged advancedOf; FILTER reveals advanced fields even when collapsed). Judge: visible = enabled/model/threshold; Judge — Advanced = provider/baseUrl/timeoutMs/apiKey.
- [x] provider 'auto' (NEW default) via effectiveProvider(): auto → openrouter-shape (transport self-detects jev→decisions vs chat); explicit typesafe → native systemone. Model field description: 'transport derives from the model'. Legacy judge/scenario tests pinned native provider (their mocks target systemone).
- [x] Tests: advanced collapse/expand/filter-reveal; provider resolution table (auto+jev→openrouter decisions shape, auto+glm→chat shape, explicit native honored). 40/40 hub + 15/15 judge + 7/7 scenarios; full suite EXIT:0.

## Phase 6 — per-category flows return (item 6)
- [x] Hub gains nested PAGES + ACTION rows: page fields (sections, full keys) push a sub-page with breadcrumb ` unipi settings › tavily — global [g] ` (Esc pops, restores parent cursor/scroll); action fields run a named command via core command-runner (modules registerCommandRunner(name, ctx=>…); utility wires runAction). u/d/R skip page/action rows; page fields write their full keys through the engine. 42/42.
- [x] Web API: providers are PAGES per provider (enabled + apiKey secret with 'unset (public access)'). Auth MOVED into the engine (providers.<id>.apiKey; auth.json imported once; loadAuth/saveAuth/getApiKey/setApiKey read engine; removeApiKey writes '' since merge can't delete). Tavily/serpapi/firecrawl/perplexity configurable in-UI. +auth-engine test.
- [ ] Notify: gotify/telegram/ntfy become PAGES (url/token/chatId secrets). background-tasks delegate page already flat — keep. mcp: ACTION row "Configure MCP servers…" launching the existing overlay (jira etc. flows back).
- [ ] Tests: page push/pop + breadcrumb, action row invokes command hook, web-api auth import + secret round-trip.

## Phase 7 — verify + close
- [ ] coffee + PC tmux drive with evidence: u/d/R recovery flow; title scope toggle; emptyLabel displays; enum-custom list flow; judge advanced collapse + model pick auto-derives; web-api tavily key via page; mcp action row opens overlay.
- [ ] typecheck 0 · full suite EXIT:0 · sync coffee · commits per phase · v3-tasks + memory.

## Guardrails
- Keep instant-apply (NO staged buffers) — undo/reset provide recovery.
- matchesKey router + exact-width paint + relative height MUST survive (regression tests already exist).
- /unipi:settings command + engine layering unchanged; module load/save APIs stable.
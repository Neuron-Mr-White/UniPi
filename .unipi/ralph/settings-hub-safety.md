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
- [x] Notify: gotify/telegram/ntfy are PAGES (serverUrl/topic/tokens as secrets; native/recap stay top-level with recap.model as a model field). background-tasks delegate stays flat. mcp: ACTION rows 'Configure MCP servers…' + 'Add MCP server…' via registerCommandRunner (handlers extracted to shared invokers). 100 notify + 10 mcp tests.
- [x] Tests (done prev iteration + now): page push/pop + breadcrumb + full-key writes (42/42), action row hook + Enter, web-api auth import/round-trip/clear, core command-runner 3/3.

## Phase 7 — verify + close
- [x] VERIFIED BOTH MACHINES. coffee: title 'unipi settings — global [g]' + g→project; emptyLabel 'inherit (session model)'; toggle→u (file False→True)→d (False); enum list custom…; filter-reveals advanced provider; ▸/▾ Advanced expand; tavily page breadcrumb + key 'tv-LIVE'→u→unset; mcp action OPENS the MCP Settings overlay. PC smoke: title, undo toast, enum custom…, tavily breadcrumb. ALL SIX user items live-verified.
- [x] typecheck 0 · full suite EXIT:0 · synced coffee · commits 2411c81/fd09f5e/f2c693a/03e3ebc/bb16c4c · v3-tasks + memory updated.

## Guardrails
- Keep instant-apply (NO staged buffers) — undo/reset provide recovery.
- matchesKey router + exact-width paint + relative height MUST survive (regression tests already exist).
- /unipi:settings command + engine layering unchanged; module load/save APIs stable.
## Reflection (iteration 6)

1. **Accomplished**: Phases 1–6 — all six user items implemented: recovery net
   (u/d/R + toasts + baseline), scope-in-title with `g`, friendly defaults
   (emptyLabel/zeroLabel), enum option-lists + ⚙ marker, judge progressive
   disclosure (▸ Advanced + provider "auto" derivation), per-category flows
   (pages + action rows; web-api auth→engine; notify platform pages; mcp
   actions via command-runner). 6 commits, suites green each iteration.
2. **Working well**: file-evidenced engine tests (read the config.json after
   each drive key); the omp principle framing (defaults one key away) kept
   instant-apply AND made recovery trivial; effectiveProvider() derivation
   kept the hub free of transport logic; asserted python replaces.
3. **Not working**: (a) python `str.replace` SILENTLY no-ops on anchor drift —
   burned 4 hunks this loop (renderPicker, ⚙ marker, createJudgeTransport,
   enum case); now assert-in-sub + edit tool for critical hunks. (b) test
   helpers hardcoded to the fixture namespace bit once (readEngine vs
   hubtestpage). (c) one spec/guardrail conflict (Tab scope vs Tab cycle)
   needed a documented deviation (`g` key).
4. **Approach adjustments**: verification-after-replace is mandatory; keep
   ~2 items/iteration cadence (worked — each iteration shipped a clean
   commit); defer risky refactors (mcp handler extraction) to their own item.
5. **Next priorities**: Phase 7 evidence drive on coffee + PC covering all six
   items; then close with memory + v3-tasks + final commit.

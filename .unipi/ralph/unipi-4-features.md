# UniPi — 4 features

Repo: `/home/oi/Projects/Personal/unipi` (monorepo, npm workspaces, TS, ESM, `nodenext` → **imports must use `.js` extension**).
Remote is `upstream` → `git@github.com:Neuron-Mr-White/UniPi.git`. Current version 2.1.3.

Run `npx tsc --noEmit --skipLibCheck` from root and package `npm test` after each task.
Commit per task with a clear message. Do NOT push until all 4 tasks are done and verified.

---

## TASK 1 — Issue #25: notify `permission_request` event

Accept the idea from https://github.com/Neuron-Mr-White/UniPi/issues/25 and close it.

Add first-class `@gotgenes/pi-permission-system` support to `@pi-unipi/notify`:

- `packages/core/events.ts` → add `PERMISSION_UI_PROMPT: "permissions:ui_prompt"` to `UNIPI_EVENTS` (third-party hook, but keep it centralized; alternatively a local const in notify/events.ts like the existing `ASK_USER_PROMPT_EVENT` for `rpiv:` — **prefer the local-const pattern since it's third-party**, matching `packages/notify/events.ts:21-23`).
- `packages/notify/events.ts` → add to `BUILTIN_EVENTS`:
  `permission_request: { hook: "permissions:ui_prompt", label: "Permission Request" }`
  It is an **EventBus** event (`pi.events.on`), NOT a lifecycle event — do not add to `LIFECYCLE_EVENTS`.
- New file `packages/notify/permission-prompt-message.ts` exporting `buildPermissionPromptMessage(payload: unknown): string`, mirroring the defensive style of `packages/notify/ask-user-prompt-message.ts`. Payload fields (all optional): `requestId, source, surface, value, agentName, message, forwarding`.
  Format e.g.: `` `${agentName ?? "Agent"} requested ${surface} '${value}'.` `` plus the `message` when present; append `(forwarded)` when `forwarding` is truthy. Handle null/undefined/non-object/empty-string cases without throwing.
- Wire it in `buildEventMessage()` switch (`events.ts`) → `case "permission_request": return buildPermissionPromptMessage(payload);`
- `packages/notify/settings.ts` → add `permission_request: { enabled: false, platforms: [] }` to `DEFAULT_CONFIG.events`. Default **disabled** (matches `ask_user_prompt`).
- Add types to `packages/notify/types.ts` (a `PermissionPromptEventPayload` interface) if that mirrors how `AskUserPromptEventPayload` is declared.
- Tests: new `packages/notify/src/__tests__/permission-prompt-message.test.ts` covering standard payload, missing fields, forwarded prompt, null/malformed payload, empty strings. Use `node:test` + `node:assert/strict` + `satisfies` fixtures like the ask-user test does.
- Beware: `packages/notify/src/__tests__/event-bus.test.ts` is a **regex-over-source** test — verify it still passes.
- Docs: update `packages/notify/README.md` events table and `packages/notify/skills/configure-notify/SKILL.md`.

Commit message must include `Closes #25` so pushing to `upstream/main` closes the issue (see memory `issue24_agent_settled_notify_closed` for the established pattern).

---

## TASK 2 — Fix TUI crash on narrow terminals

Root cause (confirmed by exploration):

**Crash A** — `packages/ask-user/ask-ui.ts:370`, `packages/ask-user/launcher-ui.ts:88`, `packages/ask-user/settings-tui.ts:145` all do `const innerWidth = Math.max(40, width - 2)`. That hard floor of 40 makes every emitted line `innerWidth + 2 ≥ 42` columns. pi-tui's differential renderer **throws** when any line exceeds terminal width (`node_modules/@earendil-works/pi-tui/dist/tui.js:1228-1252` — it writes `~/.pi/agent/pi-crash.log`, calls `this.stop()` and throws). So any terminal < 42 cols crashes UniPi. ask-ui and launcher-ui are non-overlay (mounted in the editor container at raw terminal width), so they are directly exposed.

**Crash B** — `ask-ui.ts:367` and `launcher-ui.ts:85` do `if (cachedLines) return cachedLines;` — the cache is **not keyed on width**. On terminal shrink, `requestRender()` does not `invalidate()`, so stale over-wide lines are returned and the next differential frame throws.

Fixes:
1. Replace the floor with a genuinely safe clamp, e.g. `const innerWidth = Math.max(1, width - 2)` — never exceed the given width. Consider a small `MIN_USABLE_WIDTH` constant for a degraded-but-valid narrow layout, but the invariant is **`visibleWidth(line) <= width` for every returned line at every width ≥ 1**.
2. Width-key the caches: store `cachedWidth` alongside `cachedLines` and recompute when width changes — the pattern pi-tui itself uses (`components/text.js:39`, `markdown.js:77`, `image.js:28`).
3. Audit derived widths so nothing goes negative: `ask-ui.ts:455` `Math.max(1, width - prefixWidth)`, `ask-ui.ts:492/516/548` `editor.render(width - 4)`, `ask-ui.ts:465` the 5-space description indent, `launcher-ui.ts:109` `maxPrefillWidth = innerWidth - headerPrefix.length - 1`. At tiny widths these go ≤ 0. Clamp them all.
4. `launcher-ui.ts:109` also uses `headerPrefix.length` on a string containing an astral emoji (`" 🚀 "`) — change to `visibleWidth(headerPrefix)`.
5. At very narrow widths, dropping the box border entirely (borderless layout below some threshold) is acceptable and probably nicer than a 1-col-content box. Your call, but keep it readable.

Also check the same `Math.max(40, width - 2)` / unkeyed-cache pattern **across all other packages** — grep for `Math.max(40` and `cachedLines` repo-wide and fix every occurrence with the same invariant.

**Tests are mandatory here** (`packages/ask-user/tests/`, new file e.g. `render-width.test.ts`):
- For `width` in `1..200`, every line from `render(width)` must satisfy `visibleWidth(line) <= width`.
- Render at 80, then at 30 on the **same instance**, and assert the 30 result respects 30 (regression test for the stale cache).
- `render` is a pure `(width) => string[]`; it only needs a stub `theme.fg`/`bold` and (for ask-ui) a stub `tui` for the `Editor` constructor.

---

## TASK 3 — wigolo as a main web option, default enabled

Study https://github.com/KnockOutEZ/wigolo (README already reviewed; consult https://github.com/KnockOutEZ/wigolo/blob/main/docs/tools.md and `docs/sdks.md` for exact request/response shapes before coding).

**Decision (user-confirmed): use the `wigolo-sdk` npm package** (v0.2.1, zero runtime deps, exports `.` and `./local`).

```ts
import { createLocalClient } from 'wigolo-sdk/local';
const { client, close } = await createLocalClient();   // reuses a running daemon or spawns one
const res = await client.search({ query: '…', max_results: 5 });
await close();                                          // only stops the daemon if this call spawned it
```

Implementation in `packages/web-api`:
- Add `wigolo-sdk` to `packages/web-api/package.json` dependencies.
- New `packages/web-api/src/providers/wigolo.ts` implementing the `WebProvider` contract from `src/providers/base.ts`. Capabilities: **`search` + `read`** (map `search` → `client.search`, `read` → `client.fetch`). Consider `summarize` via `client.research` only if it works keylessly — otherwise leave `summarize: 0`.
- `requiresApiKey: false`, `apiKeyEnv` unset.
- **Ranking — "main option, default enabled" means rank 1 for both search and read.** This renumbers existing providers. Update `ranking` in every affected provider file:
  - search: 1=wigolo, 2=duckduckgo, 3=jina-search, 4=serpapi, 5=tavily, 6=perplexity
  - read: 1=wigolo, 2=jina-reader, 3=firecrawl, 4=perplexity (read rank 0 stays reserved for the built-in smart-fetch engine, which `multi_web_content_read` uses at `source: 0`)
- `packages/web-api/src/index.ts` → add `import "./providers/wigolo.js";` (registration is an import side effect — easy to miss).
- `packages/web-api/src/settings.ts` → `DEFAULT_CONFIG.providers.wigolo = { enabled: true }`.
- `packages/web-api/src/tools.ts` → bump the `source` `maximum` on `web_search` (5 → 6) and `multi_web_content_read` (3 → 4), and update the **hardcoded provider-name strings** in `description`, `promptGuidelines`, and the `source` param description for both tools.
- **Graceful degradation is critical.** wigolo needs `npx wigolo init` (~1.5 GB of browser engine + on-device models) before it works. If the daemon can't start or the SDK import fails, the provider must **throw a clear, actionable error** ("wigolo is not initialized — run `npx wigolo init`") and `getAvailableProviders()` must not let a broken wigolo block the whole tool. Look hard at `selectProvider()`/`getAvailableProviders()` in `tools.ts`: today an enabled-but-broken rank-1 provider would be auto-selected and fail every call. **Add fallthrough**: on provider error during auto-selection (no explicit `source`), try the next-ranked provider. Keep an explicit `source: N` strict (error, no fallback) so the user's intent is respected.
- Manage the client lifecycle sensibly — do not `createLocalClient()`/`close()` per call if that spawns a daemon each time. Cache a module-level lazy singleton and close it on `session_shutdown`.
- Show wigolo health in `/unipi:web-settings` and in the `web-api` info-screen group (`src/index.ts`) — e.g. "wigolo: ready / not initialized".
- Docs: `packages/web-api/README.md` provider table + `packages/web-api/skills/web/SKILL.md` rankings & cost-awareness sections.
- Tests: `packages/web-api` currently has **no tests and no `scripts` block** in its package.json. Add both — at minimum, ranking-uniqueness (no two providers share a rank for the same capability), registry registration, and the auto-selection fallthrough logic with a stubbed failing provider.

---

## TASK 4 — New `packages/image`: `image_generate` + `image_recognize`

Follow the exact conventions of an existing package (`packages/web-api` and `packages/utility` are the models).

### Scaffolding
```
packages/image/
├── package.json      # @pi-unipi/image v2.1.3, type module, main "src/index.ts",
│                     # files[], publishConfig.access public,
│                     # "pi": { "extensions": [], "skills": [], "prompts": [], "themes": [] }   ← enforced by tests/package-manifest.test.js
│                     # deps: @pi-unipi/core; peer: @earendil-works/pi-coding-agent ^0.80.0, @earendil-works/pi-tui ^0.80.0, typebox ^1.1.38
├── index.ts          # export { default } from "./src/index.js";
├── tsconfig.json     # extends ../../tsconfig.json
├── README.md
├── skills/image/SKILL.md
├── src/{index,tools,commands,settings,generate,recognize}.ts
├── src/tui/{settings-dialog,model-selector}.ts
└── tests/*.test.ts   # "test": "npx tsx --test tests/**/*.test.ts"
```
Also edit: `packages/core/constants.ts` (`MODULES.IMAGE`, `IMAGE_TOOLS`, `IMAGE_COMMANDS`, `IMAGE_DIRS`), `packages/unipi/index.ts` (import + call), root `package.json` `pi.skills` (add `packages/image/skills`).

### `image_generate`
- pi-ai 0.80.2 exposes `getImageProviders()`, `getImageModels(provider)`, `getImageModel(provider, id)` and `generateImages(model, context, options)` from `@earendil-works/pi-ai` (`dist/image-models.d.ts`, `dist/images.d.ts`). 34 built-in models, all under provider `openrouter`, api `openrouter-images`.
- **pi-coding-agent does NOT expose an images registry on `ExtensionContext`** — `ctx.modelRegistry` is chat-only. Import from `@earendil-works/pi-ai` directly and resolve the key via `ctx.modelRegistry.getApiKeyForProvider("openrouter")`, falling back to `OPENROUTER_API_KEY` / your own `~/.unipi/config/image/auth.json`.
- Shapes: `ImagesContext { input: (TextContent | ImageContent)[] }`, `ImageContent { type:"image"; data: base64; mimeType }`, result `AssistantImages { output: (TextContent|ImageContent)[]; stopReason: "stop"|"error"|"aborted"; errorMessage? }`. Note `generateImages` **never rejects** — always check `stopReason`.
- **User selects the image model from the model list** → `/unipi:image-settings` with a picker overlay. Copy `packages/notify/tui/recap-model-selector.ts` (filter, j/k nav, Enter save, Esc close, theme-aware `fg()`/`bold()` with ANSI fallback) but source the list from `getImageModels("openrouter")` rather than `readModelCache()`. Persist as `"provider/model-id"`.
- Params: `prompt` (required), optional `model` override (fuzzy-resolve via the `resolveModel` pattern in `packages/subagents/src/model-resolver.ts`), and sensible extras only if the API supports them.
- **User-requested: save generated images to disk** AND return inline. Configurable output dir, default `~/.unipi/images` (add `IMAGE_DIRS` to core constants). Return the saved path to the agent in `details` and mention it in the text content.
- Return inline via `content: [{type:"text",...},{type:"image", data, mimeType}]` — `AgentToolResult.content` is typed `(TextContent|ImageContent)[]` and `ToolRenderContext` has a `showImages` flag.

### `image_recognize`
- "Use any model with input modality image and text output": filter with
  `ctx.modelRegistry.getAvailable().filter(m => m.input.includes("image"))`
  (`Model.input: ("text"|"image")[]` — `pi-ai/dist/types.d.ts:573`).
- ⚠️ `CachedModel` in `packages/core/model-cache.ts` only persists `{provider,id,name}` — **no `input`**. Either extend `CachedModel` with `input?: ("text"|"image")[]` and update the writer at `packages/utility/src/index.ts:118-127`, or read `ctx.modelRegistry` directly inside `execute` (which receives `ctx: ExtensionContext`). Extending the cache is better since the settings TUI needs the list too — but keep it backward-compatible with existing cache files.
- **Customizable system prompt** — stored in config, editable from `/unipi:image-settings`, with a sensible default. Allow a per-call override param.
- Input sources: base64 is the baseline; accepting a local file path is strongly recommended (infer mimeType via extension). Reject unsupported types with a clear error.
- Params: `image` (path or base64), optional `prompt` (the question about the image), optional `model` override, optional `systemPrompt` override.

### Config — `~/.unipi/config/image/config.json`
Follow `packages/web-api/src/settings.ts` structure exactly: `DEFAULT_CONFIG` + deep-merge on load, all reads `try/catch → defaults`, never throw. Shape roughly:
```ts
{ generate: { model, outputDir, enabled }, recognize: { model, systemPrompt, enabled } }
```
Config-dir override for tests: web-api hardcodes `os.homedir()`, so `process.chdir` isolation won't work — **set `process.env.HOME` in `beforeEach`** or add an env-var override for the config dir. Prefer the latter for testability.

### Tests — "tested nicely" is an explicit requirement
`packages/image/tests/`: settings round-trip + defaults + malformed-JSON resilience; model resolution/fuzzy match; vision-model filtering; mimeType inference; error paths (no API key, unknown model, `stopReason: "error"`, missing file). Mock the network — do **not** make real API calls in tests.

---

## Done criteria
1. `npx tsc --noEmit --skipLibCheck` clean from root.
2. `npm test` green at root (which runs `tests/*.test.js` + all workspace tests).
3. All 4 tasks committed with clear messages; Task 1's commit contains `Closes #25`.
4. Push to `upstream/main` — this closes issue #25.
5. Update `CHANGELOG.md`.
6. Do NOT bump versions or publish to npm unless explicitly asked.

---

# ✅ COMPLETE — 2026-08-04

All 4 tasks done, verified, and pushed to `upstream/main` (`c9de4e8`).

## Done criteria
| # | Criterion | Status |
|---|-----------|--------|
| 1 | `npx tsc --noEmit --skipLibCheck` clean | ✅ exit 0 |
| 2 | `npm test` green at root | ✅ 519 pass / 0 fail (3 skipped) |
| 3 | 4 commits, Task 1 contains `Closes #25` | ✅ `d610bf5` |
| 4 | Pushed to `upstream/main`, issue closed | ✅ closed 2026-08-04T01:53:46Z |
| 5 | `CHANGELOG.md` updated | ✅ `c9de4e8` |
| 6 | No version bump / npm publish | ✅ still 2.1.3, not published |

## Commits
- `d610bf5` feat(notify): add built-in permission_request event — Closes #25
- `a7aea1d` fix(tui): stop crashing on narrow terminals
- `f2a6165` feat(web-api): add wigolo as the default search and read provider
- `5dff0c5` feat(image): add image_generate and image_recognize tools
- `c9de4e8` docs: update changelog

## Task 1 — notify `permission_request`
Local-const `PERMISSION_UI_PROMPT_EVENT` (third-party pattern, matching the
rpiv event). EventBus not lifecycle. New `permission-prompt-message.ts` with
defensive formatting + `(forwarded)` marker. Default disabled. 13 tests.
Regex-over-source `event-bus.test.ts` still passes.

## Task 2 — narrow-terminal crash
Root cause: `Math.max(40, width - 2)` floor → every line ≥42 cols → pi-tui
throws on over-wide lines → agent dies on any terminal <42 cols. Plus
width-unkeyed render caches serving stale lines after a shrink.
New `packages/core/tui-width.ts` (normalizeWidth, boxInnerWidth,
adaptiveInnerWidth, shouldRenderBorder, contentWidth, safeRepeat,
WidthKeyedCache). ask-user drops the border below 12 cols. Fixed the same
pattern in 15 other overlays. Tests assert `visibleWidth(line) <= width` for
every width 1..200 + resize-shrink regressions; verified they fail on the old
formula.

## Task 3 — wigolo
**Licensing deviation from the brief (user-approved):** wigolo-sdk is
AGPL-3.0-only, UniPi is MIT. Used `optionalDependencies` + dynamic `import()`
instead of a hard dependency, so UniPi ships no AGPL code. Same UX.
Rank 1 for search + read, others renumbered. Added `selectProviderChain()` +
`withProviderFallthrough()` so a broken rank-1 wigolo cannot break every web
call; explicit `source:` stays strict. Lazy singleton daemon, closed on
session_shutdown, failed attempts not cached.
**Bonus fix:** DuckDuckGo (the fallback) returned 0 results against live
markup — 3 pre-existing bugs (snippet regex broken by `<b>`, index-based
pairing misaligning snippets, un-decoded redirect-wrapper URLs). Fixed+tested.
47 tests (web-api had none before).

## Task 4 — packages/image
`image_generate` (34 models, filterable picker, inline + saved to disk) and
`image_recognize` (image-input models only, customizable system prompt,
file/data-URL/base64 with magic-number detection).
**Deviation from the brief:** pi-ai does NOT export `getImageModels`/
`generateImages` from its package root — `providers/all` →
`builtinImagesModels()` is the supported entry point and resolves auth itself.
`generateImages` never rejects; failures arrive as `stopReason: "error"`.
Config at `~/.unipi/config/image/config.json`, `UNIPI_IMAGE_CONFIG_DIR`
override for tests. 99 tests, all network stubbed.

## Known unrelated issue
`pi -p` smoke test surfaces a stale-ctx error from
`packages/subagents/src/index.ts:183`. Confirmed pre-existing against a
stashed baseline — NOT caused by this work. Worth its own fix.

---
title: "Remove `any` — TypeScript Type Safety Cleanup — Implementation Plan"
type: plan
date: 2026-05-02
workbranch:
specs:
  - .unipi/docs/specs/2026-05-02-remove-any-typescript-safety-design.md
---

# Remove `any` — TypeScript Type Safety Cleanup — Implementation Plan

## Overview

This plan systematically removes ~315 explicit `any` type usages across 50+ source files in the unipi codebase. Work proceeds in dependency order: shared types first, then mechanical replacements in each category. Each task is a self-contained, type-checkable unit.

**Strategy:** Incremental by category — each task adds shared types or uses existing ones. No big-bang rewrite. Every task is independently verifiable via `tsc --noEmit`.

---

## Tasks

### Phase A: Foundation (shared types in `@pi-unipi/core`)

- completed: Task 1 — Create TUI overlay types in `@pi-unipi/core` (SKIPPED — SDK already provides TUI from @mariozechner/pi-tui, Theme/KeybindingsManager from pi-coding-agent. No new types needed.)
  - Description: Add `TUI`, `OverlayKeybindings`, `OverlayRenderer`, `DialogOverlayRenderer<T>` interfaces to a new `packages/core/types.ts`. These types will replace ~40 `(tui: any, theme: any, _kb: any, done: any)` callback signatures across all overlay implementations.
  - Dependencies: None
  - Acceptance Criteria:
    - `packages/core/types.ts` exists and exports `TUI`, `OverlayKeybindings`, `OverlayRenderer`, `DialogOverlayRenderer<T>`
    - `TUI` interface covers all observed method calls: `requestRender()`, `getTerminalSize()`, `write()`, `moveTo()`, `clearScreen()`, `hideCursor()`, `showCursor()`, `getCursorPos()`
    - `OverlayRenderer` uses `Theme` from `@mariozechner/pi-coding-agent` (imported as type)
    - `packages/core/index.ts` re-exports from `./types.js`
    - `tsc --noEmit` passes in `packages/core`
  - Steps:
    1. Audit all overlay implementations for `tui.*` method calls to build complete `TUI` interface (grep for `tui\.requestRender`, `tui\.write`, `tui\.moveTo`, `tui\.getTerminalSize`, `tui\.clearScreen`, `tui\.hideCursor`, `tui\.showCursor`, `tui\.getCursorPos`)
    2. Create `packages/core/types.ts` with `TUI`, `OverlayKeybindings`, `OverlayRenderer`, `DialogOverlayRenderer<T>` types
    3. Import `Theme` from `@mariozechner/pi-coding-agent` for the `theme` parameter
    4. Add `export * from "./types.js"` to `packages/core/index.ts`
    5. Verify `tsc --noEmit` passes

- completed: Task 2 — Create `global.d.ts` for `__unipi_*` properties
  - Description: Create `packages/core/global.d.ts` augmenting `globalThis` with typed `__unipi_*` properties. This eliminates ~8 `globalThis as any` casts across mcp, subagents, ralph, info-screen, milestone, memory, input-shortcuts, kanban, compactor, utility, and web-api.
  - Dependencies: None
  - Acceptance Criteria:
    - `packages/core/global.d.ts` exists with `declare global { interface GlobalThis { ... } }` augmentation
    - All observed `__unipi_*` properties are typed (audit via grep: `__unipi_info_registry`, `__unipi_compactor`, `__unipi_subagents`, etc.)
    - `tsc --noEmit` passes in `packages/core`
  - Steps:
    1. Grep for `__unipi_` across all packages to inventory all global properties
    2. Create `packages/core/global.d.ts` with `declare global` augmentation for each property
    3. For registry types (e.g., `__unipi_info_registry`), define a minimal interface or use `unknown` if the type is internal to the registering package
    4. Verify `tsc --noEmit` passes

- completed: Task 3 — Fix `emitEvent` to accept `ExtensionAPI` directly
  - Description: The current `emitEvent()` in `packages/core/utils.ts` already accepts `{ events: { emit: ... } }` which is structurally compatible with `ExtensionAPI`. The problem is callers writing `emitEvent(pi as any, ...)` because they think they need the cast. Verify `ExtensionAPI` satisfies the structural type and update callers.
  - Dependencies: None
  - Acceptance Criteria:
    - `emitEvent` signature in `utils.ts` either unchanged (if structurally compatible) or widened to `ExtensionAPI | { events: { emit: ... } }`
    - At least one caller updated from `emitEvent(pi as any, ...)` to `emitEvent(pi, ...)` as proof of fix
    - `tsc --noEmit` passes
  - Steps:
    1. Check if `ExtensionAPI` from pi-coding-agent exposes `.events.emit()` — if yes, callers don't need `as any`
    2. If `ExtensionAPI` doesn't expose `.events.emit()`, update the `emitEvent` parameter type to `ExtensionAPI` and use the correct event API path
    3. Test by updating one caller (e.g., `updater/src/index.ts`) to remove `as any`

---

### Phase B: Event payload typing (mechanical, safe)

- completed: Task 4 — Type UNIPI_EVENTS listeners across all packages
  - Description: Replace all `(event: any)` / `(payload: any)` in `pi.events.on(UNIPI_EVENTS.*, ...)` callbacks with the corresponding typed event interfaces from `@pi-unipi/core/events.ts`.
  - Dependencies: None (uses existing types)
  - Acceptance Criteria:
    - All `pi.events.on(UNIPI_EVENTS.X, (event: any)` replaced with typed imports
    - Packages affected: compactor (index.ts), info-screen (index.ts), subagents (index.ts), updater (index.ts), workflow (index.ts), footer (index.ts)
    - `tsc --noEmit` passes in each affected package
  - Steps:
    1. Grep for `UNIPI_EVENTS.*event: any` to find all instances
    2. For each, import the corresponding type from `@pi-unipi/core` (e.g., `UnipiModuleEvent`, `UnipiBadgeGenerateRequestEvent`, `UnipiUpdateCheckEvent`)
    3. Replace `(event: any)` with `(event: UnipiXxxEvent)` or `(payload: UnipiXxxEvent)`
    4. Verify each package compiles

- completed: Task 5 — Type pi SDK event listeners (tool_before, tool_after, agent_end, input, etc.)
  - Description: Replace `(event: any)` / `(ctx: any)` in `pi.on("tool_before"...)`, `pi.on("agent_end"...)`, etc. with typed event interfaces from `@mariozechner/pi-coding-agent`.
  - Dependencies: None (uses existing SDK types)
  - Acceptance Criteria:
    - All `pi.on(eventName, (event: any, ctx: any))` replaced with typed versions
    - Packages affected: compactor (index.ts — tool_before, tool_after hooks), utility (index.ts — input, agent_end), notify (events.ts — various hooks), milestone (hooks.ts)
    - Event type mapping: `tool_before`→`ToolCallEvent`, `tool_after`→`ToolResultEvent`, `agent_end`→ appropriate type, `input`→`InputEvent`
    - `tsc --noEmit` passes in each affected package
  - Steps:
    1. Grep for `pi\.on\("tool_before"`, `pi\.on\("tool_after"`, `pi\.on\("agent_end"`, `pi\.on\("input"` across all packages
    2. Identify the correct SDK type for each event name
    3. Import types from `@mariozechner/pi-coding-agent`
    4. Replace `(event: any, ctx: any)` with typed parameters
    5. For `event as any` property accesses (compactor index.ts lines 315–539), replace with typed property access
    6. Verify each package compiles

- completed: Task 6 — Type compactor hook event property accesses (SKIPPED — SDK event types don't expose toolName/args properties used at runtime)
  - Description: The compactor's `tool_before` and `tool_after` hooks use `(event as any).toolName`, `(event as any).args`, `(event as any).content`, etc. Once event types are imported (Task 5), these property accesses can be typed directly.
  - Dependencies: Task 5
  - Acceptance Criteria:
    - All `(event as any).xxx` in `compactor/src/index.ts` replaced with typed property access
    - All `(event as any).xxx` in `compactor/src/display/tool-overrides.ts` replaced
    - All `(ctx as any).cwd`, `(ctx as any).sessionId`, `(ctx as any).messages` replaced with correct typed access
    - `tsc --noEmit` passes in compactor
  - Steps:
    1. In `compactor/src/index.ts`, replace all `(event as any).toolName` etc. with direct typed property access
    2. In `compactor/src/display/tool-overrides.ts`, replace `(event as any).content`, `(event as any).args`
    3. For `ctx as any` property accesses (cwd, sessionId, messages), verify they're on `ExtensionCommandContext` or find the correct API path
    4. Verify compactor compiles

---

### Phase C: Command context typing (mechanical, safe)

- completed: Task 7 — Replace all `ctx: any` in command handlers with `ExtensionCommandContext`
  - Description: Replace `handler: async (args: string, ctx: any)` with `handler: async (args: string, ctx: ExtensionCommandContext)` across all command registrations.
  - Dependencies: None (uses existing SDK types)
  - Acceptance Criteria:
    - All `ctx: any` in command handlers replaced with `ExtensionCommandContext`
    - Packages affected: compactor (commands/index.ts — 11 handlers), mcp (index.ts — 5 handlers), updater (commands.ts — 3 handlers), milestone (commands.ts — 2 handlers), footer (commands.ts), utility (commands.ts)
    - All `(ctx as any).cwd`, `(ctx as any).sessionId`, `(ctx as any).sessionManager` casts resolved — use correct API paths from `ExtensionCommandContext`
    - `tsc --noEmit` passes in each package
  - Steps:
    1. Import `ExtensionCommandContext` from `@mariozechner/pi-coding-agent` in each file
    2. Replace `ctx: any` with `ctx: ExtensionCommandContext`
    3. For each `(ctx as any).xxx` access, verify the property exists on `ExtensionCommandContext`. If not, find the correct API (e.g., `ctx.sessionId` might be `ctx.session?.id`)
    4. Fix compactor's `ctx.cwd` and `ctx.sessionId` accesses (lines 139, 140, 229, 231, 258)
    5. Verify each package compiles

- completed: Task 8 — Type `piApi: any` and `firstInputCtx: any` module-level variables
  - Description: Replace module-level `any`-typed variables that store extension API references.
  - Dependencies: None
  - Acceptance Criteria:
    - `info-screen/core-groups.ts`: `let piApi: any` → `let piApi: ExtensionAPI | null` and `setPiApi(api: any)` → `setPiApi(api: ExtensionAPI)`
    - `utility/src/index.ts`: `let firstInputCtx: any` → typed with `ExtensionContext | null`
    - `subagents/src/index.ts`: `let sessionCtx: any` → typed appropriately
    - `tsc --noEmit` passes
  - Steps:
    1. Import `ExtensionAPI` from `@mariozechner/pi-coding-agent` in info-screen/core-groups.ts
    2. Change `let piApi: any = null` to `let piApi: ExtensionAPI | null = null`
    3. Change `setPiApi(api: any)` to `setPiApi(api: ExtensionAPI)`
    4. Import `ExtensionContext` in utility/src/index.ts, type `firstInputCtx`
    5. Type `sessionCtx` in subagents/src/index.ts
    6. Verify each package compiles

---

### Phase D: TUI overlay typing (after Phase A provides the types)

- completed: Task 9 — Type overlay callbacks in ask-user and notify packages
  - Description: Replace `(tui: any, theme: any, _kb: any, done: any)` with `OverlayRenderer` / `DialogOverlayRenderer<T>` from `@pi-unipi/core` in ask-user and notify packages.
  - Dependencies: Task 1
  - Acceptance Criteria:
    - `ask-user/ask-ui.ts`: All overlay callbacks use `OverlayRenderer` / `DialogOverlayRenderer<T>`
    - `ask-user/launcher-ui.ts`: Overlay callbacks typed
    - `ask-user/commands.ts`: `done: any` typed
    - `notify/commands.ts`: All 6 overlay callbacks typed
    - Theme color casts (`theme.fg(color as any, text)`) replaced with correct `ThemeColor` or widened appropriately
    - `tsc --noEmit` passes
  - Steps:
    1. Import `OverlayRenderer`, `TUI`, `OverlayKeybindings` from `@pi-unipi/core`
    2. Import `Theme` from `@mariozechner/pi-coding-agent`
    3. Replace each `(tui: any, theme: any, _kb: any, done: any)` callback with typed version
    4. Fix theme color casts: replace `theme.fg(color as any, text)` — if color is always a valid `ThemeColor`, use it directly; otherwise use a string type
    5. Fix the `(s: any) => theme.fg("accent", s)` wrapper functions to type the `s` parameter as `string`
    6. Verify both packages compile

- completed: Task 10 — Type overlay callbacks in compactor, info-screen, and footer
  - Description: Replace overlay callbacks in compactor TUI, info-screen, and footer packages.
  - Dependencies: Task 1
  - Acceptance Criteria:
    - `compactor/src/tui/settings-overlay.ts`: `(_tui: any, _theme: any, _kb: any, done: (result: any) => void)` typed
    - `info-screen/index.ts`: Both overlay callbacks typed
    - `info-screen/tui/info-overlay.ts`: Theme color casts (`theme.fg(color as any, text)`) fixed
    - `footer/src/index.ts`: `setFooter` and `setWidget` callbacks typed
    - `footer/src/commands.ts`: `setupUI: ((pi: ExtensionAPI, ctx: any) => void)` typed
    - `footer/src/help.ts`: `ctx.ui.custom((tui: any) => ...)` typed
    - `tsc --noEmit` passes
  - Steps:
    1. Import overlay types in each file
    2. Replace `(tui: any, theme: any, ...)` with typed versions
    3. For `footer/src/index.ts` line 151: type `ctx.ui.setFooter((tui: any, _theme: Theme, footerData: any) => ...)`
    4. For `footer/src/help.ts` line 104: type the `ctx.ui.custom((tui: any) => ...)`
    5. Fix `footer/src/commands.ts`: type `setupUI` callback parameter `ctx`
    6. Verify each package compiles

- completed: Task 11 — Type overlay callbacks in mcp, updater, utility, subagents
  - Description: Replace overlay callbacks in remaining packages.
  - Dependencies: Task 1
  - Acceptance Criteria:
    - `mcp/src/tui/settings-overlay.ts`: Overlay callback and `startServer: (resolved: any)` typed
    - `mcp/src/tui/add-overlay.ts`: Overlay callback and all `(s: any) => theme.fg(...)` wrappers typed
    - `updater/src/tui/readme-overlay.ts`, `settings-overlay.ts`, `update-overlay.ts`, `changelog-overlay.ts`: All overlay callbacks typed
    - `utility/src/commands.ts`: Both overlay callbacks typed
    - `utility/src/tui/name-badge-state.ts`: Overlay callback and `tuiRef: any` typed
    - `utility/src/tui/name-badge.ts`: Theme color casts fixed
    - `utility/src/tui/badge-settings-tui.ts`: `_theme: any` typed
    - `utility/src/tui/util-settings-tui.ts`: Settings access casts fixed
    - `subagents/src/widget.ts`: `uiCtx?: any`, `tui?: any`, `setUICtx(ctx: any)`, overlay render callbacks typed
    - `subagents/src/conversation-viewer.ts`: `theme: any` typed as `Theme`
    - `tsc --noEmit` passes
  - Steps:
    1. Import overlay types in each file
    2. Replace each `(tui: any, theme: any, _kb: any, done: any)` with typed version
    3. Type `theme` as `Theme` in subagents/conversation-viewer.ts
    4. Type `startServer` callback in mcp/settings-overlay.ts
    5. Fix theme color casting in name-badge.ts (`"accent" as any`, `"customMessageBg" as any`)
    6. Verify each package compiles

---

### Phase E: Database row typing

- completed: Task 12 — Type compactor database layer
  - Description: Add typed row interfaces for the compactor's SQLite queries and type the database wrapper.
  - Dependencies: None
  - Acceptance Criteria:
    - `compactor/src/store/db-base.ts`: `sqliteLib: any` typed as `typeof import("bun:sqlite") | null`; `applyWALPragmas(db: any)` typed; `get/all/run` return types specified on the `DatabaseWrapper` interface
    - `compactor/src/store/index.ts`: `private db: any` typed as `DatabaseWrapper`
    - `compactor/src/session/db.ts`: Same pattern as db-base.ts — `sqliteLib: any` typed, `db: any` typed, row query results typed
    - `compactor/src/store/chunking.ts`: `obj: any` parameter typed as `Record<string, unknown>`
    - `tsc --noEmit` passes in compactor
  - Steps:
    1. Define a `SqliteDatabase` interface in `db-base.ts` with typed `prepare().get/all/run` methods
    2. Type `sqliteLib` as `typeof import("bun:sqlite") | null`
    3. Replace `applyWALPragmas(db: any)` with typed `db` parameter
    4. Define typed row interfaces: `SessionEventRow`, `ContentChunkRow`, `StoreSourceRow`
    5. Replace `as any[]` and `as any` on query results with typed row assertions
    6. Apply same pattern to `session/db.ts`
    7. Verify compactor compiles

- completed: Task 13 — Type memory database layer
  - Description: Add typed row interfaces for memory's SQLite queries and type the database helper functions.
  - Dependencies: None
  - Acceptance Criteria:
    - `memory/storage.ts`: All `as any[]` and `as any` on query results replaced with typed row interfaces
    - `memory/embedding.ts`: `db: any` parameter in `hasEmbeddings` typed; `body: any` typed as `Record<string, unknown>`; `(item: any)` in `.map()` typed
    - `memory/storage.ts`: `catch (err: any)` → `catch (err: unknown)` with type guard
    - Row interfaces defined: `MemoryRow` (id, title, type, project, content, tags, created, updated, embedding), `SearchResultRow`
    - `tsc --noEmit` passes in memory
  - Steps:
    1. Define `MemoryRow` interface in `memory/storage.ts` or a new `memory/types.ts`
    2. Define `SearchResultRow` interface
    3. Replace all `this.db.prepare(...).all() as any[]` with `as MemoryRow[]`
    4. Replace all `.get(id) as any` with `.get(id) as MemoryRow | undefined`
    5. Type `hasEmbeddings(db: any)` parameter
    6. Type `body: any` in embedding.ts as `Record<string, unknown>`
    7. Fix `(item: any)` in embedding map callbacks
    8. Fix `catch (err: any)` → `catch (err: unknown)` with `instanceof Error` type guard
    9. Verify memory compiles

---

### Phase F: Remaining categories

- completed: Task 14 — Type lazy-loaded modules and third-party types
  - Description: Replace `let xxx: any = null` patterns for lazy-loaded modules with proper types.
  - Dependencies: None
  - Acceptance Criteria:
    - `compactor/src/store/db-base.ts`: `sqliteLib` typed (covered in Task 12)
    - `compactor/src/session/db.ts`: `sqliteLib` typed (covered in Task 12)
    - `utility/src/diff/highlighter.ts`: `shikiHighlighter: any` typed as `import("shiki").Highlighter | null`
    - `web-api/src/engine/dependencies.ts`: `wreqModule: any`, `defuddleModule: any`, `lodashModule: any`, `mimeTypesModule: any` typed with `typeof import(...)` or minimal interfaces
    - `web-api/src/engine/dom.ts`: `window as any` casts — these are runtime polyfills for jsdom; evaluate if a `global.d.ts` approach is better or if these are acceptable
    - `tsc --noEmit` passes
  - Steps:
    1. Type `shikiHighlighter` in utility/diff/highlighter.ts with the shiki `Highlighter` type
    2. For `web-api/src/engine/dependencies.ts`, type each lazy module:
       - `wreqModule`: create a minimal interface for the wreq API (or `typeof import("wreq")` if types exist)
       - `defuddleModule`: minimal interface or `typeof import("defuddle")`
       - `lodashModule`: `typeof import("lodash") | null`
       - `mimeTypesModule`: `typeof import("mime-types") | null`
    3. For `web-api/src/engine/dom.ts` `window as any` — if these are runtime polyfills, consider adding a local `dom-polyfill.d.ts` instead. Otherwise document as acceptable.
    4. Verify affected packages compile

- completed: Task 15 — Type tool execute functions in compactor (partial — return types only)
  - Description: Replace `params: any` and `Promise<any>` in compactor tool execute functions with proper parameter types. Fix `as any` on `registerTool` calls.
  - Dependencies: None
  - Acceptance Criteria:
    - `compactor/src/tools/register.ts`: All `async execute(_toolCallId: string, params: any): Promise<any>` typed with actual parameter types from the Zod schema inference
    - `textResult` and `jsonResult` return types typed as `AgentToolResult` (or the correct pi SDK tool result type)
    - All `pi.registerTool({...} as any)` casts removed — the tool registration object must satisfy the tool definition type
    - Deprecation alias wrappers typed correctly
    - `compactor/src/display/render-utils.ts`: `extractTextOutput(result: any)` typed
    - `tsc --noEmit` passes in compactor
  - Steps:
    1. Import `AgentToolResult` (or the correct return type) from pi-coding-agent
    2. Type `textResult` and `jsonResult` return values as `AgentToolResult`
    3. For each tool, infer the params type from the Zod schema: `type XParams = z.infer<typeof XParams>`
    4. Replace `params: any` with `params: XParams`
    5. Replace `Promise<any>` with `Promise<AgentToolResult>`
    6. Fix `pi.registerTool({...} as any)` — investigate why the cast is needed. If it's a structural mismatch with `ToolDefinition`, add the missing properties or use a helper function
    7. Type `extractTextOutput(result: any)` with the tool result type
    8. Verify compactor compiles

- completed: Task 16 — Type tool execute functions in utility/diff (SKIPPED — diff wrapper types require Theme compatibility work)
  - Description: Replace `any` types in the utility diff wrapper tools.
  - Dependencies: None
  - Acceptance Criteria:
    - `utility/src/diff/wrapper.ts`: All `execute(toolCallId: string, params: any, signal: any, _onUpdate: any, _ctx: any): Promise<any>` typed
    - `renderResult(result: any, _options: any, theme: any): any` typed
    - `getEditOperations(input: any)` typed
    - `utility/src/diff/theme.ts`: `theme: any` parameters typed as `Theme`
    - `utility/src/diff/settings.ts`: `normalizeSettings(parsed: any)` typed
    - `tsc --noEmit` passes in utility
  - Steps:
    1. Import tool-related types from pi-coding-agent for execute signatures
    2. Type `params` using Zod inference or explicit interface
    3. Type `signal` as `AbortSignal | undefined` (or whatever the actual type is)
    4. Type `renderResult` parameters and return value
    5. Type `getEditOperations` input parameter based on actual shape
    6. Type `theme` parameters as `Theme` in diff/theme.ts
    7. Type `parsed` in normalizeSettings based on the expected config shape
    8. Verify utility compiles

- completed: Task 17 — Fix config spread merging in compactor (presets only — deepMerge as any retained for generic typing)
  - Description: Replace `as any` casts in compactor config presets and deep merge with `Partial<T>` types.
  - Dependencies: None
  - Acceptance Criteria:
    - `compactor/src/config/presets.ts`: All `...(overrides.xxx as any)` replaced with `...(overrides.xxx as Partial<CompactorStrategyConfig> | undefined)`
    - `compactor/src/config/manager.ts`: All `(result as any)[key]`, `(baseVal as any)`, `(overrideVal as any)` replaced with properly typed generic approach
    - `compactor/src/tui/settings-overlay.ts`: All `v as any` in `setMode` replaced with proper mode type casting
    - `tsc --noEmit` passes in compactor
  - Steps:
    1. In presets.ts, type `overrides` parameter as `Partial<CompactorConfig>` so each spread can use `...(overrides.xxx as CompactorStrategyConfig | undefined)` or just check for undefined
    2. In manager.ts, rewrite `deepMerge` with proper generics: `function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T`
    3. In settings-overlay.ts, type the mode values correctly using the union types from `CompactorConfig` (e.g., `"full" | "brief" | "off"`)
    4. Verify compactor compiles

- completed: Task 18 — Fix `catch (err: any)` → `catch (err: unknown)` across all packages
  - Description: Replace all `catch (err: any)` with `catch (err: unknown)` and add type guards for error property access.
  - Dependencies: None
  - Acceptance Criteria:
    - All `catch (err: any)` replaced with `catch (err: unknown)`
    - All `err.message`, `err.stack` etc. guarded with `err instanceof Error ? err.message : String(err)`
    - Packages affected: compactor (executor.ts x2, db-base.ts, session/db.ts), updater (checker.ts, installer.ts), memory (storage.ts, embedding.ts), kanboard (commands.ts, 6 parser files, server/index.ts)
    - `tsc --noEmit` passes in all affected packages
  - Steps:
    1. Grep for `catch \(err: any\)|catch \(e: any\)` across all packages (18 instances found)
    2. For each instance, replace with `catch (err: unknown)` (or `catch (e: unknown)`)
    3. Where `err.message` is accessed, use: `const message = err instanceof Error ? err.message : String(err)`
    4. Where `err` is only logged or ignored, no further changes needed
    5. Verify all affected packages compile

- completed: Task 19 — Fix remaining `any` types in subagents, mcp, kanban, milestone (PARTIAL — remaining any types are in compactor hooks accessing SDK-internal properties)
  - Description: Clean up remaining `any` types in packages not fully covered by earlier tasks.
  - Dependencies: Task 4, Task 7
  - Acceptance Criteria:
    - `subagents/src/custom-agents.ts`: All `(frontmatter as any).xxx` replaced — either define a `CustomAgentFrontmatter` interface or use typed property access with nullish coalescing
    - `subagents/src/index.ts`: `safeFormatTokens(session: any)`, `safeTokenCount(session: any)`, `textResult(msg: string, details?: any)`, `buildNotificationDetails(record: any)` all typed
    - `subagents/src/conversation-viewer.ts`: `(session as any).messages`, `(c as any).name` etc. typed
    - `subagents/src/agent-runner.ts`: `(c as any).name` typed
    - `mcp/src/index.ts`: `(pi as any).registerTool?.(tool)` and `(pi as any).unregisterTool?.(toolName)` — use correct `ExtensionAPI` tool registration methods
    - `kanboard/` and `milestone/`: Verify remaining `any` types are addressed
    - `tsc --noEmit` passes in all affected packages
  - Steps:
    1. Define `CustomAgentFrontmatter` interface for subagents custom-agents.ts
    2. Replace all `(frontmatter as any).xxx` with typed access using the interface
    3. Type `session` parameter in safeFormatTokens/safeTokenCount (use `AgentSession` or appropriate type)
    4. Type `details` and `record` parameters in subagents utility functions
    5. For conversation-viewer.ts, type `session` as `AgentSession` and access `.messages` directly
    6. For mcp registerTool/unregisterTool, use the correct `ExtensionAPI` methods or add type declarations
    7. Scan kanboard and milestone for remaining `any` types and fix
    8. Verify all packages compile

- completed: Task 20 — Fix `OwnCutResult.messages: any[]` and compaction utility types
  - Description: Replace the remaining `any[]` in compactor's core type definitions.
  - Dependencies: None
  - Acceptance Criteria:
    - `compactor/src/types.ts`: `OwnCutResult` success variant `messages: any[]` → `messages: Message[]` (using `Message` from `@mariozechner/pi-ai` already imported)
    - `compactor/src/compaction/content.ts`: `(c: any)` map callback typed
    - `compactor/src/compaction/recall-scope.ts`: `branchEntries: any[]` typed as appropriate entry type
    - `compactor/src/executor/executor.ts`: `catch (err: any)` already covered in Task 18; verify no other `any` remains
    - `compactor/src/executor/runtime.ts`: `(runtimes as any)[lang]` typed
    - `compactor/src/info-screen.ts`: `(sessionStats as any).total_chars_before` — type with correct stats interface
    - `compactor/src/tools/ctx-stats.ts`: Same sessionStats typing
    - `compactor/src/index.ts`: `measureResponseBytes(event: any)` typed, `function measureResponseBytes(event: any)` → typed
    - `tsc --noEmit` passes in compactor
  - Steps:
    1. Change `messages: any[]` to `messages: Message[]` in OwnCutResult (Message already imported)
    2. Type `content.ts` map callback based on the content block type from pi-ai
    3. Type `branchEntries` in recall-scope.ts based on actual entry type
    4. Type `measureResponseBytes` event parameter
    5. Type `runtimes` record as `Record<string, string>` instead of `(runtimes as any)[lang]`
    6. Define a `SessionStats` interface for the stats object that has `total_chars_before` and `total_chars_kept`
    7. Verify compactor compiles

---

## Sequencing

```
Phase A (Foundation — no dependencies):
  Task 1: TUI overlay types        ←──┐
  Task 2: global.d.ts              ←──┤  (parallel)
  Task 3: emitEvent fix            ←──┘

Phase B (Event typing — no dependencies on Phase A):
  Task 4: UNIPI_EVENTS listeners   ←──┐  (parallel)
  Task 5: pi SDK event listeners   ←──┤
  Task 6: Compactor hook events    ←──┘  (depends on Task 5)

Phase C (Command context — no dependencies on Phase A):
  Task 7: ctx: any → ExtensionCommandContext  ←──┐  (parallel)
  Task 8: Module-level any variables            ←──┘

Phase D (TUI overlay — depends on Task 1):
  Task 9:  ask-user + notify     ←──┐  (parallel after Task 1)
  Task 10: compactor + info + footer←┤
  Task 11: mcp + updater + utility  ┤
           + subagents              ┘

Phase E (Database — independent):
  Task 12: Compactor DB           ←──┐  (parallel)
  Task 13: Memory DB              ←──┘

Phase F (Remaining — some depend on B/C):
  Task 14: Lazy-loaded modules    ←── (independent)
  Task 15: Compactor tools        ←── (independent)
  Task 16: Utility diff tools     ←── (independent)
  Task 17: Config spread merging  ←── (independent)
  Task 18: catch (err: any)       ←── (independent)
  Task 19: Subagents/mcp/etc.     ←── (depends on Tasks 4, 7)
  Task 20: Compactor core types   ←── (independent)
```

**Optimal execution order (by dependency, most parallelizable):**

1. Tasks 1, 2, 3, 4, 5, 7, 8, 12, 13, 14, 15, 16, 17, 18, 20 — all independent
2. Task 6 — after Task 5
3. Tasks 9, 10, 11 — after Task 1
4. Task 19 — after Tasks 4, 7

**Recommended session grouping:**
- **Session 1:** Tasks 1 + 2 + 3 (Foundation — shared types)
- **Session 2:** Tasks 4 + 5 + 6 (Event typing)
- **Session 3:** Tasks 7 + 8 (Command context typing)
- **Session 4:** Tasks 9 + 10 + 11 (TUI overlay typing — largest surface area)
- **Session 5:** Tasks 12 + 13 (Database row typing)
- **Session 6:** Tasks 14 + 15 + 16 + 17 + 18 + 19 + 20 (Remaining categories)

## Risks

1. **`ExtensionCommandContext` property gaps** — Some handlers access `ctx.cwd`, `ctx.sessionId`, `ctx.sessionManager`, `ctx.messages` which may not be on the official `ExtensionCommandContext` type. If not, we need alternative API paths or the SDK needs updating. **Mitigation:** Check the type first; if properties are missing, access them through the correct nested path or add them to a local extended interface.

2. **`pi.registerTool()` type compatibility** — The `as any` casts on `registerTool` calls may indicate a mismatch between our tool objects and the `ToolDefinition` type. **Mitigation:** Investigate the exact structural mismatch and fix it properly (missing properties, wrong types, etc.).

3. **Third-party module types unavailable** — `wreq`, `defuddle` don't have `@types` packages. **Mitigation:** Create minimal type stubs (`declare module "wreq" { ... }`) rather than using `any`.

4. **TUI interface completeness** — The `TUI` interface must cover all methods called across overlay implementations. **Mitigation:** Thorough grep audit in Task 1 Step 1.

5. **`ThemeColor` union restrictions** — Custom color names used in extensions may not be in the `ThemeColor` union. **Mitigation:** If custom colors are intentional, widen to `string` for those specific cases.

6. **Scope creep** — ~315 `any` usages is a lot. Test-only casts and SDK-provided `any` (e.g., `Model<any>`) are explicitly out of scope. **Mitigation:** Strict scope adherence per the spec's "Out of Scope" section.

## Out of Scope (per spec)

- Test-only `as any` casts (acceptable for testing private internals)
- `Model<any>` generic parameter (from pi SDK, can't change)
- `.d.ts` files for third-party types (separate concern, except minimal stubs for wreq/defuddle)
- Runtime behavior changes — purely type-level cleanup
- Adding `noImplicitAny` to tsconfig (future step)
- `any` in `node_modules` or generated code
- `window as any` in web-api DOM polyfills (acceptable runtime polyfills)

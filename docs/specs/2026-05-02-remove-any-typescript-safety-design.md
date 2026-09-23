---
title: "Remove `any` — TypeScript Type Safety Cleanup"
type: brainstorm
date: 2026-05-02
---

# Remove `any` — TypeScript Type Safety Cleanup

## Problem Statement

The unipi codebase has ~315 explicit `any` type usages across 50+ source files. These `any` usages silently disable TypeScript's type checker, hiding real bugs behind untyped property accesses, missed return-type validation, and unchecked function parameters. The codebase already has rich type infrastructure (`@pi-unipi/core` has fully typed event payloads, `@mariozechner/pi-coding-agent` exports typed extension/command/event interfaces) but most packages ignore these types and use `any` instead.

**Reframed problem:** The codebase doesn't need *new* types — it needs to *use* the types it already has, and fill gaps with targeted interfaces where none exist.

## Context

### What exists already

1. **`@pi-unipi/core/events.ts`** — 26 fully typed event payload interfaces (`UnipiModuleEvent`, `UnipiWorkflowEvent`, `UnipiBadgeGenerateRequestEvent`, etc.) with a `UnipiEventPayload` union type. Most files ignore these and use `(event: any)`.

2. **`@mariozechner/pi-coding-agent`** — Exports `ExtensionCommandContext`, `ExtensionContext`, `ExtensionAPI`, `ToolCallEvent`, `ToolResultEvent`, `SessionBeforeCompactEvent`, `Theme`, `ThemeColor`, `AgentSession`, etc. Most files use `ctx: any` instead.

3. **Per-package `types.ts`** — `compactor/src/types.ts`, `footer/src/types.ts`, `subagents/src/types.ts`, `utility/src/types.ts` all have rich domain types but some still contain `any` (e.g., `OwnCutResult` has `messages: any[]`).

4. **`tsconfig.json`** — `"strict": true` is enabled, which should catch `any` — but explicit annotations bypass this.

### Scan results summary

| Category | Count | Root Cause |
|----------|-------|------------|
| TUI overlay callbacks | ~80 | No shared `OverlayRenderer` type |
| Command handler context | ~30 | `ctx` typed as `any` instead of `ExtensionCommandContext` |
| Event payloads | ~40 | `event as any` instead of using typed event interfaces |
| `globalThis as any` | ~18 | No `global.d.ts` for `__unipi_*` properties |
| `pi as any` / `emitEvent` | ~16 | `emitEvent()` not on `ExtensionAPI` type |
| SQLite DB rows | ~30 | Query results cast to `any[]` |
| Lazy-loaded modules | ~10 | Dynamic imports stored as `any` |
| Tool execute functions | ~20 | `params: any` / `Promise<any>` |
| Config spread merging | ~15 | `overrides.x as any` for partial config |
| Theme color casting | ~12 | `theme.fg(color as any)` for custom colors |
| `catch (err: any)` | ~20 | Should be `unknown` |
| Test-only casts | ~15 | Acceptable — testing internals |

## Chosen Approach

**Incremental typing by category** — Fix `any` usage in dependency order, one category at a time. Each category is a self-contained task that can be implemented, type-checked, and committed independently. No big-bang rewrite.

## Why This Approach

**Alternatives considered:**

1. **Big-bang `noImplicitAny` enforcement** — Add `"noImplicitAny": true` to tsconfig and fix all errors at once. **Rejected:** Too risky, creates massive PR, hard to review, breaks CI for all packages simultaneously.

2. **Per-package cleanup** — Fix all `any` in one package at a time. **Rejected:** Many `any` patterns (overlays, events, globals) are cross-cutting — they'd require shared types first, then changes in every package.

3. **Incremental by category (chosen)** — Fix one pattern category at a time. Each category either adds shared types or uses existing ones. Type safety improves incrementally. Each PR is focused and reviewable. **Best approach** because it's safe, progressive, and each step delivers value.

## Design

### Architecture: New shared types

All new types go into **`@pi-unipi/core`** (already the shared dependency). No new packages.

```
packages/core/
  events.ts          ← existing (already has UnipiEventPayload)
  types.ts           ← NEW: OverlayRenderer, CommandContext, global augmentation, DB helpers
  global.d.ts        ← NEW: GlobalThis augmentation for __unipi_* properties
```

### Component 1: TUI Overlay Types

**Current pattern (80+ instances):**
```ts
ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => { ... });
```

**New types in `@pi-unipi/core/types.ts`:**
```ts
import type { Theme } from "@mariozechner/pi-coding-agent";

/** TUI instance passed to overlay renderers */
export interface TUI {
  requestRender(): void;
  getTerminalSize(): { width: number; height: number };
  write(data: string): void;
  // ... other methods observed in usage
}

/** Keybinding context passed to overlay renderers */
export interface OverlayKeybindings {
  getBindings(): Map<string, string>;
}

/** Standard overlay renderer callback */
export type OverlayRenderer = (
  tui: TUI,
  theme: Theme,
  keybindings: OverlayKeybindings,
  done: (result: void) => void
) => void;

/** Dialog-style overlay with typed result */
export type DialogOverlayRenderer<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: OverlayKeybindings,
  done: (result: T) => void
) => void;
```

The `TUI` interface will be derived by reading the actual methods called on `tui` across all overlay implementations (`.requestRender()`, `.getTerminalSize()`, `.write()`, `.moveTo()`, etc.).

### Component 2: Command Context Typing

**Current pattern (30+ instances):**
```ts
handler: async (args: string, ctx: any) => { ... }
```

**Fix:** Use the existing `ExtensionCommandContext` type from `@mariozechner/pi-coding-agent`, which is already exported and has `.ui`, `.cwd`, `.sessionId`, `.messages`, `.sessionManager`, etc.

Some command handlers access properties like `ctx.cwd` and `ctx.sessionId` via `ctx as any` — these need to be verified against the `ExtensionCommandContext` shape. Properties not on the official type should be accessed through the correct API path.

### Component 3: Event Payload Typing

**Current pattern (40+ instances):**
```ts
pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST, async (event: any) => { ... });
```

**Fix:** Use the existing typed event interfaces from `@pi-unipi/core/events.ts`. Most listeners already have matching types — they just need to be imported and used:

```ts
import { UNIPI_EVENTS, type UnipiBadgeGenerateRequestEvent } from "@pi-unipi/core";
pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST, async (event: UnipiBadgeGenerateRequestEvent) => { ... });
```

For pi SDK events (`pi.on("tool_before"...)` etc.), use the typed event interfaces from `@mariozechner/pi-coding-agent` (`ToolCallEvent`, `ToolResultEvent`, etc.).

**Event type mapping needed:**

| Pi event name | SDK type to use |
|---------------|----------------|
| `"tool_before"` | `ToolCallEvent` |
| `"tool_after"` | `ToolResultEvent` |
| `"session_before_compact"` | `SessionBeforeCompactEvent` |
| `"agent_start"` / `"agent_end"` | `AgentStartEvent` / `AgentEndEvent` |
| `"input"` | `InputEvent` |
| `"message"` | `MessageStartEvent` / `MessageUpdateEvent` / `MessageEndEvent` |

### Component 4: Global Type Augmentation

**Current pattern (18 instances):**
```ts
const g = globalThis as any;
g.__unipi_compactor = ...;
```

**New file `@pi-unipi/core/global.d.ts`:**
```ts
declare global {
  interface GlobalThis {
    __unipi_info_registry?: import("./types").InfoRegistry;
    __unipi_compactor?: import("./types").CompactorState;
    // ... other __unipi_* properties
  }
}
```

### Component 5: `emitEvent` Typing

**Current pattern (16 instances):**
```ts
emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, { ... });
```

**Fix:** The `emitEvent` helper in `@pi-unipi/core` should accept `ExtensionAPI` directly. If `emitEvent` needs internal APIs not on the public type, create a wrapper that uses the event bus from the extension context instead of casting `pi`:

```ts
// In @pi-unipi/core
export function emitEvent(pi: ExtensionAPI, event: string, payload: unknown): void {
  pi.events?.emit?.(event, payload);
}
```

### Component 6: SQLite Row Types

**Current pattern (30 instances):**
```ts
const rows = this.db.prepare("SELECT id, title FROM memories").all() as any[];
const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
```

**Fix:** Define typed row interfaces per table:

```ts
// In each package's types.ts
export interface MemoryRow {
  id: string;
  title: string;
  type: string;
  project: string;
  content: string;
  tags: string;
  created: string;
  updated: string;
  // ... etc
}
```

Also type the database wrapper interface (already partially done in `compactor/src/session/db.ts` lines 62-64, but using `any[]` return types).

### Component 7: Lazy-Loaded Module Types

**Current pattern (10 instances):**
```ts
let wreqModule: any = null;
let shikiHighlighter: any = null;
let sqliteLib: any = null;
```

**Fix:** Use `typeof import(...)`:
```ts
let sqliteLib: typeof import("bun:sqlite") | null = null;
let shikiHighlighter: import("shiki").Highlighter | null = null;
```

For modules without type declarations, create minimal type stubs rather than using `any`.

### Component 8: Tool Execute Function Types

**Current pattern (20 instances):**
```ts
async execute(_toolCallId: string, params: any): Promise<any> { ... }
```

**Fix:** Use `defineTool()` from `@mariozechner/pi-coding-agent` which already provides typed generics. For tools that can't use `defineTool()`, use the `ToolDefinition` type and type params with the actual Zod/JSON schema inference:

```ts
type SandboxParams = { language: string; code: string; timeout?: number };
async execute(_toolCallId: string, params: SandboxParams): Promise<AgentToolResult> { ... }
```

### Component 9: Config Spread Merging

**Current pattern (15 instances):**
```ts
sessionGoals: { ...DEFAULT.sessionGoals, ...(overrides.sessionGoals as any) },
```

**Fix:** Use `DeepPartial<CompactorConfig>` for partial overrides, or use the existing `deepMerge` function with proper generics:

```ts
import type { CompactorStrategyConfig } from "./types";
type PartialStrategy = Partial<CompactorStrategyConfig>;
sessionGoals: { ...DEFAULT.sessionGoals, ...(overrides.sessionGoals as PartialStrategy) },
```

### Component 10: Theme Color Casting

**Current pattern (12 instances):**
```ts
theme.fg(color as any, text)
```

**Fix:** The `ThemeColor` type from pi is a string union. Extensions use custom color names not in that union. Options:
- Use `theme.fg(color as ThemeColor, text)` if color is always valid
- Widen to `string` if custom colors are intentionally used

### Component 11: `catch (err: any)` → `catch (err: unknown)`

**Current pattern (~20 instances):**
```ts
} catch (err: any) {
  logError(err.message);
}
```

**Fix:** Use `catch (err: unknown)` and narrow with type guards:
```ts
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logError(message);
}
```

## Implementation Checklist

### Phase A: Foundation (shared types) — No behavioral changes
- [x] Create `packages/core/types.ts` with `TUI`, `OverlayKeybindings`, `OverlayRenderer`, `DialogOverlayRenderer<T>` interfaces — covered in Task 1
- [x] Create `packages/core/global.d.ts` with `GlobalThis` augmentation for all `__unipi_*` properties — covered in Task 2
- [x] Add typed `emitEvent` overload signatures that accept `ExtensionAPI` without casting — covered in Task 3

### Phase B: Event payload typing — Mechanical, safe
- [x] Replace all `UNIPI_EVENTS` listeners `(event: any)` with typed event imports from `@pi-unipi/core/events.ts` — covered in Task 4
- [x] Replace all pi SDK event listeners `(event: any)` with typed imports (`ToolCallEvent`, `ToolResultEvent`, `InputEvent`, etc.) from `@mariozechner/pi-coding-agent` — covered in Task 5
- [x] Replace `event as any` property accesses in compactor hooks with typed event access — covered in Task 6

### Phase C: Command context typing — Mechanical, safe
- [x] Replace all `handler: async (args: string, ctx: any)` with `handler: async (args: string, ctx: ExtensionCommandContext)` — covered in Task 7
- [x] Remove `(ctx as any).cwd` / `(ctx as any).sessionId` casts — use correct API paths — covered in Tasks 7, 8

### Phase D: TUI overlay typing — After Phase A provides the types
- [x] Replace all `(tui: any, theme: any, _kb: any, done: any)` with `OverlayRenderer` type in notify, updater, info-screen, footer, mcp, kanboard, ask-user, utility, compactor — covered in Tasks 9, 10, 11
- [x] Type `theme: any` parameters as `Theme` from `@mariozechner/pi-coding-agent` — covered in Tasks 9, 10, 11

### Phase E: Database row typing — Per-package, safe
- [x] Create typed row interfaces in compactor (`SessionEventRow`, `ContentChunkRow`, etc.) — covered in Task 12
- [x] Create typed row interfaces in memory (`MemoryRow`, `SearchResultRow`) — covered in Task 13
- [x] Replace `db: any` private fields with typed database wrapper interface — covered in Tasks 12, 13

### Phase F: Remaining categories
- [x] Type lazy-loaded modules (`sqliteLib`, `shikiHighlighter`, `wreqModule`, etc.) with `typeof import(...)` or minimal stubs — covered in Task 14
- [x] Type tool execute functions with actual param types instead of `params: any` — covered in Tasks 15, 16
- [x] Fix config spread merging — use `Partial<T>` or `DeepPartial<T>` instead of `as any` — covered in Task 17
- [x] Fix theme color casting — use `ThemeColor` or widen intentionally — covered in Tasks 9, 10, 11
- [x] Replace all `catch (err: any)` with `catch (err: unknown)` + type guards — covered in Task 18
- [x] Fix remaining `OwnCutResult.messages: any[]` → use `Message[]` from pi SDK — covered in Task 20
- [x] Fix `piApi: any` in info-screen/core-groups.ts → type as `ExtensionAPI` — covered in Task 8
- [x] Fix `firstInputCtx: any` in utility/src/index.ts → type as `ExtensionContext` — covered in Task 8

## Open Questions

1. **`TUI` interface completeness** — The `TUI` interface needs to be derived by auditing all methods called on the `tui` parameter across overlays. Some overlays may call methods not on any documented interface. Need to verify during Phase A.

2. **`emitEvent` internal API access** — `emitEvent` currently casts `pi` to access internal `.events.emit()`. If this isn't on the public `ExtensionAPI` type, we may need a PR to pi-coding-agent to expose it, or use `pi.events.on()` which IS public.

3. **`ExtensionCommandContext` property coverage** — Some handlers access `ctx.sessionId`, `ctx.cwd` via `ctx as any`. Need to verify these are on the official type. If not, need alternative API paths.

4. **Third-party module types** — `wreq`, `defuddle` don't have `@types` packages. Need minimal stub declarations instead of `any`.

5. **`window as any` in web-api DOM polyfills** — These are runtime polyfills for a jsdom-like environment. Using `any` here may be intentional and acceptable (Low priority).

## Out of Scope

- Test-only `as any` casts (acceptable for testing private internals)
- `Model<any>` generic parameter (from pi SDK, can't change)
- `.d.ts` files for third-party types (separate concern)
- Runtime behavior changes — this is purely type-level cleanup
- Adding `noImplicitAny` to tsconfig (future step after all explicit `any` are addressed)
- `any` in `node_modules` or generated code

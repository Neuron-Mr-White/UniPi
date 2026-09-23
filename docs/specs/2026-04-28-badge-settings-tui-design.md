---
title: "Badge Settings TUI & Generation Fix"
type: brainstorm
date: 2026-04-28
---

# Badge Settings TUI & Generation Fix

## Problem Statement

The badge name generation feature is broken — it shows "generating..." but never completes. The root cause is that `openai/gpt-oss-20b` is hardcoded in the subagents module, and if that model isn't available, the background agent silently fails. There's no way for users to configure which model to use, and no settings UI to manage badge behavior.

Additionally, badge settings are managed via a text-based CLI command (`/unipi:badge-toggle [key] [on|off]`) and a misplaced overlay in the kanboard package. Users need a proper TUI overlay with toggle controls and a model selector showing all available models.

**Root needs:**
1. Fix the generation flow so it always works (fallback to parent model)
2. A dedicated Settings TUI for badge configuration
3. A shared model list cache (`~/.unipi/config/models-cache.json`) so any package can list available models without needing `ctx.modelRegistry` at render time
4. Clean up the misplaced kanboard settings overlay

## Context

**Current badge settings flow:**
- `.unipi/config/badge.json` stores: `{ autoGen: boolean, badgeEnabled: boolean, agentTool: boolean }`
- `packages/utility/src/tui/badge-settings.ts` — read/write functions
- `packages/kanboard/tui/settings-overlay.ts` — misplaced TUI overlay (should be in utility)
- `/unipi:badge-toggle [key] [on|off]` — CLI command, or shows text table
- `/unipi:badge-name` — toggles badge visibility
- `/unipi:badge-gen` — triggers generation

**Current generation flow:**
1. `utility/index.ts` emits `BADGE_GENERATE_REQUEST` event on first message
2. `subagents/index.ts` listens, spawns background agent with hardcoded `openai/gpt-oss-20b`
3. If model not found, `resolvedModel` stays `undefined` → inherits parent model
4. Agent calls `set_session_name` tool → name appears in badge

**The bug:** The model resolution in subagents falls back to `undefined` (inherit parent), which should work. But the issue is likely that:
- The `set_session_name` tool may not be registered if `agentTool` is false
- Or the spawned agent doesn't have access to the `set_session_name` tool
- Or the background agent's explore type doesn't have the tool available

**Model registry access:**
- `ctx.modelRegistry` is available in command handlers and event listeners
- `registry.getAll()` returns all loaded models
- `registry.getAvailable()` returns available models (optional)
- No file-based model cache exists — each access requires runtime `ctx`

**Existing TUI patterns:**
- MCP settings overlay: functional component with `tui, theme, kb, done` signature
- Notify settings overlay: `Component` class with `handleInput`, `render`, `invalidate`
- Both use `ctx.ui.custom()` with `overlay: true`, `overlayOptions`

## Chosen Approach

### 1. Model Cache System (`~/.unipi/config/models-cache.json`)

Create a shared model cache in `@pi-unipi/core` that:
- Writes model list to `~/.unipi/config/models-cache.json` on `session_start` (when `ctx.modelRegistry` is available)
- Provides `readModelCache()` function usable by any package without `ctx`
- Cache format: `{ updatedAt: string, models: Array<{ id: string, provider: string, name?: string }> }`
- Cache is refreshed each session start (models don't change mid-session)

**Why:** The TUI overlay needs to display a model list, but it's created inside a `ctx.ui.custom()` callback that doesn't pass `modelRegistry`. A file cache solves this cleanly.

### 2. Badge Settings TUI (`packages/utility/src/tui/badge-settings-tui.ts`)

New TUI overlay in the utility package with:
- **Auto-generate** toggle (boolean)
- **Badge enabled** toggle (boolean)
- **Generation model** selector — scrollable list of models from cache, "inherit" as first option
- Vim-style navigation (j/k), Space to toggle, Enter to select model
- Auto-saves on close (Esc)

### 3. Fix Generation Flow

Update `subagents/index.ts`:
- Read `generationModel` from badge.json
- If set and not "inherit", use that model string
- If "inherit" or unset, pass `undefined` → parent model
- The `set_session_name` tool is always available to spawned agents (it's registered at extension level)

### 4. Remove Misplaced Kanboard Overlay

- Delete `packages/kanboard/tui/settings-overlay.ts`
- Remove `/unipi:kanboard-settings` command from `kanboard/commands.ts`
- The kanboard overlay was editing badge.json — that's utility's responsibility

## Why This Approach

- **File-based model cache** is the simplest way to make model lists available to TUI components without passing `ctx` through layers. One write per session, zero runtime overhead.
- **TUI in utility package** follows the natural ownership — badge settings are utility's domain.
- **Auto-save on close** matches the notify settings pattern (simpler than explicit save).
- **"inherit" as default** means generation works out of the box with the parent agent's model.

## Design

### File Structure

```
packages/core/
├── model-cache.ts          # NEW — read/write model cache

packages/utility/
├── src/
│   ├── tui/
│   │   ├── badge-settings-tui.ts  # NEW — settings TUI overlay
│   │   ├── badge-settings.ts      # EXISTING — add generationModel field
│   │   ├── name-badge-state.ts    # EXISTING — no changes
│   │   └── name-badge.ts          # EXISTING — no changes
│   ├── commands.ts                 # UPDATE — /unipi:badge-settings opens TUI
│   └── index.ts                    # UPDATE — write model cache on session_start

packages/kanboard/
├── tui/
│   └── settings-overlay.ts        # DELETE
├── commands.ts                     # UPDATE — remove kanboard-settings command
```

### Model Cache (`packages/core/model-cache.ts`)

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

const CACHE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".unipi/config"
);
const CACHE_FILE = path.join(CACHE_DIR, "models-cache.json");

export interface CachedModel {
  provider: string;
  id: string;
  name?: string;
}

export interface ModelCache {
  updatedAt: string;
  models: CachedModel[];
}

/** Read cached model list. Returns empty array if no cache. */
export function readModelCache(): CachedModel[] {
  try {
    if (!fs.existsSync(CACHE_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/** Write model list to cache. Creates directory if needed. */
export function writeModelCache(models: CachedModel[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const cache: ModelCache = {
      updatedAt: new Date().toISOString(),
      models,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort
  }
}
```

### Badge Settings Update (`badge-settings.ts`)

Add `generationModel` field:

```typescript
export interface BadgeSettings {
  autoGen: boolean;
  badgeEnabled: boolean;
  agentTool: boolean;
  generationModel: string; // "inherit" or "provider/model-id"
}

const DEFAULT_SETTINGS: BadgeSettings = {
  autoGen: true,
  badgeEnabled: true,
  agentTool: true,
  generationModel: "inherit",
};
```

### Settings TUI (`badge-settings-tui.ts`)

Overlay component with three settings:

**Layout:**
```
╭────────────────────────────────────────╮
│  Badge Settings                        │
│  Configure badge generation behavior   │
│                                        │
│  ▸ ● Auto generate                     │
│    Generate name on first message      │
│                                        │
│    ○ Badge enabled                     │
│    Show the name badge overlay         │
│                                        │
│    Model: inherit                      │
│    Generation model for badge names    │
│                                        │
│  ── Available Models ──────────────    │
│    ▸ inherit (use parent model)        │
│      openai/gpt-4o                     │
│      anthropic/claude-sonnet-4-6       │
│      ...                               │
│                                        │
│  ↑↓ navigate • Space toggle • Enter    │
│  select model • Esc close              │
╰────────────────────────────────────────╯
```

**Behavior:**
- j/k or ↑↓ to navigate between settings
- Space toggles boolean settings (autoGen, badgeEnabled)
- Enter on "Model" opens model picker (inline list below)
- Model picker: j/k to scroll, Enter to select, Esc to cancel
- Auto-saves to `.unipi/config/badge.json` on every change
- Esc closes the overlay

### Generation Flow Fix (`subagents/index.ts`)

```typescript
pi.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST as any, async (event: any) => {
  if (!sessionCtx) return;

  const summary = event?.conversationSummary ?? "";
  const prompt = summary
    ? `Generate a concise session title (MAX 5 WORDS) for this conversation:\n\n"${summary}"\n\nCall the set_session_name tool with the name. Do not explain.`
    : `Generate a concise session title (MAX 5 WORDS) for the current session. Call the set_session_name tool. Do not explain.`;

  // Read configured model from badge settings
  const { readBadgeSettings } = await import("@pi-unipi/utility");
  const settings = readBadgeSettings();
  const modelInput = settings.generationModel === "inherit"
    ? undefined
    : settings.generationModel;

  let resolvedModel: any = undefined;
  if (modelInput && sessionCtx.modelRegistry) {
    const { resolveModel } = await import("./model-resolver.js");
    const result = resolveModel(modelInput, sessionCtx.modelRegistry);
    if (typeof result !== "string") {
      resolvedModel = result;
    }
    // If resolution fails, resolvedModel stays undefined → inherit
  }

  manager.spawn(pi, sessionCtx, "explore", prompt, {
    description: "Generate session name",
    model: resolvedModel,
    isBackground: true,
    maxTurns: 3,
  });
});
```

### Model Cache Write (`utility/index.ts`)

On `session_start`, write available models to cache:

```typescript
pi.on("session_start", async (_event, ctx) => {
  // ... existing code ...

  // Write model cache for TUI components
  if (ctx.modelRegistry) {
    const { writeModelCache } = await import("@pi-unipi/core");
    const models = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll())
      .map((m: any) => ({ provider: m.provider, id: m.id, name: m.name }));
    writeModelCache(models);
  }
});
```

### Command Updates

**Replace `/unipi:badge-toggle`** with `/unipi:badge-settings` that opens TUI:

```typescript
pi.registerCommand(`${UNIPI_PREFIX}badge-settings`, {
  description: "Configure badge settings via TUI overlay",
  handler: async (_args: string, ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Badge settings require an interactive UI.", "warning");
      return;
    }

    ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: any) => {
        const overlay = new BadgeSettingsTui();
        overlay.setTheme(theme);
        overlay.onClose = () => done(undefined);
        overlay.requestRender = () => tui.requestRender();
        return {
          render: (w: number) => overlay.render(w),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%",
          minWidth: 50,
          anchor: "center",
          margin: 2,
        },
      }
    );
  },
});
```

### Kanboard Cleanup

Remove:
- `packages/kanboard/tui/settings-overlay.ts` — the entire file
- In `packages/kanboard/commands.ts`: remove the `/unipi:kanboard-settings` command registration (lines ~88-122)
- In `packages/kanboard/commands.ts`: remove the `import { KanboardSettingsOverlay }` line

## Implementation Checklist

- [x] Create `packages/core/model-cache.ts` — read/write model cache to `~/.unipi/config/models-cache.json` — covered in Task 1
- [x] Export `model-cache.ts` from `packages/core/index.ts` — covered in Task 1
- [x] Update `packages/utility/src/tui/badge-settings.ts` — add `generationModel` field to `BadgeSettings` interface and defaults — covered in Task 2
- [x] Create `packages/utility/src/tui/badge-settings-tui.ts` — Settings TUI overlay component — covered in Task 3
- [x] Update `packages/utility/src/commands.ts` — replace `/unipi:badge-toggle` with `/unipi:badge-settings` TUI opener, export `readBadgeSettings` — covered in Task 4
- [x] Update `packages/utility/src/index.ts` — write model cache on `session_start`, export `readBadgeSettings` — covered in Task 4 & Task 5
- [x] Update `packages/subagents/src/index.ts` — read `generationModel` from badge settings instead of hardcoding model — covered in Task 6
- [x] Delete `packages/kanboard/tui/settings-overlay.ts` — covered in Task 7
- [x] Update `packages/kanboard/commands.ts` — remove `/unipi:kanboard-settings` command and its import — covered in Task 7

## Open Questions

- **Model cache scope:** Should the cache be per-project (`./.unipi/config/models-cache.json`) or global (`~/.unipi/config/models-cache.json`)? Global is simpler and models are the same across projects.
- **Badge settings export:** `readBadgeSettings` needs to be exported from `@pi-unipi/utility` so subagents can import it. Alternatively, subagents could read the JSON file directly.

## Out of Scope

- **Badge customization** — colors, fonts, positions beyond current defaults
- **Per-model credentials** — the cache only stores model metadata, not API keys
- **Model availability checking** — the cache lists all loaded models, not just those with valid credentials
- **Multiple badge styles** — single badge overlay, no themes

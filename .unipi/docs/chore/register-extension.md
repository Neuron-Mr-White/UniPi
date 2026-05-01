---
name: register-extension
type: maintenance
description: Register a new Unipi extension into command registry, info-screen, and unipi package
created: 2026-04-29
updated: 2026-05-01
---

# Register Extension

Register a new Unipi extension into all required registries. This is the canonical guide for adding a new package to the Unipi monorepo — avoids re-researching registration points each time.

## Pre-conditions

Before running this chore, ensure:
- [ ] New package exists under `packages/<name>/`
- [ ] Package has a **root `index.ts`** that re-exports `./src/index.ts` (see Step 0)
- [ ] Package `src/index.ts` exports a default function accepting `ExtensionAPI`
- [ ] Package registers its commands via `pi.registerCommand()` with the full `unipi:` prefix
- [ ] On main branch

## Steps

### Step 0: Create Root Barrel File (CRITICAL)

Every unipi package **must** have a root `index.ts` that re-exports the entry point. Without this, TypeScript's NodeNext module resolution cannot find the package when imported as `@pi-unipi/<name>`.

Create `packages/<name>/index.ts`:

```typescript
/**
 * @pi-unipi/<name> — Re-exports
 */

export { default } from "./src/index.ts";
```

**Why:** When npm symlinks the package into `node_modules/@pi-unipi/<name>/`, TypeScript looks for `index.ts` at the package root. If it only exists in `src/index.ts`, the module resolution fails silently — the extension never loads.

**Verification:** After `npm install`, check that `node_modules/@pi-unipi/<name>/index.ts` exists.

Expected: Root barrel file exists and re-exports `./src/index.ts`.

### Step 1: Read the New Package

Read the package's `src/index.ts` and any `commands.ts` to extract:
- Package name (kebab-case, e.g., `my-package`)
- All commands it registers (must include `unipi:` prefix, e.g., `unipi:my-cmd`)
- Whether it already has info-screen registration

```bash
cat packages/<name>/src/index.ts
cat packages/<name>/src/commands.ts  # if exists
```

Expected: List of all command names (with `unipi:` prefix) and info-screen registration status.

### Step 2: Ensure Commands Use `unipi:` Prefix

Commands must be registered with the **full `unipi:` prefix** in `pi.registerCommand()`. There are two patterns:

**Pattern A — Direct string (preferred):**
```typescript
pi.registerCommand("unipi:my-cmd", {
  description: "...",
  handler: async (args, ctx) => { ... },
});
```

**Pattern B — Using constants:**
```typescript
import { UNIPI_PREFIX, MY_COMMANDS } from "@pi-unipi/core";

pi.registerCommand(`${UNIPI_PREFIX}${MY_COMMANDS.MY_CMD}`, {
  description: "...",
  handler: async (args, ctx) => { ... },
});
```

**WRONG:** `pi.registerCommand("my-cmd", ...)` — creates `/my-cmd` instead of `/unipi:my-cmd`

Expected: All commands registered with `unipi:` prefix.

### Step 3: Add MODULES Constant (if missing)

In `packages/core/constants.ts`, add the module name if it doesn't exist:

```typescript
export const MODULES = {
  // ... existing ...
  MY_PACKAGE: "@pi-unipi/<name>",
} as const;
```

Also add command constants if useful:

```typescript
export const MY_COMMANDS = {
  CMD1: "my-cmd",
  CMD2: "my-cmd-settings",
} as const;
```

Expected: MODULES entry exists in core/constants.ts.

### Step 4: Update Command Registry (5 places)

All changes go in `packages/autocomplete/src/constants.ts`:

#### 4a. PACKAGE_ORDER
Add the package name to the array (order by display priority):
```typescript
export const PACKAGE_ORDER: string[] = [
  // ... existing packages ...
  "<name>",  // Add here
];
```

#### 4b. PACKAGE_COLORS
Add ANSI color code for the package:
```typescript
export const PACKAGE_COLORS: Record<string, string> = {
  // ... existing ...
  "<name>": `${ESC}[<color>m`,  // Pick a distinct color
};
```

Color reference:
- `31` = Red, `32` = Green, `33` = Yellow, `34` = Blue, `35` = Magenta, `36` = Cyan
- `91-96` = Bright variants

#### 4c. COMMAND_REGISTRY
Map each command to the package (with `unipi:` prefix):
```typescript
export const COMMAND_REGISTRY: Record<string, string> = {
  // ... existing ...
  "unipi:<cmd1>": "<name>",
  "unipi:<cmd2>": "<name>",
};
```

#### 4d. COMMAND_DESCRIPTIONS
Add short descriptions for each command (with `unipi:` prefix):
```typescript
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  // ... existing ...
  "unipi:<cmd1>": "Short description of cmd1",
  "unipi:<cmd2>": "Short description of cmd2",
};
```

#### 4e. PACKAGE_LABELS
Add pretty name for display:
```typescript
export const PACKAGE_LABELS: Record<string, string> = {
  // ... existing ...
  "<name>": "<name>",
};
```

Expected: All 5 data structures updated with new package and its commands.

### Step 5: Update Unipi Package Entry

In `packages/unipi/index.ts`, add import and call:

```typescript
import <importName> from "@pi-unipi/<name>";

export default function (pi: ExtensionAPI) {
  // ... existing ...
  <importName>(pi);
}
```

Expected: Package imported and called in the all-in-one entry point.

### Step 6: Install and Verify Symlink

```bash
npm install
ls node_modules/@pi-unipi/<name>/index.ts  # Must exist
```

Expected: Symlinked package has root `index.ts`.

### Step 7: Add Info-Screen Registration (if missing)

If the package doesn't already register an info-screen group, add this to its `src/index.ts`:

```typescript
// Register info-screen group
const globalObj = globalThis as any;
const registry = globalObj.__unipi_info_registry;
if (registry) {
  registry.registerGroup({
    id: "<name>",           // Unique group ID
    name: "<Display Name>", // Human-readable name
    icon: "📦",             // Emoji icon
    priority: <number>,     // Lower = higher in list (10-120)
    config: {
      showByDefault: true,
      stats: [
        { id: "stat1", label: "Stat 1", show: true },
        { id: "stat2", label: "Stat 2", show: true },
      ],
    },
    dataProvider: async () => {
      return {
        stat1: { value: "...", detail: "..." },
        stat2: { value: "...", detail: "..." },
      };
    },
  });
}
```

Expected: Info-screen group registered with stats.

### Step 8: Add Footer Registration (if package has live data)

If the package exposes live stats or status data, register a footer group in its `src/index.ts`:

```typescript
// Register footer group
const globalObj = globalThis as any;
const footerRegistry = globalObj.__unipi_footer_registry;
if (footerRegistry) {
  footerRegistry.registerGroup({
    id: "<name>",           // Unique group ID
    name: "<Display Name>", // Human-readable name
    icon: "📦",             // Emoji icon
    priority: <number>,     // Lower = leftmost in footer
    segments: [
      { id: "seg1", label: "Seg 1", show: true },
      { id: "seg2", label: "Seg 2", show: true },
    ],
    dataProvider: async () => {
      return {
        seg1: { value: "...", detail: "..." },
        seg2: { value: "...", detail: "..." },
      };
    },
  });
}
```

**Footer vs Info-Screen:**
- **Footer** — compact live stats in the status bar (bottom of screen). Use for: counts, status indicators, quick metrics.
- **Info-screen** — detailed dashboard overlay (full screen). Use for: comprehensive stats, configuration status, health checks.

Some packages register both (e.g., `compactor`, `memory`). Some only need one. Choose based on what data you expose.

Expected: Footer group registered with segments (if applicable).

### Step 9: Emit Module Ready Event

In the package's `src/index.ts`, emit the module ready event:

```typescript
import { MODULES, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";

// At end of extension function:
emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.<NAME>,     // Must exist in core constants.ts (Step 3)
  version: "0.1.0",
  commands: ["unipi:cmd1", "unipi:cmd2"],  // Full unipi: prefix
  tools: [],
});
```

Expected: Module ready event emitted with commands list.

### Step 10: Verify Registration

Run type check:
```bash
npx tsc --noEmit
```

Expected: No errors.

Expected: Info screen shows the new module with its stats. Footer shows the new module's segments (if registered).

### Step 11: Report Results

Report the final state:

```
## Registration Complete: <package-name>

### Commands Registered (X total)
- unipi:<cmd1> — <description>
- unipi:<cmd2> — <description>

### Info-Screen Group
- ID: <name>
- Display: <icon> <Display Name>
- Stats: stat1, stat2, ...

### Files Modified
- packages/<name>/index.ts (root barrel — NEW)
- packages/core/constants.ts (MODULES entry)
- packages/autocomplete/src/constants.ts (5 updates)
- packages/unipi/index.ts (import + call)
- packages/<name>/src/index.ts (info-screen + footer + module ready)
```

## Failure Handling

If verification fails:
1. **Command doesn't appear / outputs as string:** Check `pi.registerCommand()` uses full `unipi:` prefix
2. **Module not found (TS2307):** Check root `index.ts` barrel file exists and re-exports `./src/index.ts`
3. **Check `packages/autocomplete/src/constants.ts`** — all 5 structures updated?
4. **Check `packages/unipi/index.ts`** — import and call present?
5. **Check package's `src/index.ts`** — info-screen registration and module ready event?
6. **Check `packages/core/constants.ts`** — MODULES entry exists?
7. If error persists after 2 attempts, report to user with full error output.

## Post-conditions

After successful completion:
- [ ] Root `index.ts` barrel file exists at package root
- [ ] All commands registered with `unipi:` prefix in `pi.registerCommand()`
- [ ] All commands in COMMAND_REGISTRY with correct package mapping
- [ ] PACKAGE_ORDER, PACKAGE_COLORS, PACKAGE_LABELS updated
- [ ] COMMAND_DESCRIPTIONS populated for all new commands
- [ ] MODULES entry in `packages/core/constants.ts`
- [ ] Package imported and called in `packages/unipi/index.ts`
- [ ] Info-screen group registered with stats
- [ ] Module ready event emitted
- [ ] Type check passes (`npx tsc --noEmit`)

## Notes

- **Root barrel file is CRITICAL:** Without `packages/<name>/index.ts`, the extension silently fails to load. This is the #1 registration bug.
- **Command prefix is CRITICAL:** `pi.registerCommand("cmd")` creates `/cmd`, not `/unipi:cmd`. Always use `"unipi:cmd"` or `\`${UNIPI_PREFIX}cmd\``.
- **5 places in constants.ts**: PACKAGE_ORDER, PACKAGE_COLORS, COMMAND_REGISTRY, COMMAND_DESCRIPTIONS, PACKAGE_LABELS
- **Color palette**: Avoid duplicating existing colors — check PACKAGE_COLORS before assigning
- **Priority convention**: workflow=10, ralph=20, memory=30, milestone=40, mcp=50, utility=60, ask-user=70, info=80, web-api=90, compact=100, notify=110, kanboard=120, input-shortcuts=115
- **Info-screen is optional**: Some packages (like workflow, command-enchantment) don't need info-screen groups
- **Footer is optional**: Only packages with live stats/status need footer groups
- **MODULES constant**: Must exist in `packages/core/constants.ts` for event emission — add if missing

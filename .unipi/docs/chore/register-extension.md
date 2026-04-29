---
name: register-extension
type: maintenance
description: Register a new Unipi extension into command registry, info-screen, and unipi package
created: 2026-04-29
---

# Register Extension

Register a new Unipi extension into all required registries. This is the canonical guide for adding a new package to the Unipi monorepo — avoids re-researching registration points each time.

## Pre-conditions

Before running this chore, ensure:
- [ ] New package exists under `packages/<name>/`
- [ ] Package has an `index.ts` entry point that exports a default function accepting `ExtensionAPI`
- [ ] Package registers its commands via `pi.registerCommand()` in its own code
- [ ] On main branch

## Steps

### Step 1: Read the New Package

Read the package's `index.ts` and any `commands.ts` to extract:
- Package name (kebab-case, e.g., `my-package`)
- All commands it registers (e.g., `unipi:my-cmd`, `unipi:my-cmd-settings`)
- Whether it already has info-screen registration

```bash
cat packages/<name>/index.ts
cat packages/<name>/commands.ts  # if exists
```

Expected: List of all command names and info-screen registration status.

### Step 2: Update Command Registry (6 places)

All changes go in `packages/autocomplete/src/constants.ts`:

#### 2a. PACKAGE_ORDER
Add the package name to the array (order by display priority):
```typescript
export const PACKAGE_ORDER: string[] = [
  // ... existing packages ...
  "<name>",  // Add here
];
```

#### 2b. PACKAGE_COLORS
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

#### 2c. COMMAND_REGISTRY
Map each command to the package:
```typescript
export const COMMAND_REGISTRY: Record<string, string> = {
  // ... existing ...
  "unipi:<cmd1>": "<name>",
  "unipi:<cmd2>": "<name>",
};
```

#### 2d. COMMAND_DESCRIPTIONS
Add short descriptions for each command:
```typescript
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  // ... existing ...
  "unipi:<cmd1>": "Short description of cmd1",
  "unipi:<cmd2>": "Short description of cmd2",
};
```

#### 2e. PACKAGE_LABELS
Add pretty name for display:
```typescript
export const PACKAGE_LABELS: Record<string, string> = {
  // ... existing ...
  "<name>": "<name>",
};
```

Expected: All 5 data structures updated with new package and its commands.

### Step 3: Update Unipi Package Entry

In `packages/unipi/index.ts`, add import and call:

```typescript
import <importName> from "@pi-unipi/<name>";

export default function (pi: ExtensionAPI) {
  // ... existing ...
  <importName>(pi);
}
```

Expected: Package imported and called in the all-in-one entry point.

### Step 4: Add Info-Screen Registration (if missing)

If the package doesn't already register an info-screen group, add this to its `index.ts`:

```typescript
// Register info-screen group
const globalObj = globalThis as any;
const registry = globalObj.__unipi_info_registry;
if (registry) {
  registry.registerGroup({
    id: "<name>",           // Unique group ID
    name: "<Display Name>", // Human-readable name
    icon: "📦",             // Emoji icon
    priority: <number>,     // Lower = higher in list (10-100)
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

### Step 5: Emit Module Ready Event

In the package's `index.ts`, emit the module ready event:

```typescript
import { MODULES, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";

// At end of extension function:
emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.<NAME>,     // Must exist in core constants.ts
  version: "0.1.0",
  commands: ["unipi:cmd1", "unipi:cmd2"],
  tools: [],
});
```

If `MODULES.<NAME>` doesn't exist, add it to `packages/core/constants.ts`.

Expected: Module ready event emitted with commands list.

### Step 6: Verify Registration

Run the unipi entry point to verify:

```bash
pi --no-extensions --no-skills -e packages/unipi/index.ts --command "unipi:info"
```

Expected: Info screen shows the new module with its stats.

Also verify autocomplete:
```bash
pi --no-extensions --no-skills -e packages/unipi/index.ts
# Then type /unipi: and check autocomplete shows new commands
```

Expected: New commands appear in autocomplete with correct package label and color.

### Step 7: Report Results

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
- packages/autocomplete/src/constants.ts (5 updates)
- packages/unipi/index.ts (import + call)
- packages/<name>/index.ts (info-screen + module ready)
```

## Failure Handling

If verification fails:
1. Check `packages/autocomplete/src/constants.ts` — all 5 structures updated?
2. Check `packages/unipi/index.ts` — import and call present?
3. Check package's `index.ts` — info-screen registration and module ready event?
4. Check `packages/core/constants.ts` — MODULES entry exists?
5. If error persists after 2 attempts, report to user with full error output.

## Post-conditions

After successful completion:
- [ ] All commands in COMMAND_REGISTRY with correct package mapping
- [ ] PACKAGE_ORDER, PACKAGE_COLORS, PACKAGE_LABELS updated
- [ ] COMMAND_DESCRIPTIONS populated for all new commands
- [ ] Package imported and called in unipi/index.ts
- [ ] Info-screen group registered with stats
- [ ] Module ready event emitted
- [ ] Verification passed (info screen shows module, autocomplete works)

## Notes

- **6 places in constants.ts**: PACKAGE_ORDER, PACKAGE_COLORS, COMMAND_REGISTRY, COMMAND_DESCRIPTIONS, PACKAGE_LABELS (5 data structures)
- **Color palette**: Avoid duplicating existing colors — check PACKAGE_COLORS before assigning
- **Priority convention**: workflow=10, ralph=20, memory=30, milestone=40, mcp=50, utility=60, ask-user=70, info=80, web-api=90, compact=100, notify=110, kanboard=120
- **Info-screen is optional**: Some packages (like workflow, command-enchantment) don't need info-screen groups
- **MODULES constant**: Must exist in `packages/core/constants.ts` for event emission — add if missing

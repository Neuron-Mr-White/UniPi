# @pi-unipi/core

Shared infrastructure for every Unipi package. Provides constants, event types, and utility functions so packages can discover each other without tight coupling.

Other packages import from `@pi-unipi/core` to emit events, read module names, and use common file operations. Without it, each package would need its own event definitions and utilities.

## Usage

```typescript
import { UNIPI_EVENTS, MODULES, sanitize, emitEvent } from "@pi-unipi/core";

// Emit module ready event
emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.WORKFLOW,
  version: "1.0.0",
  commands: ["brainstorm", "plan"],
  tools: [],
});

// Use shared utilities
const safeName = sanitize("my/feature: branch");
```

## Hints (Unicrab)

The hints system introduces **Unicrab**, a friendly pixel-crab mascot providing contextual onboarding and workflow guidance:

- **What shows when**:
  - **Startup**: One least-shown, least-recent hint on `session_start` (whatsnew hints prioritized after version upgrades; lore and whatsnew excluded from regular startup rotation).
  - **Start Screen**: If `hints.header` is enabled, a custom startup header features 22×10 (≥72 cols) or 14×6 (40–71 cols) truecolor half-block crab pixel art, colored wordmark, and random lore line.
  - **Widget**: A compact single-row hint above the editor (`<crab> <text>  <category · alt+h ›>`) rendered with a 7-column half-block mascot in truecolor/256-color (or opt-in Kitty image mode).
  - **Events**: Contextual hints triggered by derived thresholds (`hints:context-high`, `hints:long-bash`, `hints:tool-errors`, `hints:long-prompt`, `hints:remember`, `hints:image-input`) and bus events. Capped at 4 event hints per session; never replaces a hint shown in the same turn.
- **Shortcuts**:
  - `Alt+H`: Cycle to the next startup hint (ordered least-shown first).
  - `Alt+Shift+H`: Navigate backward in the session hint history stack.
- **Commands**:
  - `/unipi:hint`: Opens an interactive hub-kit overlay browser with live filtering, category headers, and seen/unseen/learned status tags.
  - `/unipi:hint next`: Same as Alt+H.
  - `/unipi:hint reset`: Resets show counts and learned state in `~/.unipi/global/hints/hints.json`.
- **Settings (`hints` namespace)**:
  - `hints.enabled` (boolean, default true)
  - `hints.header` (boolean, default true): Unicrab start screen banner.
  - `hints.crab` (enum: `auto` | `blocks` | `image`, default `auto`): `auto` resolves to half-blocks; `image` is opt-in experimental Kitty terminal graphics.
  - `hints.reset` (action): Clears hint history.
- **Lines (`src/hints/lines.ts`)**:
  - Central lines file containing audited hints across command, shortcut, setting, capability, explain, trouble, whatsnew, workflow, and lore categories.
  - **Rule**: Every named command, key, setting, or tool must be strictly verified against package source code before inclusion.

## Exports

### Constants

- `UNIPI_PREFIX` — Command prefix (`unipi:`)
- `MODULES` — All module names
- `WORKFLOW_COMMANDS` — Workflow command names
- `RALPH_COMMANDS` — Ralph command names
- `RALPH_TOOLS` — Ralph tool names
- `RALPH_DEFAULTS` — Default ralph settings
- `RALPH_DIR` — Ralph state directory
- `RALPH_COMPLETE_MARKER` — Loop completion marker

### Events

- `UNIPI_EVENTS` — Event names
- `UnipiModuleEvent` — Module ready/gone payload
- `UnipiWorkflowEvent` — Workflow start/end payload
- `UnipiRalphLoopEvent` — Ralph loop start/end payload
- `UnipiRalphIterationEvent` — Ralph iteration payload
- `UnipiStatusRequestEvent` / `UnipiStatusResponseEvent` — Status payloads

### Utilities

- `sanitize(name)` — Sanitize string for filenames
- `ensureDir(path)` — Create parent directories
- `tryDelete(path)` — Safe file deletion
- `tryRead(path)` — Safe file read
- `safeMtimeMs(path)` — File modification time
- `tryRemoveDir(path)` — Safe directory removal
- `resolvePath(cwd, path)` — Resolve relative/absolute paths
- `fileExists(path)` — Check file existence
- `writeFile(path, content)` — Write file with dir creation
- `readJson<T>(path)` — Read JSON file
- `writeJson(path, data)` — Write JSON file
- `randomId(length)` — Generate random ID
- `now()` — ISO timestamp
- `parseArgs(str)` — Parse quoted arguments
- `getPackageVersion(dir)` — Read package version
- `isModuleAvailable(cwd, name)` — Check if npm module exists
- `emitEvent(pi, name, payload)` — Safe event emission

## How Packages Use Core

Every Unipi package depends on `@pi-unipi/core`. On load, each package:

1. Imports `MODULES` to register its own name
2. Imports `UNIPI_EVENTS` to subscribe to lifecycle events
3. Calls `emitEvent(pi, UNIPI_EVENTS.MODULE_READY, ...)` to announce itself
4. Uses utility functions for file I/O and path resolution

This creates a loose coupling — packages discover each other through events, not direct imports.

## Configuration

Core has no configuration. It's a pure utility layer.

## License

MIT

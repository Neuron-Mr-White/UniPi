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

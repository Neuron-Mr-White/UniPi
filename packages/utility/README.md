# @pi-unipi/utility

Comprehensive utility suite for the Pi coding agent — part of the Unipi extension suite.

## Features

### Commands

| Command | Description |
|---------|-------------|
| `/unipi:continue` | Continue agent without polluting context |
| `/unipi:reload` | Explain how to reload extensions |
| `/unipi:status` | Show status of all unipi modules |
| `/unipi:cleanup` | Clean stale DBs, temp files, old sessions |
| `/unipi:env` | Show environment info (Node, Pi, OS, paths) |
| `/unipi:doctor` | Run diagnostics across all modules |

### Tools

| Tool | Description |
|------|-------------|
| `ctx_batch` | Atomic batch execution with rollback support |
| `ctx_env` | Environment inspection for debugging |

### Modules (Programmatic API)

| Module | Path | Description |
|--------|------|-------------|
| **ProcessLifecycle** | `lifecycle/process` | Parent PID polling, orphan detection, signal handlers, cleanup registry |
| **cleanupStale** | `lifecycle/cleanup` | Stale DB/temp/session/cache cleanup with dry-run support |
| **TTLCache** | `cache/ttl-cache` | Memory or SQLite-backed TTL cache with auto-expiration |
| **AnalyticsCollector** | `analytics/collector` | Privacy-respecting event collection with daily rollup |
| **runDiagnostics** | `diagnostics/engine` | Cross-module health checks with plugin architecture |
| **detectCapabilities** | `display/capabilities` | Terminal feature detection (color, Nerd Font, unicode) |
| **Width Utilities** | `display/width` | ANSI-aware clamp, wrap, collapse, pad, center |
| **SettingsInspector** | `tui/settings-inspector` | Reusable settings overlay data model |

## Installation

```bash
pi install npm:@pi-unipi/utility
```

Or install the full Unipi suite:

```bash
pi install npm:@pi-unipi/unipi
```

## Usage

### Commands

```
/unipi:continue           # Resume agent cleanly
/unipi:cleanup             # Clean stale files
/unipi:cleanup --dry-run   # Preview what would be cleaned
/unipi:env                 # Show environment
/unipi:doctor              # Run diagnostics
```

### Batch Execution (Code)

```typescript
import { BatchBuilder } from "@pi-unipi/utility/tools/batch";

const report = await new BatchBuilder()
  .addCommand("search", { query: "refactor" })
  .addTool("memory_search", { query: "patterns" })
  .withOptions({ failFast: true, commandTimeoutMs: 30000 })
  .execute(myExecutor);

if (!report.success) {
  console.log("Failed:", report.results.find(r => !r.success)?.error);
}
```

### TTL Cache (Code)

```typescript
import { TTLCache } from "@pi-unipi/utility/cache/ttl-cache";

const cache = new TTLCache({ defaultTtlMs: 60000 });
await cache.set("key", { data: "value" });
const value = await cache.get("key");
```

### Diagnostics (Code)

```typescript
import { runDiagnostics, formatDiagnosticsReport } from "@pi-unipi/utility/diagnostics/engine";

const report = await runDiagnostics();
console.log(formatDiagnosticsReport(report));
```

### Terminal Capabilities (Code)

```typescript
import { detectCapabilities, getIcon } from "@pi-unipi/utility/display/capabilities";

const caps = detectCapabilities();
console.log("Nerd Font:", caps.nerdFont);
console.log(getIcon("󰘳", "[OK]")); // Uses Nerd Font if available
```

## Architecture

```
packages/utility/src/
├── index.ts              # Extension entry point
├── commands.ts           # Command registration
├── types.ts              # Shared types
├── info-screen.ts        # Info-screen integration
├── lifecycle/
│   ├── process.ts        # Process lifecycle manager
│   └── cleanup.ts        # Stale cleanup utility
├── cache/
│   └── ttl-cache.ts      # TTL cache (memory + SQLite)
├── analytics/
│   └── collector.ts      # Event collection + rollup
├── diagnostics/
│   └── engine.ts         # Health check engine
├── display/
│   ├── capabilities.ts   # Terminal detection
│   └── width.ts          # Width utilities
├── tui/
│   └── settings-inspector.ts  # Settings overlay model
└── tools/
    ├── batch.ts          # Batch execution
    └── env.ts            # Environment info
```

## Privacy

The analytics collector is **privacy-respecting** by design:
- No file contents are recorded
- No sensitive data (API keys, tokens, passwords) — redacted automatically
- Strings truncated to 500 characters
- All data stays local (in-memory by default, optional SQLite)

## Dependencies

- `@pi-unipi/core` — Shared constants, events, utilities
- `@mariozechner/pi-coding-agent` — Pi extension API
- `@sinclair/typebox` — Schema validation (peer dependency)
- `sqlite3` — Optional, for persistent cache/analytics

## License

MIT

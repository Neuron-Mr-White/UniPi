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
| `/unipi:name-badge` | Toggle name badge overlay (shows session name) |
| `/unipi:badge-gen` | Generate session name via LLM and enable badge |
| `/unipi:util-settings` | **Unified settings** — badge + diff rendering config |
| `/unipi:badge-settings` | Settings overlay (deprecated alias for `/unipi:util-settings`) |

### Tools

| Tool | Description |
|------|-------------|
| `ctx_batch` | Atomic batch execution with rollback support |
| `ctx_env` | Environment inspection for debugging |
| `write` | Write file with **syntax-highlighted diff** (when diff enabled) |
| `edit` | Edit file with **split/unified diff view** (when diff enabled) |

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

### Name Badge

```
/unipi:name-badge          # Toggle the session name badge on/off
/unipi:badge-gen           # Generate a session name via LLM
```

The badge is a persistent HUD overlay in the top-right corner showing the current session name.
It auto-restores visibility on session restart.

### Diff Rendering

Shiki-powered, syntax-highlighted diffs for `write` and `edit` tool output. When enabled, the default tools are replaced with enhanced versions that show side-by-side or stacked diffs with syntax highlighting.

**Features:**
- Split view (side-by-side) for `edit` tool, auto-falls back to unified on narrow terminals
- Unified view (stacked single-column) for `write` tool overwrites
- 4 color presets: default, midnight, subtle, neon
- LRU cache (192 entries) for Shiki highlights
- Large diff fallback (skip highlighting above 80k chars)
- Environment variable color overrides (`DIFF_ADD_BG`, `DIFF_REM_BG`, etc.)

**Configuration:**

```
/unipi:util-settings        # Open unified settings TUI
```

Or edit `.unipi/config/util-settings.json` directly:

```json
{
  "diff": {
    "enabled": true,
    "theme": "default",
    "shikiTheme": "github-dark",
    "splitMinWidth": 150
  }
}
```

**Diff themes:** default, midnight, subtle, neon
**Shiki themes:** github-dark, dracula, one-dark-pro, catppuccin-mocha, nord, tokyo-night, and more

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
├── diff/
│   ├── settings.ts       # Unified settings (badge + diff) read/write + migration
│   ├── theme.ts          # Diff color presets, resolution chain, hex ↔ ANSI
│   ├── parser.ts         # Diff parsing (structuredPatch, word diff analysis)
│   ├── highlighter.ts    # Shiki singleton, LRU cache, language detection
│   ├── renderer.ts       # Split/unified renderers, ANSI utilities
│   └── wrapper.ts        # write/edit tool wrapping with diff output
├── tui/
│   ├── settings-inspector.ts  # Settings overlay model
│   ├── name-badge.ts          # Name badge overlay component
│   ├── name-badge-state.ts    # Name badge state manager
│   ├── badge-settings.ts      # Badge settings (thin wrapper over diff/settings)
│   └── util-settings-tui.ts  # Unified settings TUI (badge + diff)
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
- `diff` — Unified diff generation (for diff rendering)
- `@shikijs/cli` — Shiki syntax highlighting (for diff rendering)
- `sqlite3` — Optional, for persistent cache/analytics

### Dev Dependencies

- `@types/diff` — TypeScript types for the diff library

## License

MIT

# @pi-unipi/utility

Environment info, diagnostics, cleanup, name badge, and diff rendering. The grab-bag package for maintaining your development environment and making tool output readable.

The diff rendering is the standout feature — Shiki-powered syntax-highlighted diffs for `write` and `edit` tool output. Side-by-side view for edits, unified view for writes, with color presets and auto-fallback on narrow terminals.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:env` | Show environment info (Node, Pi, OS, paths) |
| `/unipi:doctor` | Run diagnostics across all modules |
| `/unipi:status` | Show status of all unipi modules |
| `/unipi:cleanup` | Clean stale DBs, temp files, old sessions |
| `/unipi:reload` | Explain how to reload extensions |
| `/unipi:name-badge` | Toggle name badge overlay |
| `/unipi:badge-gen` | Generate session name via LLM and enable badge |
| `/unipi:util-settings` | Unified settings for badge and diff rendering |

### Examples

```
/unipi:env                 # Show environment
/unipi:doctor              # Run diagnostics
/unipi:cleanup             # Clean stale files
/unipi:cleanup --dry-run   # Preview what would be cleaned
/unipi:name-badge          # Toggle the session name badge
/unipi:badge-gen           # Generate a session name via LLM
```

## Special Triggers

Utility registers with the info-screen dashboard, showing module status and diagnostic results. The footer subscribes to utility events for its extension status segment.

The diff rendering feature wraps Pi's built-in `write` and `edit` tools. When enabled, these tools show syntax-highlighted diffs instead of plain output. This is a transparent replacement — the agent doesn't need to know about it.

## Agent Tools

| Tool | Description |
|------|-------------|
| `ctx_batch` | Atomic batch execution with rollback support |
| `ctx_env` | Environment inspection for debugging |
| `write` | Write file with syntax-highlighted diff (when diff enabled) |
| `edit` | Edit file with split/unified diff view (when diff enabled) |

### Batch Execution

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

## Configurables

### Diff Rendering

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

| Setting | Default | Options |
|---------|---------|---------|
| `enabled` | true | true/false |
| `theme` | "default" | default, midnight, subtle, neon |
| `shikiTheme` | "github-dark" | github-dark, dracula, one-dark-pro, catppuccin-mocha, nord, tokyo-night |
| `splitMinWidth` | 150 | Minimum terminal width for split view |

Environment variable overrides: `DIFF_ADD_BG`, `DIFF_REM_BG`, etc.

Features:
- Split view (side-by-side) for `edit`, auto-falls back to unified on narrow terminals
- Unified view (stacked) for `write` overwrites
- LRU cache (192 entries) for Shiki highlights
- Large diff fallback (skip highlighting above 80k chars)

### Name Badge

The badge is a persistent HUD overlay in the top-right corner showing the current session name. It auto-restores visibility on session restart.

## Programmatic API

| Module | Path | Description |
|--------|------|-------------|
| ProcessLifecycle | `lifecycle/process` | Parent PID polling, orphan detection, signal handlers |
| cleanupStale | `lifecycle/cleanup` | Stale DB/temp/session/cache cleanup with dry-run |
| TTLCache | `cache/ttl-cache` | Memory or SQLite-backed TTL cache |
| AnalyticsCollector | `analytics/collector` | Privacy-respecting event collection with daily rollup |
| runDiagnostics | `diagnostics/engine` | Cross-module health checks with plugin architecture |
| detectCapabilities | `display/capabilities` | Terminal feature detection (color, Nerd Font, unicode) |
| Width Utilities | `display/width` | ANSI-aware clamp, wrap, collapse, pad, center |

### TTL Cache

```typescript
import { TTLCache } from "@pi-unipi/utility/cache/ttl-cache";

const cache = new TTLCache({ defaultTtlMs: 60000 });
await cache.set("key", { data: "value" });
const value = await cache.get("key");
```

### Terminal Capabilities

```typescript
import { detectCapabilities, getIcon } from "@pi-unipi/utility/display/capabilities";

const caps = detectCapabilities();
console.log("Nerd Font:", caps.nerdFont);
console.log(getIcon("󰘳", "[OK]")); // Uses Nerd Font if available
```

## Privacy

The analytics collector is privacy-respecting:
- No file contents recorded
- No sensitive data (API keys, tokens, passwords) — redacted automatically
- Strings truncated to 500 characters
- All data stays local

## License

MIT

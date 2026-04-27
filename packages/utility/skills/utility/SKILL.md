---
name: utility
scope: agent
description: |
  Guidance for using the @pi-unipi/utility extension commands and tools.
  Provides lifecycle management, diagnostics, cleanup, batch execution,
  environment inspection, and terminal utilities.
---

# @pi-unipi/utility — Agent Guidance

## Overview

The `@pi-unipi/utility` extension provides general-purpose utilities for the Pi coding agent. It is **not** related to compaction — it provides helpers that any module or agent can use.

## Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/unipi:continue` | Continue agent without polluting context | After interruption, to resume cleanly |
| `/unipi:reload` | Explain how to reload extensions | When user asks about hot-reloading |
| `/unipi:status` | Request status from all modules | To check which modules are loaded |
| `/unipi:cleanup` | Clean stale files, DBs, sessions | When disk space is low or after crashes |
| `/unipi:env` | Show environment info | For debugging version/path issues |
| `/unipi:doctor` | Run diagnostics | When something seems broken |

### Cleanup Options

- `--dry-run` — Report what would be cleaned without removing anything
- Default max ages: DBs 14 days, temp 7 days, sessions 30 days

## Tools

| Tool | Purpose |
|------|---------|
| `ctx_batch` | Atomic batch execution of commands with rollback |
| `ctx_env` | Environment inspection |

### Batch Execution Pattern

```typescript
import { BatchBuilder } from "@pi-unipi/utility/tools/batch";

const report = await new BatchBuilder()
  .addCommand("search", { query: "foo" })
  .addTool("memory_search", { query: "bar" })
  .withOptions({ failFast: true, commandTimeoutMs: 30000 })
  .execute(myExecutor);
```

## Modules (for code use)

| Module | Import Path | Purpose |
|--------|-------------|---------|
| ProcessLifecycle | `@pi-unipi/utility/lifecycle/process` | Parent PID polling, orphan detection, cleanup registry |
| cleanupStale | `@pi-unipi/utility/lifecycle/cleanup` | Stale file/DB/session cleanup |
| TTLCache | `@pi-unipi/utility/cache/ttl-cache` | In-memory or SQLite-backed TTL cache |
| AnalyticsCollector | `@pi-unipi/utility/analytics/collector` | Privacy-respecting event collection |
| runDiagnostics | `@pi-unipi/utility/diagnostics/engine` | Cross-module health checks |
| detectCapabilities | `@pi-unipi/utility/display/capabilities` | Terminal feature detection |
| clampWidth, wrapLines | `@pi-unipi/utility/display/width` | ANSI-aware text formatting |
| SettingsInspector | `@pi-unipi/utility/tui/settings-inspector` | Reusable settings overlay model |

## Integration Notes

- Lifecycle manager is a singleton — use `getLifecycle()` to access
- Analytics collector is a singleton — use `getAnalyticsCollector()`
- Diagnostics engine supports custom plugins via `registerDiagnosticPlugin()`
- TTLCache defaults to memory backend; set `persistent: true` for SQLite
- All modules emit unipi events for cross-module integration

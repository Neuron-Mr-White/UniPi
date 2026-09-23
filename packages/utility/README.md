# @pi-unipi/utility

Environment info, diagnostics, cleanup, and the session name badge. The grab-bag package for maintaining your development environment and keeping an eye on provider cache behavior.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:env` | Show environment info (Node, Pi, OS, paths) |
| `/unipi:doctor` | Run diagnostics across all modules |
| `/unipi:status` | Show immediate guidance to the live `/unipi:info` dashboard and `/unipi:doctor` diagnostics |
| `/unipi:cleanup` | Clean stale DBs, temp files, old sessions |
| `/unipi:reload` | Explain how to reload extensions |
| `/unipi:name-badge` | Toggle name badge overlay |
| `/unipi:settings` | Badge field + "Set/Generate session name" actions (Utility group) |
| `/unipi:settings` | Hub — badge behavior (Utility group) |
| `/unipi:prefix-cache` | Show privacy-safe request-prefix transitions and provider cache token counters |

### Examples

```
/unipi:env                 # Show environment
/unipi:doctor              # Run diagnostics
/unipi:cleanup             # Clean stale files
/unipi:cleanup --dry-run   # Preview what would be cleaned
/unipi:name-badge          # Toggle the session name badge
/unipi:settings            # → Utility → "Generate session name"
```

## Special Triggers

Utility registers with the info-screen dashboard, showing module status and diagnostic results. The footer subscribes to utility events for its extension status segment. When Herdr is present, the badge module syncs the session name to the pane title.

## Provider prefix-cache diagnostics

`/unipi:prefix-cache` observes Pi's provider-native request payloads without modifying them. It reports session-local cache epochs, exact structural prefix extensions, retries, request-envelope/history boundaries, and provider-reported `cacheRead`/`cacheWrite` token totals.

The fingerprints are keyed HMAC-SHA-256 values using a random in-memory key that is discarded on reload. Raw prompts, messages, tool arguments, tool schemas, and provider payloads are never retained or logged by this diagnostic. Fingerprints therefore cannot be compared across process lifetimes. A reported prefix extension means the request is structurally eligible for reuse; provider TTL, routing, and cache policy still decide whether a hit occurs.

`/unipi:cleanup` includes private `~/.unipi/tool-results/` artifacts in the normal temporary-file retention policy (7 days by default). Use dry-run mode to review candidates before deletion.

## Agent Tools

| Tool | Description |
|------|-------------|
| `ctx_env` | Environment inspection for debugging |
| `set_session_name` | Set the session name for badge display (when badge agent-tool is enabled) |

## Configurables

### Name Badge

```
/unipi:settings              # Badge + skills discovery (Utility group)
```

Or edit `.unipi/config/util-settings.json` directly (migrated automatically from the legacy `.unipi/config/badge.json` on first read):

```json
{
  "badge": {
    "badgeEnabled": true
  }
}
```

The badge is a persistent HUD overlay in the top-right corner showing the current session name. It auto-restores visibility on session restart.

### Skill Exposure (jev-judged)

Controls which discovered skills are cataloged in the agent's system prompt. Configure via `/unipi:settings` (Skills group) or the engine file (`skills` subtree):

- **mode: `judged`** (default) — on the session's first prompt, if more than `maxSkills` skills are discovered, ONE jev (TypeSafe System One) request scores every skill's relevance to your prompt; only relevant ones stay cataloged, sorted by relevance and capped. The set is frozen per session and persisted, so the system prompt is byte-identical on every later turn (provider prefix cache stays intact).
- **mode: `all`** — no judging; every skill stays.
- **mode: `off`** — Unipi's bundled skills are stripped from the catalog (old `discovery: false` behavior).

Extra knobs: `threshold` (min jev relevance, default 0.3), `maxSkills` (cap, default 12), `recheck` (default on — later prompts on new topics get a "newly relevant skills" message revealing up to 5 hidden skills; revealed skills are never announced twice, and the system prompt itself never changes after the freeze).

Skills stay invocable in every mode via `/skill:name` or by reading their SKILL.md directly. The judged set reuses the long-horizon **Decision model** (jev) — provider, model, key and base URL come from the Judge settings; missing key, timeout, or any failure exposes ALL skills (fail-open).

```json
{
  "skills": { "mode": "judged", "threshold": 0.3, "maxSkills": 12, "recheck": true }
}
```

## Programmatic API

| Module | Path | Description |
|--------|------|-------------|
| ProcessLifecycle | `lifecycle/process` | Parent PID polling, orphan detection, signal handlers |
| cleanupStale | `lifecycle/cleanup` | Stale DB/temp/session cleanup with dry-run |
| AnalyticsCollector | `analytics/collector` | Privacy-respecting event collection with daily rollup |
| runDiagnostics | `diagnostics/engine` | Cross-module health checks with plugin architecture |

## Privacy

The analytics collector is privacy-respecting:
- No file contents recorded
- No sensitive data (API keys, tokens, passwords) — redacted automatically
- Strings truncated to 500 characters
- All data stays local

## License

MIT

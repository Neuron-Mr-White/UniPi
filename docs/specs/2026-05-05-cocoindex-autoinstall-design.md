---
title: "CocoIndex Auto-Install"
type: brainstorm
date: 2026-05-05
---

# CocoIndex Auto-Install

## Problem Statement

CocoIndex onboarding requires manual installation of Python, pip, and `cocoindex[lancedb]`. Users who run `/unipi:cocoindex-init` get a bare "pip install cocoindex" error message and must figure out the dependency chain themselves. This friction causes drop-off and confusion, especially for users without Python experience.

## Context

- **Current error handling** (`commands.ts`): Shows `pip install cocoindex` / `pip install 'cocoindex[lancedb]'` as plain text. No auto-detection or installation.
- **Current CLI detection** (`bridge.ts`): `resolveCocoindexBin()` scans `~/.local/share/mise/installs/python/*/bin/cocoindex` and PATH. `isAvailable()` checks `cocoindex --version`.
- **Environment**: Pi itself runs from `~/.local/share/mise/installs/node/`. Most users already have mise. `uv` is a fast Rust-based Python package manager that doesn't require Python to run. `uv tool install` creates isolated venvs and exposes CLI binaries in `~/.local/bin/`.
- **Version**: CocoIndex v1.0+ is required (v1.0 introduced the `cocoindex.App` API used by our pipeline template).

## Chosen Approach

**Approach B: Dedicated `installer.ts` module** in the cocoindex package with consent-based inline prompts.

Install chain: `uv tool install 'cocoindex[lancedb]>=1.0'` (primary), with fallback to `mise use -g uv` → `uv tool install` if uv is missing, and shell-aware manual instructions if both are missing.

## Why This Approach

- **`uv tool install`** is the cleanest method: isolated venv, no system Python pollution, automatic binary exposure in `~/.local/bin/`.
- **Consent-based**: Uses `ctx.ui.confirm()` to show what will be installed before executing. No persistent consent — always asks.
- **Dedicated module**: Keeps `bridge.ts` focused on CLI interaction, makes installer logic independently testable.
- **Shell-aware fallback**: Detects `$SHELL` to offer appropriate installation instructions when automated install isn't possible.
- **Version pinning >=1.0**: Prevents API breakage from older cocoindex versions.

**Rejected alternatives:**
- All-in-bridge.ts: Would bloat bridge.ts with installation concerns.
- Shared utility in core: Premature abstraction — cocoindex is the only consumer.
- Full-auto (no consent): Too surprising for a tool that installs system packages.
- Remember consent across sessions: Adds config complexity for minimal gain.

## Design

### New File: `packages/cocoindex/installer.ts`

**Exported interface:**

```typescript
interface InstallPlan {
  steps: InstallStep[];
  summary: string; // Human-readable description for consent prompt
}

interface InstallStep {
  command: string;      // e.g., "uv tool install 'cocoindex[lancedb]>=1.0'"
  description: string;  // e.g., "Install CocoIndex CLI with LanceDB support"
  optional?: boolean;   // true for fallback steps
}

interface InstallResult {
  ok: boolean;
  binPath?: string;
  version?: string;
  error?: string;
  skipped?: boolean;  // User declined consent
}
```

**Exported functions:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `detectShell()` | `() → "bash" \| "zsh" \| "fish" \| "unknown"` | Read `$SHELL` env var |
| `hasTool(name)` | `(name: string) → boolean` | Check if CLI tool is available via `command -v` |
| `dryRun()` | `() → InstallPlan` | Compute what would be installed (no side effects) |
| `execute(plan, onProgress?)` | `(plan, (msg) => void) → Promise<InstallResult>` | Execute plan steps sequentially |
| `ensureCocoindex(ctx)` | `(ctx) → Promise<InstallResult>` | Main orchestrator: check → plan → consent → execute → verify |

**`ensureCocoindex(ctx)` flow:**

```
1. bridge.isAvailable() → true?
   - Parse version from bridge.getVersion()
   - version >= 1.0? → return { ok: true, binPath, version }
   - version < 1.0? → return { ok: false, error: "upgrade needed" }

2. Compute plan via dryRun():
   a. hasTool("uv") →
      Plan: [uv tool install 'cocoindex[lancedb]>=1.0']
   b. hasTool("mise") →
      Plan: [mise use -g uv] + [uv tool install 'cocoindex[lancedb]>=1.0']
   c. neither →
      Return { ok: false, error: "manual", instructions: [...] }

3. ctx.ui.confirm("Install CocoIndex?", plan.summary) →
   false → return { ok: false, skipped: true }
   true → proceed

4. execute(plan, (msg) => ctx.ui.setStatus("cocoindex-installer", msg))

5. Verify: bridge.isAvailable() + version check

6. ctx.ui.setStatus("cocoindex-installer", undefined) // clear
   return result
```

### Modified: `packages/cocoindex/bridge.ts`

- Add `COCOINDEX_MIN_VERSION = "1.0"` constant (or import from core constants).
- Add `parseVersion(versionStr: string): string` helper to extract semver from `cocoindex --version` output.
- No other changes — `resolveCocoindexBin()` and `isAvailable()` remain as-is.

### Modified: `packages/cocoindex/commands.ts`

**`/unipi:cocoindex-init`:**
```
Before: if (!available) { ctx.ui.notify("pip install..."); return; }
After:  const result = await ensureCocoindex(ctx);
        if (!result.ok) { /* already notified */ return; }
```

**`/unipi:cocoindex-update`:**
```
Before: if (!available) { ctx.ui.notify("pip install..."); return; }
After:  const result = await ensureCocoindex(ctx);
        if (!result.ok) { return; }
```

### Modified: `packages/cocoindex/tools.ts`

**`cocoindex_search` tool:**
When CLI not available, instead of returning empty results:
```
return [{
  title: "Search Unavailable",
  content: "CocoIndex CLI not installed. Run /unipi:cocoindex-init to install.",
  ...
}];
```

**`cocoindex_status` tool:**
When CLI not available, include install guidance in the status output.

Note: Tools don't call `ensureCocoindex()` directly because they lack `ctx.ui.confirm()`. They reference the command instead.

### Modified: `packages/core/constants.ts`

Add to the existing `COCOINDEX_TOOLS` / `COCOINDEX_COMMANDS` section:
```typescript
export const COCOINDEX_MIN_VERSION = "1.0" as const;
export const COCOINDEX_PACKAGE_SPEC = `cocoindex[lancedb]>=${COCOINDEX_MIN_VERSION}` as const;
```

### Shell Detection Logic

```typescript
function detectShell(): "bash" | "zsh" | "fish" | "unknown" {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("fish")) return "fish";
  return "unknown";
}
```

### Fallback Instructions (when neither mise nor uv available)

```
Manual installation required:

1. Install mise (tool version manager):
   curl https://mise.run | sh    # bash/zsh
   # or: https://mise.jdx.dev/getting-started.html

2. Restart your shell, then run:
   /unipi:cocoindex-init
```

### Error Handling

| Scenario | Behavior |
|----------|----------|
| `uv tool install` fails (network) | Show stderr in error, suggest retry |
| `uv tool install` fails (permission) | Show stderr, suggest `--force` or check `~/.local/bin` in PATH |
| `mise use -g uv` fails | Fall back to standalone uv installer: `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `cocoindex --version` returns < 1.0 | Show "Upgrade needed: v{current} → v1.0+". Offer: `uv tool upgrade cocoindex` |
| User declines consent | Return `{ ok: false, skipped: true }`. No further action. |
| Both mise and uv missing, shell unknown | Show generic instructions for both bash and zsh |

### Data Flow

```
User runs /unipi:cocoindex-init
  │
  ├─ commands.ts handler
  │   └─ ensureCocoindex(ctx)
  │       ├─ bridge.isAvailable() ─── false
  │       ├─ dryRun() ─── computes InstallPlan
  │       ├─ ctx.ui.confirm() ─── user says yes
  │       ├─ execute(plan) ─── spawns uv/mise commands
  │       │   ├─ execSync("mise use -g uv")     [if needed]
  │       │   └─ execSync("uv tool install ...") [main step]
  │       └─ bridge.isAvailable() ─── verify ─── true ✓
  │
  └─ initPipeline(projectDir) ─── scaffold main.py
```

## Implementation Checklist

- [x] Add `COCOINDEX_MIN_VERSION` and `COCOINDEX_PACKAGE_SPEC` constants to `core/constants.ts` — covered by Plan Task 1
- [x] Create `packages/cocoindex/installer.ts` with `detectShell()`, `hasTool()`, `dryRun()`, `execute()`, `ensureCocoindex()` — covered by Plan Tasks 2–3
- [x] Add `parseVersion()` helper to `bridge.ts` — covered by Plan Task 1
- [x] Update `/unipi:cocoindex-init` command to call `ensureCocoindex()` before `initPipeline()` — covered by Plan Task 4
- [x] Update `/unipi:cocoindex-update` command to call `ensureCocoindex()` before `indexProject()` — covered by Plan Task 4
- [x] Update `cocoindex_search` tool to show install guidance when CLI missing — covered by Plan Task 5
- [x] Update `cocoindex_status` tool to show install guidance when CLI missing — covered by Plan Task 5
- [x] Test full install chain on a clean environment (mise + uv + cocoindex) — covered by Plan Task 6
- [x] Test fallback flow when neither mise nor uv available — covered by Plan Task 6
- [x] Test consent decline path — covered by Plan Task 6
- [x] Test version rejection (cocoindex < 1.0 installed) — covered by Plan Task 6

## Open Questions

- Resolved for current plan: no standalone `/unipi:cocoindex-install` command; keep installation implicit in init/update.
- Should the `cocoindex_search` tool eventually grow a direct install trigger (e.g., returning a special result that the agent interprets as "offer to install"), or always defer to the command? Deferred; current plan keeps tools non-interactive and defers to `/unipi:cocoindex-init`.

## Out of Scope

- **Version upgrade flow**: Only handles missing/minimum version. No auto-upgrade of existing working installations.
- **Persistent consent memory**: Each session prompts fresh. No config file to remember consent.
- **Python version management**: `uv tool install` handles its own Python. We don't manage Python versions.
- **Non-LanceDB targets**: The installer assumes LanceDB. Future postgres/qdrant support would need separate handling.
- **CI/CD integration**: This is for interactive TUI use only. Non-interactive environments should pre-install cocoindex.

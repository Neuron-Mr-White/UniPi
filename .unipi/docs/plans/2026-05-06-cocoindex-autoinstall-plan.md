---
title: "CocoIndex Auto-Install — Implementation Plan"
type: plan
date: 2026-05-06
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-05-cocoindex-autoinstall-design.md
---

# CocoIndex Auto-Install — Implementation Plan

## Overview

Add a consent-based CocoIndex installer to `@pi-unipi/cocoindex` so `/unipi:cocoindex-init` and `/unipi:cocoindex-update` can guide users from a missing CLI to a working `cocoindex[lancedb]>=1.0` installation. The implementation stays implicit-only: no standalone `/unipi:cocoindex-install` command in this plan. Tools remain non-interactive and provide guidance instead of installing.

The plan also accounts for codebase-specific details found during review:

- `bridge.isAvailable()` caches results, so installation verification needs cache invalidation or an uncached check.
- `uv tool install` exposes binaries under `~/.local/bin/`; current bin resolution only checks PATH and mise Python installs.
- `resolveCocoindexBin()` is currently private, but installer results need a verified bin path.
- `packages/cocoindex/package.json` `files` must include the new `installer.ts`.

## Tasks

- completed: Task 1 — Add CocoIndex version constants and bridge detection primitives
  - Description: Establish shared package/version constants and make the bridge able to parse, compare, resolve, and re-check CocoIndex installations robustly.
  - Dependencies: None
  - Acceptance Criteria: `COCOINDEX_MIN_VERSION` and `COCOINDEX_PACKAGE_SPEC` are exported from `@pi-unipi/core`; `bridge.parseVersion()` extracts semver from CLI output; bridge can report a resolved binary path including `~/.local/bin/cocoindex`; cached availability can be reset or bypassed after install; package typecheck passes for touched files.
  - Steps:
    1. Add `COCOINDEX_MIN_VERSION = "1.0"` and `COCOINDEX_PACKAGE_SPEC = "cocoindex[lancedb]>=1.0"` near the existing CocoIndex constants in `packages/core/constants.ts`.
    2. Import the minimum version constant in `packages/cocoindex/bridge.ts` where needed.
    3. Add and export `parseVersion(versionStr: string): string | null` to extract `major.minor.patch` or `major.minor` from `cocoindex --version` output.
    4. Add a small semver comparison helper for the minimum-version gate, treating missing/invalid versions as not acceptable.
    5. Export a safe bin resolver or `getCocoindexBinPath()` wrapper; extend resolution to check `~/.local/bin/cocoindex` before falling back to `cocoindex`.
    6. Add `resetAvailabilityCache()` or an uncached availability path so post-install verification does not reuse a stale `false`.

- completed: Task 2 — Create installer module with planning, shell detection, and command execution
  - Description: Add `packages/cocoindex/installer.ts` with the pure detection/planning helpers and side-effecting executor described by the spec.
  - Dependencies: Task 1
  - Acceptance Criteria: `installer.ts` exports `InstallPlan`, `InstallStep`, `InstallResult`, `detectShell()`, `hasTool()`, `dryRun()`, and `execute()`; install plans prefer `uv`, fall back through `mise`, and produce manual instructions when neither is available; command failures preserve stderr/stdout enough for user-facing errors; no command runs without later consent from `ensureCocoindex()`.
  - Steps:
    1. Define the installer result and plan interfaces, including a way to represent manual-install instructions for the no-uv/no-mise case.
    2. Implement `detectShell()` from `process.env.SHELL` for bash, zsh, fish, and unknown.
    3. Implement `hasTool(name)` using a safe `command -v` check with timeout.
    4. Implement `dryRun()` to return `uv tool install '${COCOINDEX_PACKAGE_SPEC}'` when `uv` exists.
    5. Implement the mise fallback plan using the correct mise command form for installing/using uv (for example `mise use -g uv@latest`) followed by the `uv tool install` step.
    6. Implement manual instructions for bash/zsh/fish/unknown shells when neither `uv` nor `mise` is available.
    7. Implement `execute(plan, onProgress?)` to run steps sequentially, report progress before each step, stop on required-step failure, and return structured errors with command output.
    8. Include a fallback from failed mise installation/use of uv to the official uv installer instructions rather than silently failing.

- completed: Task 3 — Implement consent-based `ensureCocoindex(ctx)` orchestrator
  - Description: Connect bridge detection, install planning, UI confirmation, execution, version verification, and status cleanup into the installer’s main entry point.
  - Dependencies: Tasks 1 and 2
  - Acceptance Criteria: Existing CocoIndex v1.0+ returns `{ ok: true, binPath, version }` without prompting; missing CocoIndex prompts once with an understandable summary; declining returns `{ ok: false, skipped: true }`; successful install verifies with a fresh availability/version check; existing versions below v1.0 produce an upgrade-needed message and do not continue; status text is cleared after success or failure.
  - Steps:
    1. Implement an initial bridge check that reads version and compares it against `COCOINDEX_MIN_VERSION`.
    2. For an installed but too-old CLI, notify the user that v1.0+ is required and suggest `uv tool upgrade cocoindex` or reinstalling `COCOINDEX_PACKAGE_SPEC`.
    3. Build the dry-run plan for missing CLI and format a consent prompt that clearly lists packages and commands.
    4. Use `ctx.ui.confirm("Install CocoIndex?", plan.summary)` only when `ctx.hasUI`/`ctx.ui.confirm` is available; otherwise show manual instructions and return a non-ok result.
    5. On consent, call `execute()` and pipe progress to `ctx.ui.setStatus("cocoindex-installer", msg)`.
    6. Reset/bypass the bridge availability cache before verification.
    7. Verify availability and version after execution, returning `binPath` and parsed version on success.
    8. Clear `cocoindex-installer` status in a `finally` block.

- completed: Task 4 — Wire installer into interactive CocoIndex commands
  - Description: Update interactive command handlers to call `ensureCocoindex(ctx)` before operations that need the CLI, replacing the current plain pip-install message.
  - Dependencies: Task 3
  - Acceptance Criteria: `/unipi:cocoindex-init` ensures CocoIndex before scaffolding `.unipi/cocoindex/main.py`; `/unipi:cocoindex-update` ensures CocoIndex before checking/running the pipeline; user decline or install failure stops cleanly without running init/update; command status output uses the new install guidance; root/package typecheck passes.
  - Steps:
    1. Import `ensureCocoindex()` into `packages/cocoindex/commands.ts`.
    2. In `/unipi:cocoindex-init`, call `ensureCocoindex(ctx)` before `bridge.initPipeline(projectDir)` and return early on `!result.ok`.
    3. In `/unipi:cocoindex-update`, call `ensureCocoindex(ctx)` before pipeline initialization checks and return early on `!result.ok`.
    4. Update `/unipi:cocoindex-status` missing-CLI guidance from `pip install cocoindex` to `/unipi:cocoindex-init` plus manual uv/mise guidance.
    5. Update the session-start notification in `packages/cocoindex/index.ts` so missing CLI messaging points to `/unipi:cocoindex-init` instead of raw pip commands.
    6. Preserve synchronous command registration; only perform installation work inside async command handlers.

- unstarted: Task 5 — Update non-interactive tools and package exports
  - Description: Ensure tools and package metadata reflect the new installer while preserving the rule that tools do not prompt or install.
  - Dependencies: Tasks 1 and 3
  - Acceptance Criteria: `cocoindex_search` returns a clear “Search Unavailable” guidance result when the CLI is missing; `cocoindex_status` includes install guidance when unavailable; `installer.ts` is included in package publishing metadata and optionally exported from `index.ts`; no tool calls `ensureCocoindex()` directly.
  - Steps:
    1. In `packages/cocoindex/tools.ts`, check `bridge.isAvailable()` before calling `bridge.search()`.
    2. Return a guidance result for missing CLI that tells the agent/user to run `/unipi:cocoindex-init`.
    3. Add similar install guidance lines to the `cocoindex_status` tool output when `info.cliAvailable` is false.
    4. Add `installer.ts` to `packages/cocoindex/package.json` `files`.
    5. Export installer helpers from `packages/cocoindex/index.ts` if useful for tests or downstream package consumers.
    6. Keep tool descriptions accurate: tools are diagnostic/search only, commands perform interactive install.

- unstarted: Task 6 — Validate install, fallback, decline, and version paths
  - Description: Verify the implementation through typechecks and targeted scenario checks, using mocks/stubs where a clean machine is not available.
  - Dependencies: Tasks 1–5
  - Acceptance Criteria: Root `npm run typecheck` passes; `npm run typecheck --workspace=@pi-unipi/cocoindex` passes; clean-environment install path is tested or documented with evidence; no-uv/no-mise manual fallback is tested via PATH/env stubbing; consent-decline path is tested; v0.x rejection is tested; validation notes are recorded in the final work summary.
  - Steps:
    1. Run package and root typechecks.
    2. Test existing-installed path with the developer machine if CocoIndex is present.
    3. Test or simulate a clean PATH with `uv` available and no `cocoindex`, verifying the install plan summary and post-install cache reset behavior.
    4. Test or simulate neither `uv` nor `mise` available and verify shell-aware manual instructions.
    5. Test a fake `ctx.ui.confirm()` returning false and verify `{ ok: false, skipped: true }` with no executed commands.
    6. Test fake `cocoindex --version` outputs below v1.0 and malformed outputs.
    7. If true clean-environment installation cannot be run in the current session, document the limitation and exact manual command to validate later.

## Sequencing

```
Task 1 (constants + bridge detection)
  ├─→ Task 2 (installer planning/execution)
  │    └─→ Task 3 (ensureCocoindex orchestration)
  │         ├─→ Task 4 (commands integration)
  │         └─→ Task 5 (tools + package exports)
  └─→ Task 5 (tool availability guidance uses bridge primitives)
Tasks 1–5 ─→ Task 6 (validation)
```

Recommended execution order: Task 1, Task 2, Task 3, Task 4, Task 5, then Task 6. Tasks 4 and 5 can be implemented in parallel after Task 3 if the bridge/helper interfaces are stable.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Availability cache remains stale after install | User consents and install succeeds, but init/update still reports CLI missing | Task 1 explicitly adds cache reset/uncached verification and Task 3 uses it before post-install checks. |
| `uv tool install` binary not visible to Pi PATH | Install succeeds but `bridge.isAvailable()` cannot find `cocoindex` | Task 1 extends resolver to check `~/.local/bin/cocoindex`. |
| Incorrect mise command for uv | Fallback install path fails for mise users | Task 2 verifies and uses `mise use -g uv@latest` or equivalent, with fallback instructions. |
| Non-interactive command context | `ctx.ui.confirm()` may be unavailable | Task 3 detects non-interactive contexts and shows manual instructions instead of attempting install. |
| Shell quoting issues in command execution | Package spec with brackets may be interpreted incorrectly | Task 2 should prefer argv-based execution where practical, or thoroughly quote command strings. |
| Existing CocoIndex v0.x installation | Pipeline template may fail against old API | Task 3 blocks versions below `COCOINDEX_MIN_VERSION` with explicit upgrade guidance. |
| Testing clean install mutates developer machine | Validation may be risky or environment-dependent | Task 6 allows PATH/env stubs and records any manual validation that could not be safely performed. |

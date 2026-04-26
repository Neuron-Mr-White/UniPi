---
title: "Unipi Architecture — All-in-One Pi Extension Suite"
type: brainstorm
date: 2026-04-26
participants: [user, MiMo]
related:
  - https://github.com/nicobailon/pi-subagents
  - https://github.com/tmustier/pi-extensions
---

# Unipi Architecture — All-in-One Pi Extension Suite

## Problem Statement

Pi coding agent extensions are fragmented. Users must discover, install, and configure dozens of independent packages to get a productive workflow. There's no cohesive "distro" that provides: structured development workflows, subagent management, project memory, iterative loops, extension registry, MCP management, web tools, and centralized settings — all working together.

**Root need:** A curated, modular extension suite that works as one install (`unipi`) or granularly (`@unipi/*`), with shared event-based integration between modules.

## Context

**Existing patterns studied:**
- `pi-subagents` (nicobailon): Sophisticated subagent delegation — chains, parallel exec, agent markdown files, MCP integration. ~18 published versions.
- `pi-ralph-wiggum` (tmustier): File-based loop state, `ralph_start`/`ralph_done` tools, reflection checkpoints. Part of larger monorepo with 10+ extensions.
- Pi packages use `peerDependencies: "*"` for core, npm publish with `"pi"` manifest.
- Pi loads `.ts` via jiti — no build step needed.
- Inter-extension comms via `pi.events` EventBus (documented but few examples of module discovery patterns).

**Available names:**
- `unipi` — available on npm
- `@unipi/*` scope — available on npm

## Chosen Approach

**npm workspaces monorepo** with **event-based module discovery**. Ship raw `.ts` (no build step). Incremental release starting with core + workflow + ralph.

## Why This Approach

- **npm workspaces:** Zero extra deps, built into npm, proven by tmustier/pi-extensions
- **Event bus discovery:** Loose coupling — modules announce presence via `pi.events`, no direct imports between modules. Each module works standalone.
- **Raw .ts:** Pi's jiti handles it. Simplest publish flow. No compilation.
- **Incremental:** Ship core + workflow + ralph first. Add modules as they stabilize. Avoid big-bang release risk.

## Key Design Decisions

### Q1: Monorepo Tooling — RESOLVED
**Decision:** npm workspaces
**Rationale:** Zero extra deps, built into npm, pi ecosystem already uses npm
**Alternatives considered:** pnpm (stricter but adds dependency), turborepo (heavy for no-compile extensions)

### Q2: Inter-Module Communication — RESOLVED
**Decision:** `pi.events` EventBus — modules announce presence, discover peers via events
**Rationale:** Loose coupling, each module works standalone, no circular deps
**Alternatives considered:** try-require (fragile), shared registry object (creates core dependency)

### Q3: Core Package Design — RESOLVED
**Decision:** `unipi` (all-in-one) contains shared utilities (event types, constants, helpers) + re-exports all `@unipi/*` modules as dependencies
**Rationale:** Users get one install. Core provides shared infrastructure. Individual modules remain independently installable.
**Alternatives considered:** Re-exports only (no shared code), full bundle (no separate packages)

### Q4: Command Naming — RESOLVED
**Decision:** All commands use `/unipi:` prefix only. No short aliases.
**Rationale:** Clean, consistent, avoid namespace collisions
**Alternatives considered:** Short aliases `/ub` (adds complexity), configurable (over-engineering)

### Q5: npm Package Naming — RESOLVED
**Decision:** `@unipi/workflow`, `@unipi/memory`, etc. for individual packages. `unipi` for all-in-one.
**Rationale:** Scoped packages, clear ownership, granular install
**Alternatives considered:** `@unipi-ext/*` (redundant scope), flat names `unipi-workflow` (pollutes global namespace)

### Q6: Build Strategy — RESOLVED
**Decision:** Ship raw `.ts` files. No build step.
**Rationale:** Pi loads .ts via jiti. Simplest publish. All existing pi packages do this.
**Alternatives considered:** tsc compile (unnecessary complexity), .ts + .d.ts (overkill for pi extensions)

### Q7: Release Strategy — RESOLVED
**Decision:** Incremental — Phase 1: core + workflow + ralph. Phase 2+: remaining modules.
**Rationale:** De-risks launch, validates event-based integration pattern early
**Alternatives considered:** Big-bang all 12 modules (too much risk)

## Module Inventory

| Package | Commands | Phase |
|---------|----------|-------|
| `@unipi/core` | (shared utilities, event types, constants) | 1 |
| `@unipi/workflow` | `/unipi:brainstorm`, `/unipi:plan`, `/unipi:work`, `/unipi:review-work`, `/unipi:consolidate`, `/unipi:worktree-create`, `/unipi:consultant`, `/unipi:quick-work`, `/unipi:gather-context`, `/unipi:document`, `/unipi:scan-issues`, `/unipi:worktree-merge` | 1 |
| `@unipi/ralph` | (ralph loop tools, integrates with workflow) | 1 |
| `@unipi/subagents` | `/unipi:subagent-panel`, `/unipi:subagent-settings` | 2 |
| `@unipi/memory` | `/unipi:memory-init`, `/unipi:memory-review`, `/unipi:memory-settings` | 2 |
| `@unipi/registry` | `/unipi:registry-craftskill`, `/unipi:registry-extensions`, `/unipi:registry-skills` | 2 |
| `@unipi/mcp` | `/unipi:mcp-assist`, `/unipi:mcp-settings` | 2 |
| `@unipi/task` | `/unipi:milestone-assist`, `/unipi:task-assist`, `/unipi:milestone-stats`, `/unipi:task-stats` | 3 |
| `@unipi/webtools` | `/unipi:webtool-onboard` | 3 |
| `@unipi/info-screen` | `/unipi:info`, `/unipi:info-settings` | 3 |
| `@unipi/impeccable` | `/unipi:image-settings` | 3 |
| `@unipi/settings` | Centralized settings for all unipi modules | 3 |

## Event-Based Module Discovery Pattern

```typescript
// Module announces presence on load
pi.events.emit("unipi:module:ready", { name: "@unipi/workflow", version: "1.0.0" });

// Module listens for peers
pi.events.on("unipi:module:ready", (event) => {
  if (event.name === "@unipi/ralph") {
    // Enable workflow+ralph integration features
  }
});
```

Each module:
1. Emits `unipi:module:ready` on `session_start`
2. Listens for peer modules it integrates with
3. Gracefully degrades if peer not present

## Subjective Contract

- **Target outcome:** Professional, cohesive extension suite that feels like it ships with pi. Not a collection of hacks.
- **Anti-goals:** Monolithic bloat, tight coupling between modules, requiring all modules to function
- **References:** tmustier/pi-extensions (monorepo pattern), pi-subagents (subagent architecture)
- **Anti-references:** Scattered single-file extensions with no coordination
- **Tone:** Clean, well-documented, each module independently useful

## Open Questions

1. **Event schema:** What exact event names/payloads for cross-module communication? Define in `@unipi/core`.
2. **Settings storage:** Where do per-module settings live? `~/.pi/agent/settings.json` under `unipi.*` keys? Or `.unipi/settings.json`?
3. **Workflow+Ralph integration:** How exactly does workflow trigger ralph loops? Via event or direct tool call?
4. **Memory architecture:** Vector DB choice? Local (sqlite-vec) vs remote? Markdown fallback?
5. **Webtools API key management:** Where are API keys stored? Env vars? Settings file?
6. **Impeccable integration:** How does @unipi/impeccable interact with the existing impeccable skill?

## Out of Scope

- Modifying pi core
- Building custom TUI components beyond what pi's ExtensionAPI provides
- Supporting non-npm distribution (git, local) as primary — npm is the main channel
- Building a GUI — everything stays in pi's TUI

## Next Steps

1. `/plan` to create implementation plan for Phase 1 (core + workflow + ralph)
2. Scaffold monorepo structure
3. Implement `@unipi/core` with event types and shared utilities
4. Implement `@unipi/workflow` with brainstorm + plan + work commands
5. Implement `@unipi/ralph` adapted from pi-ralph-wiggum
6. Test event-based module discovery
7. Publish Phase 1 to npm

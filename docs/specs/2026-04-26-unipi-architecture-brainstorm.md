---
title: "Unipi Architecture — All-in-One Pi Extension Suite"
type: brainstorm
date: 2026-04-26
participants: [user, MiMo]
related:
  - https://github.com/nicobailon/pi-subagents
  - https://github.com/tmustier/pi-extensions
  - docs/brainstorms/2026-04-26-unipi-memory-brainstorm.md
  - docs/plans/2026-04-26-feat-unipi-memory-plan.md
---

# Unipi Architecture — All-in-One Pi Extension Suite

## Problem Statement

Pi coding agent extensions are fragmented. Users must discover, install, and configure dozens of independent packages to get a productive workflow. There's no cohesive "distro" that provides: structured development workflows, subagent management, project memory, iterative loops, extension registry, MCP management, web tools, and centralized settings — all working together.

**Root need:** A curated, modular extension suite that works as one install (`unipi`) or granularly (`@pi-unipi/*`), with shared event-based integration between modules.

## Context

**Existing patterns studied:**
- `pi-subagents` (nicobailon): Sophisticated subagent delegation — chains, parallel exec, agent markdown files, MCP integration. ~18 published versions.
- `pi-ralph-wiggum` (tmustier): File-based loop state, `ralph_start`/`ralph_done` tools, reflection checkpoints. Part of larger monorepo with 10+ extensions.
- Pi packages use `peerDependencies: "*"` for core, npm publish with `"pi"` manifest.
- Pi loads `.ts` via jiti — no build step needed.
- Inter-extension comms via `pi.events` EventBus (documented but few examples of module discovery patterns).

**npm scope:** `@pi-unipi` (published packages: core, workflow, subagents, memory, unipi meta-package)

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
**Decision:** `unipi` (all-in-one) contains shared utilities (event types, constants, helpers) + re-exports all `@pi-unipi/*` modules as dependencies
**Rationale:** Users get one install. Core provides shared infrastructure. Individual modules remain independently installable.
**Alternatives considered:** Re-exports only (no shared code), full bundle (no separate packages)

### Q4: Command Naming — RESOLVED
**Decision:** All commands use `/unipi:` prefix only. No short aliases.
**Rationale:** Clean, consistent, avoid namespace collisions
**Alternatives considered:** Short aliases `/ub` (adds complexity), configurable (over-engineering)

### Q5: npm Package Naming — RESOLVED
**Decision:** `@pi-unipi/workflow`, `@pi-unipi/memory`, etc. for individual packages. `unipi` for all-in-one.
**Rationale:** Scoped packages, clear ownership, granular install
**Alternatives considered:** `@unipi/*` (original scope, changed to `@pi-unipi`)

### Q6: Build Strategy — RESOLVED
**Decision:** Ship raw `.ts` files. No build step.
**Rationale:** Pi loads .ts via jiti. Simplest publish. All existing pi packages do this.
**Alternatives considered:** tsc compile (unnecessary complexity), .ts + .d.ts (overkill for pi extensions)

### Q7: Release Strategy — RESOLVED
**Decision:** Incremental — Phase 1: core + workflow + ralph. Phase 2+: remaining modules.
**Rationale:** De-risks launch, validates event-based integration pattern early
**Alternatives considered:** Big-bang all 12 modules (too much risk)

### Q8: Memory Architecture — RESOLVED
**Decision:** Two-tier storage: SQLite + sqlite-vec for vector search, markdown files for human-readable memory
**Rationale:** Embedded (zero infra), human-readable, git-trackable, hybrid search for best recall
**Alternatives considered:** ChromaDB (too heavy), markdown-only (no semantic search), vector-only (not human-readable)

### Q9: Memory Scoping — RESOLVED
**Decision:** All memories are project-scoped (`~/.unipi/memory/<project_name>/`). "Global" is a search mode across all projects, not a separate storage location.
**Rationale:** Clean separation, cross-project search without duplication
**Alternatives considered:** Separate global directory (caused confusion, removed)

### Q10: Event Schema — RESOLVED
**Decision:** Events defined in `@unipi/core/events.ts` with typed payloads
**Rationale:** Type safety, IDE support, clear contracts between modules
**Alternatives considered:** String-only events (no type safety)

## Module Inventory

| Package | Status | Description |
|---------|--------|-------------|
| `@pi-unipi/core` | ✅ **Published** | Shared utilities, event types, constants, sandbox |
| `@pi-unipi/workflow` | ✅ **Published** | 13 workflow commands (brainstorm, plan, work, etc.) |
| `@pi-unipi/ralph` | ✅ **Published** | Ralph loop tools (ralph_start, ralph_done) |
| `@pi-unipi/subagents` | ✅ **Published** | Agent delegation (Agent, get_result tools) |
| `@pi-unipi/memory` | ✅ **Published** | Persistent memory with vector search |
| `@pi-unipi/registry` | ❌ **Not started** | Extension/skill registry management |
| `@pi-unipi/mcp` | ❌ **Not started** | MCP server management |
| `@pi-unipi/task` | ❌ **Not started** | Milestone/task tracking |
| `@pi-unipi/webtools` | ❌ **Not started** | Web tool integration |
| `@pi-unipi/info-screen` | ❌ **Not started** | Module status dashboard |
| `@pi-unipi/impeccable` | ❌ **Not started** | Image generation settings |
| `@pi-unipi/settings` | ❌ **Not started** | Centralized settings |

### Module Details

#### ✅ Completed Modules

**@pi-unipi/core** (Phase 1)
- Event types and payloads for inter-module communication
- Shared constants (UNIPI_PREFIX, MODULES, TOOLS, COMMANDS, DIRS)
- Sandbox module (tool access levels for workflow commands)
- Utility functions (sanitize, ensureDir, tryRead, etc.)
- Memory-related constants and events added

**@pi-unipi/workflow** (Phase 1)
- 13 workflow commands via `/unipi:` prefix
- Skills-based architecture (SKILL.md for each command)
- Sandbox integration (tool filtering per command)
- Ralph detection and integration
- Session injection for sandbox constraints

**@pi-unipi/ralph** (Phase 1)
- Adapted from pi-ralph-wiggum
- ralph_start/ralph_done tools
- File-based loop state (.unipi/ralph/)
- Commands: start, stop, resume, status, cancel, archive, clean, list, nuke
- Integration with workflow module

**@pi-unipi/subagents** (Phase 2)
- Agent delegation (spawn background/foreground agents)
- AgentManager for concurrency control
- AgentWidget for TUI status display
- File locking for write agents
- Model resolver for agent model selection
- Custom agent types from markdown files

**@pi-unipi/memory** (Phase 2)
- Two-tier storage: SQLite + sqlite-vec + markdown
- Hybrid search (vector + fuzzy text)
- Project-scoped memories
- Cross-project search (global mode)
- Tools: memory_store, memory_search, memory_delete, memory_list, global_memory_search, global_memory_list
- Commands: /unipi:memory-process, /unipi:memory-search, /unipi:memory-consolidate, /unipi:memory-forget, /unipi:global-memory-search, /unipi:global-memory-list
- Session injection (titles only at start)
- Auto-consolidation hook (placeholder for LLM extraction)
- SKILL.md for agent memory management

#### ❌ Not Started Modules

**@pi-unipi/registry** — Extension/skill discovery and management
- `/unipi:registry-craftskill` — Create new skills
- `/unipi:registry-extensions` — List/manage installed extensions
- `/unipi:registry-skills` — List/manage installed skills

**@pi-unipi/mcp** — MCP server management
- `/unipi:mcp-assist` — Add/configure MCP servers
- `/unipi:mcp-settings` — MCP configuration

**@pi-unipi/task** — Task/milestone tracking
- `/unipi:milestone-assist` — Create/manage milestones
- `/unipi:task-assist` — Create/manage tasks
- `/unipi:milestone-stats` — Milestone progress
- `/unipi:task-stats` — Task statistics

**@pi-unipi/webtools** — Web tool integration
- `/unipi:webtool-onboard` — Configure web tools

**@pi-unipi/info-screen** — Module status dashboard
- `/unipi:info` — Show all module status
- `/unipi:info-settings` — Configure info display

**@pi-unipi/impeccable** — Image generation
- `/unipi:image-settings` — Configure image generation

**@pi-unipi/settings** — Centralized settings
- Settings for all unipi modules
- `~/.unipi/config/` storage

## Event-Based Module Discovery Pattern

```typescript
// Module announces presence on load
pi.events.emit("unipi:module:ready", { name: "@pi-unipi/workflow", version: "1.0.0" });

// Module listens for peers
pi.events.on("unipi:module:ready", (event) => {
  if (event.name === "@pi-unipi/ralph") {
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

## Resolved Questions

1. **Event schema:** ✅ Defined in `@pi-unipi/core/events.ts` with typed payloads
2. **Memory architecture:** ✅ SQLite + sqlite-vec + markdown, project-scoped, cross-project search
3. **Workflow+Ralph integration:** ✅ Ralph detection via tool presence, workflow triggers ralph via events

## Open Questions

1. **Settings storage:** Where do per-module settings live? `~/.pi/agent/settings.json` under `unipi.*` keys? Or `.unipi/settings.json`?
2. **Webtools API key management:** Where are API keys stored? Env vars? Settings file?
3. **Impeccable integration:** How does @pi-unipi/impeccable interact with the existing impeccable skill?
4. **Registry architecture:** How to discover and list extensions/skills from npm and local?

## Out of Scope

- Modifying pi core
- Building custom TUI components beyond what pi's ExtensionAPI provides
- Supporting non-npm distribution (git, local) as primary — npm is the main channel
- Building a GUI — everything stays in pi's TUI

## Next Steps

1. **Phase 3 modules:** registry, mcp, task, webtools, info-screen, impeccable, settings
2. Test all published modules in real pi sessions
3. Gather user feedback on memory module UX
4. Implement LLM-based memory consolidation (currently placeholder)
5. Implement embedding generation for vector search (currently fuzzy-only)

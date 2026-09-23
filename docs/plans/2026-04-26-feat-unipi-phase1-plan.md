---
title: "feat: Unipi Phase 1 — Core + Workflow + Ralph"
type: plan
date: 2026-04-26
status: completed
brainstorm: docs/brainstorms/2026-04-26-unipi-architecture-brainstorm.md
confidence: medium
---

# Unipi Phase 1: Core + Workflow + Ralph

## Problem Statement

Pi coding agent has no cohesive extension suite. Users install scattered packages independently. No structured development workflow, no iterative loop integration, no shared infrastructure between extensions.

## Target End State

Working npm-publishable monorepo with 3 packages:
- `@unipi/core` — shared event types, constants, helpers
- `@unipi/workflow` — `/unipi:brainstorm`, `/unipi:plan`, `/unipi:work`, `/unipi:review-work`, `/unipi:consolidate`, `/unipi:worktree-create`, `/unipi:consultant`, `/unipi:quick-work`, `/unipi:gather-context`, `/unipi:document`, `/unipi:scan-issues`, `/unipi:worktree-merge`
- `@unipi/ralph` — ralph loop tools adapted from pi-ralph-wiggum, integrated with workflow
- `unipi` — meta-package depending on all three

All commands use `/unipi:` prefix. Modules discover each other via `pi.events`. Each works standalone.

## Scope and Non-Goals

**In scope:**
- npm workspaces monorepo scaffold
- `@unipi/core` with event types, shared utilities
- `@unipi/workflow` with 12 commands (skill-based, not extension-based where possible)
- `@unipi/ralph` adapted from pi-ralph-wiggum with workflow integration
- `unipi` meta-package
- npm publish configuration
- README for each package

**Out of scope (Phase 2+):**
- `@unipi/subagents`, `@unipi/memory`, `@unipi/registry`, `@unipi/mcp`
- `@unipi/task`, `@unipi/webtools`, `@unipi/info-screen`, `@unipi/impeccable`, `@unipi/settings`
- Custom TUI components
- Vector DB integration
- GUI/web interface

## Proposed Solution

### Architecture

```
unipi/
├── package.json              # root workspace config
├── packages/
│   ├── core/                 # @unipi/core
│   │   ├── package.json
│   │   ├── index.ts          # exports
│   │   ├── events.ts         # event type definitions
│   │   ├── constants.ts      # shared constants
│   │   └── utils.ts          # shared helpers
│   ├── workflow/             # @unipi/workflow
│   │   ├── package.json
│   │   ├── index.ts          # extension entry (registers commands)
│   │   ├── skills/           # skill files for each command
│   │   │   ├── brainstorm/SKILL.md
│   │   │   ├── plan/SKILL.md
│   │   │   ├── work/SKILL.md
│   │   │   ├── review-work/SKILL.md
│   │   │   ├── consolidate/SKILL.md
│   │   │   ├── worktree-create/SKILL.md
│   │   │   ├── consultant/SKILL.md
│   │   │   ├── quick-work/SKILL.md
│   │   │   ├── gather-context/SKILL.md
│   │   │   ├── document/SKILL.md
│   │   │   ├── scan-issues/SKILL.md
│   │   │   └── worktree-merge/SKILL.md
│   │   └── commands.ts       # command registration logic
│   ├── ralph/                # @unipi/ralph
│   │   ├── package.json
│   │   ├── index.ts          # extension entry
│   │   ├── ralph-loop.ts     # core loop logic
│   │   ├── tools.ts          # ralph_start, ralph_done tools
│   │   └── SKILL.md          # ralph skill
│   └── unipi/                # unipi (meta-package)
│       ├── package.json
│       └── README.md
├── docs/
│   ├── brainstorms/
│   └── plans/
└── README.md
```

### Inter-Module Discovery Pattern

```typescript
// In @unipi/core/events.ts
export const UNIPI_EVENTS = {
  MODULE_READY: "unipi:module:ready",
  MODULE_GONE: "unipi:module:gone",
  WORKFLOW_START: "unipi:workflow:start",
  WORKFLOW_END: "unipi:workflow:end",
  RALPH_LOOP_START: "unipi:ralph:loop:start",
  RALPH_LOOP_END: "unipi:ralph:loop:end",
} as const;

export interface UnipiModuleEvent {
  name: string;       // e.g., "@unipi/workflow"
  version: string;
  commands: string[];  // registered commands
}
```

Each module on `session_start`:
```typescript
pi.events.emit(UNIPI_EVENTS.MODULE_READY, {
  name: "@unipi/ralph",
  version: pkg.version,
  commands: ["ralph-start", "ralph-stop"],
});
```

Workflow module listens for ralph presence to enable `/unipi:work` ralph integration.

### Workflow Commands

Most workflow commands are **skills** (markdown), not extensions. Only command registration is in the extension.

| Command | Type | Description |
|---------|------|-------------|
| `/unipi:brainstorm` | Skill | Collaborative discovery, problem reframing |
| `/unipi:plan` | Skill | Strategic planning with tasks |
| `/unipi:work` | Skill | Execute plan, implement, test, commit |
| `/unipi:review-work` | Skill | Review what was built |
| `/unipi:consolidate` | Skill | Merge findings, update docs |
| `/unipi:worktree-create` | Extension | Create git worktree for parallel work |
| `/unipi:consultant` | Skill | Expert panel, multi-lens review |
| `/unipi:quick-work` | Skill | Fast single-task execution |
| `/unipi:gather-context` | Skill | Research codebase, surface patterns |
| `/unipi:document` | Skill | Generate docs from code |
| `/unipi:scan-issues` | Skill | Find bugs, anti-patterns |
| `/unipi:worktree-merge` | Extension | Merge worktree back to main |

Extension (`index.ts`) registers all commands. Skills provide the LLM instructions.

### Ralph Integration

`@unipi/ralph` adapts pi-ralph-wiggum:
- Same file-based loop state (`.ralph/` directory)
- Same `ralph_start`/`ralph_done` tools
- Adds `unipi:ralph:loop:start` event emission
- Workflow module detects ralph presence → enables "run with ralph loop" option in `/unipi:work`

## Implementation Tasks

### Task 1: Scaffold monorepo structure
- Create root `package.json` with npm workspaces
- Create directory structure under `packages/`
- Create `.npmrc` for `@unipi` scope
- **Depends on:** Nothing
- **Acceptance:** `npm install` succeeds, workspace resolution works

### Task 2: Implement `@unipi/core`
- `events.ts` — event type definitions, constants
- `constants.ts` — shared constants (RALPH_DIR, UNIPI_PREFIX, etc.)
- `utils.ts` — shared helpers (sanitize, ensureDir, tryRead, etc.)
- `package.json` with `peerDependencies` on pi core
- **Depends on:** Task 1
- **Acceptance:** Types export correctly, `npx tsc --noEmit` passes

### Task 3: Implement `@unipi/workflow` extension entry
- `index.ts` — registers all 12 commands via `pi.registerCommand`
- `commands.ts` — command handler logic (maps command → skill loading)
- Emits `unipi:module:ready` on session_start
- Listens for `@unipi/ralph` presence
- **Depends on:** Task 2
- **Acceptance:** All 12 commands appear in pi, `/unipi:brainstorm` triggers skill

### Task 4: Create workflow skills
- 12 SKILL.md files under `skills/`
- Each skill follows pi skill format (frontmatter + markdown)
- Skills reference `@unipi/core` constants where needed
- **Depends on:** Task 3
- **Acceptance:** Each skill loads, has correct frontmatter, triggers on command

### Task 5: Implement `@unipi/ralph`
- Port pi-ralph-wiggum `index.ts` → `ralph-loop.ts` + `tools.ts` + `index.ts`
- Add event emission (`unipi:ralph:loop:start/end`)
- Add workflow integration listener
- `SKILL.md` for ralph instructions
- **Depends on:** Task 2
- **Acceptance:** `/ralph start test` works, `ralph_start` tool works, events emitted

### Task 6: Create `unipi` meta-package
- `package.json` with dependencies on `@unipi/core`, `@unipi/workflow`, `@unipi/ralph`
- README with install instructions
- **Depends on:** Tasks 2, 3, 5
- **Acceptance:** `pi install npm:unipi` installs all three sub-packages

### Task 7: npm publish configuration
- `publishConfig` for each package (`access: public`)
- Version management (start at 0.1.0)
- npm token in `.npmrc` or CI secrets
- **Depends on:** Task 6
- **Acceptance:** `npm publish --dry-run` succeeds for each package

### Task 8: Documentation
- Root README with architecture overview
- Per-package README
- Install instructions (all-in-one and granular)
- **Depends on:** Task 7
- **Acceptance:** README covers install, usage, development

## Acceptance Criteria

1. `pi install npm:unipi` installs core + workflow + ralph
2. `pi install npm:@unipi/workflow` installs workflow standalone
3. `/unipi:brainstorm` triggers brainstorm skill
4. `/unipi:plan` triggers plan skill
5. `/unipi:work` triggers work skill (detects ralph if present)
6. `ralph_start` tool works, emits events
7. Modules discover each other via `pi.events` — no direct imports
8. Each module works standalone (no hard deps on other unipi modules)
9. `npx tsc --noEmit` passes for all packages

## Decision Rationale

- **Skills over extensions for commands:** Most workflow commands are prompt engineering, not code. Skills are cheaper, editable by users, don't need compilation.
- **Events over imports:** Loose coupling. Modules work standalone. No circular dependency risk.
- **Adapt pi-ralph-wiggum, don't fork:** Port the logic, add event integration. Don't copy-paste wholesale — rewrite for unipi patterns.

## Assumptions

| Assumption | Status | Evidence |
|------------|--------|----------|
| pi.events supports pub/sub between extensions | Verified | Documented in extensions.md, EventBus API exists |
| npm workspaces work for pi extension monorepo | Verified | tmustier/pi-extensions uses similar pattern |
| jiti loads .ts from npm packages | Verified | All existing pi packages ship .ts |
| Skills can be loaded from npm packages | Verified | pi docs show skills in package manifests |
| `@unipi` npm scope is available | Verified | npm view returns 404 |
| Workflow commands as skills is sufficient | Unverified | May need extension logic for worktree commands |
| Event-based discovery adds acceptable latency | Unverified | Events fire on session_start, should be fast |

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Skills can't do worktree operations | Medium | Worktree commands use extension (registerCommand + bash), not skill |
| Event discovery timing (module A loads before B) | Low | Listen in session_start, re-check on each command invocation |
| npm scope `@unipi` taken between now and publish | Low | Register immediately, or use `unipi-*` flat names as fallback |
| Large skill files slow down pi startup | Low | Skills are lazy-loaded, not all parsed on startup |

## Phased Implementation

### Phase 1a: Scaffold + Core
**Exit criteria:** Monorepo scaffolded, `@unipi/core` exports types, `npm install` works

### Phase 1b: Workflow Extension + Skills
**Exit criteria:** All 12 commands registered, skills load, `/unipi:brainstorm` works

### Phase 1c: Ralph + Integration
**Exit criteria:** Ralph loop works, events emitted, workflow detects ralph

### Phase 1d: Meta-package + Publish
**Exit criteria:** `unipi` package works, npm publish dry-run succeeds, docs complete

## References

- Brainstorm: `docs/brainstorms/2026-04-26-unipi-architecture-brainstorm.md`
- pi-ralph-wiggum: `/home/pi/.pi/agent/git/github.com/tmustier/pi-extensions/pi-ralph-wiggum/`
- pi-subagents: https://github.com/nicobailon/pi-subagents
- Pi extension docs: `/home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Pi packages docs: `/home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`

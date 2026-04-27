---
title: "Utility + Ask-User — Implementation Plan"
type: plan
date: 2026-04-27
workbranch: "feat/utility-ask-user"
specs:
  - .unipi/docs/specs/2026-04-27-utility-ask-user-design.md
---

# Utility + Ask-User — Implementation Plan

## Overview

This plan implements two new Unipi extensions:
1. **@pi-unipi/utility** — Provides `/unipi:continue` command and `continue_task` tool for clean agent continuation without context pollution
2. **@pi-unipi/ask-user** — Provides `ask_user` tool for structured user input (single-select, multi-select, freeform) with polished TUI

Both follow established Unipi patterns (memory, ralph, btw) for tool/command registration, skill bundling, and module announcements.

## Tasks

- completed: Task 1 — Update @pi-unipi/core Constants
  - Description: Add UTILITY and ASK_USER module names, command names, and tool names to core constants
  - Dependencies: None
  - Acceptance Criteria: Constants file compiles without errors; all new constants are exported
  - Steps:
    1. Add `UTILITY: "@pi-unipi/utility"` and `ASK_USER: "@pi-unipi/ask-user"` to MODULES object
    2. Add `UTILITY_COMMANDS` with `CONTINUE: "continue"`
    3. Add `UTILITY_TOOLS` with `CONTINUE: "continue_task"`
    4. Add `ASK_USER_TOOLS` with `ASK: "ask_user"`

- unstarted: Task 2 — Create @pi-unipi/utility Package Structure
  - Description: Create the utility package with package.json, index.ts, commands.ts, tools.ts, constants.ts, and README.md
  - Dependencies: Task 1
  - Acceptance Criteria: Package structure matches Unipi patterns; package.json has correct metadata and dependencies
  - Steps:
    1. Create `packages/utility/package.json` with name, version, pi.extensions, pi.skills, dependencies
    2. Create `packages/utility/constants.ts` with local constants (CONTINUE_PROMPT)
    3. Create `packages/utility/commands.ts` with `/unipi:continue` command registration
    4. Create `packages/utility/tools.ts` with `continue_task` tool registration
    5. Create `packages/utility/index.ts` as extension entry point
    6. Create `packages/utility/README.md` with usage documentation

- unstarted: Task 3 — Implement /unipi:continue Command
  - Description: Register and implement the `/unipi:continue` command that sends a steer message to continue the agent
  - Dependencies: Task 2
  - Acceptance Criteria: Command registers without errors; invoking command sends steer message; agent continues without user message in transcript
  - Steps:
    1. In `commands.ts`, register command with name, description, argumentHint
    2. Implement handler that checks agent state (idle vs busy)
    3. Use `pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "steer" })` to continue
    4. Handle edge cases: agent busy (queue or notify), no active session

- unstarted: Task 4 — Implement continue_task Tool
  - Description: Register and implement the `continue_task` tool for programmatic agent continuation
  - Dependencies: Task 2
  - Acceptance Criteria: Tool registers with correct schema; execute function sends steer message; returns appropriate content
  - Steps:
    1. In `tools.ts`, register tool with name, label, description, promptSnippet, promptGuidelines
    2. Define parameters as `Type.Object({})` (no parameters)
    3. Implement execute function that sends steer message
    4. Return success/error content based on result

- unstarted: Task 5 — Create @pi-unipi/ask-user Package Structure
  - Description: Create the ask-user package with package.json, index.ts, types.ts, tools.ts, ask-ui.ts, commands.ts, skills/, and README.md
  - Dependencies: Task 1
  - Acceptance Criteria: Package structure matches Unipi patterns; package.json has correct metadata and dependencies
  - Steps:
    1. Create `packages/ask-user/package.json` with name, version, pi.extensions, pi.skills, dependencies
    2. Create `packages/ask-user/types.ts` with TypeScript interfaces (AskUserParams, AskUserResponse, AskUserDetails)
    3. Create `packages/ask-user/tools.ts` with `ask_user` tool registration
    4. Create `packages/ask-user/ask-ui.ts` with TUI components (single-select, multi-select, freeform)
    5. Create `packages/ask-user/commands.ts` with optional `/unipi:ask-user-test` command
    6. Create `packages/ask-user/skills/ask-user/SKILL.md` with bundled skill
    7. Create `packages/ask-user/index.ts` as extension entry point
    8. Create `packages/ask-user/README.md` with usage documentation

- unstarted: Task 6 — Implement ask_user Tool
  - Description: Register and implement the `ask_user` tool with TypeBox schema, mode switching, and TUI rendering
  - Dependencies: Task 5
  - Acceptance Criteria: Tool registers with correct schema; single-select mode works; multi-select mode works; freeform mode works; timeout works; cancel works
  - Steps:
    1. In `tools.ts`, register tool with name, label, description, promptSnippet, promptGuidelines
    2. Define parameters TypeBox schema (question, context, options, allowMultiple, allowFreeform, timeout)
    3. Implement execute function that validates parameters and selects UI mode
    4. Handle no-UI mode: return error result
    5. Handle single-select: show simple options list
    6. Handle multi-select: show toggleable options list
    7. Handle freeform: add "Type something..." option
    8. Handle timeout: auto-dismiss after N ms
    9. Handle cancel: return cancelled response
    10. Return AskUserResponse with kind, selections, text, comment

- unstarted: Task 7 — Implement ask-ui TUI Components
  - Description: Build polished TUI components for single-select, multi-select, and freeform input using ctx.ui.custom()
  - Dependencies: Task 6
  - Acceptance Criteria: TUI renders correctly; keyboard navigation works; selection/submission works; cancel works; theme integration works
  - Steps:
    1. In `ask-ui.ts`, create AskUI class with render, handleInput, destroy methods
    2. Implement single-select mode with arrow keys, Enter to select, Esc to cancel
    3. Implement multi-select mode with Space to toggle, Enter to submit, Esc to cancel
    4. Implement freeform mode with text input
    5. Add context display above question
    6. Add timeout countdown display
    7. Integrate with pi theme for consistent styling
    8. Use `ctx.ui.custom()` callback pattern (render, invalidate, handleInput)

- unstarted: Task 8 — Create ask-user Skill
  - Description: Write the bundled SKILL.md that guides the agent to use ask_user for high-stakes decisions
  - Dependencies: Task 5
  - Acceptance Criteria: Skill file is valid markdown; describes when to use ask_user; provides examples; lists parameters
  - Steps:
    1. Write SKILL.md with name, description, allowed-tools
    2. Document when to use ask_user (architectural trade-offs, ambiguous requirements, etc.)
    3. Document Decision Handshake Flow
    4. Document all parameters with types and defaults
    5. Provide examples for single-select, multi-select, and with-context modes

- unstarted: Task 9 — Update @pi-unipi/unipi Meta-Package
  - Description: Add utility and ask-user imports to the meta-package so they load with `pi install npm:unipi`
  - Dependencies: Task 3, Task 4, Task 6, Task 7, Task 8
  - Acceptance Criteria: Meta-package imports both extensions; package.json lists dependencies; pi.extensions and pi.skills arrays updated
  - Steps:
    1. Update `packages/unipi/index.ts` to import and call utility and askUser
    2. Update root `package.json` dependencies to include @pi-unipi/utility and @pi-unipi/ask-user
    3. Update root `package.json` pi.extensions array to include utility and ask-user entry points
    4. Update root `package.json` pi.skills array to include ask-user skills directory

- unstarted: Task 10 — Testing and Validation
  - Description: Run typecheck, test all extensions manually, verify integration works
  - Dependencies: Task 9
  - Acceptance Criteria: `npm run typecheck` passes; all manual tests pass; info-screen shows new modules
  - Steps:
    1. Run `npm run typecheck` and fix any errors
    2. Test `/unipi:continue` when agent is idle — verify agent continues
    3. Test `/unipi:continue` when agent is busy — verify appropriate handling
    4. Test `continue_task` tool — verify agent continues
    5. Test `ask_user` single-select — verify user can pick, result returned
    6. Test `ask_user` multi-select — verify user can toggle, submit works
    7. Test `ask_user` freeform — verify user can type custom answer
    8. Test `ask_user` with context — verify context displayed
    9. Test `ask_user` timeout — verify auto-dismiss works
    10. Test `ask_user` cancel — verify cancelled response
    11. Test skill integration — verify agent uses ask_user for decisions
    12. Verify info-screen shows utility and ask-user modules

## Sequencing

```
Task 1 (core constants)
    ↓
Task 2 (utility structure) ←─────── Task 5 (ask-user structure)
    ↓                                       ↓
Task 3 (continue command)                Task 6 (ask_user tool)
Task 4 (continue_task tool)                  ↓
    ↓                                   Task 7 (ask-ui TUI)
    │                                   Task 8 (ask-user skill)
    ↓                                       ↓
    └─────────────→ Task 9 (meta-package) ←─┘
                        ↓
                   Task 10 (testing)
```

Tasks 2-4 (utility) and Tasks 5-8 (ask-user) can be parallelized after Task 1 completes.

## Risks

1. **`deliverAs: "steer"` availability**: The spec assumes "steer" is a valid delivery mode. If it's not available or behaves differently, the continue feature may not work as expected. Mitigation: Test early, fall back to "followUp" if needed.

2. **TUI complexity**: Building polished TUI components with ctx.ui.custom() requires understanding pi's rendering model. Mitigation: Study info-screen and btw examples; keep v1 simple (no overlay mode).

3. **Schema validation**: TypeBox schema must match pi's expected format exactly. Mitigation: Reference existing tools (memory, ralph) for correct patterns.

4. **Module event timing**: Extensions must emit MODULE_READY at the right time for info-screen to track them. Mitigation: Follow memory/ralph patterns exactly.

5. **Skill discoverability**: The bundled skill must be discoverable by pi's skill loading system. Mitigation: Use resources_discover event with skillPaths like memory does.

## Open Questions Resolved

1. **Continue prompt wording**: Use default "Continue from where you left off. Proceed with the next step." — not configurable for v1.
2. **Overlay mode**: Not supported in v1 — use full-screen ctx.ui.custom() for reliability.
3. **Timeout default**: Only when explicitly specified — no default timeout.
4. **Multi-question**: Single-question only for v1 — tab-based multi-question deferred.

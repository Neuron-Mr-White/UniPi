---
title: "README Rewrite — Consistent Package Documentation"
type: plan
date: 2026-05-01
workbranch: ""
specs:
  - .pi/skills/avoid-ai-writing/SKILL.md
---

# README Rewrite — Consistent Package Documentation

## Overview

Rewrite all package READMEs and the root README to follow a consistent structure. Apply the avoid-ai-writing skill to remove AI patterns and produce human-sounding documentation.

**Package README structure:**
1. Hero — why this exists, what feature it has, base concept
2. User controls — how to use it, shortcuts, commands
3. Special Triggers — why flows exist, coexists rule, footer/info screen registration
4. Agent section — agent flow, tools available
5. Configurables — behavioral changes, API key presets

**Root README structure:**
- Boast functionalities
- Explain architecture
- Brief commands/agent tools (very short)
- Contribution rules

## Tasks

- completed: Task 1 — Core package README
  - Description: Rewrite `packages/core/README.md` following the 5-section format. Core provides shared infrastructure — event types, constants, utilities.
  - Dependencies: None
  - Acceptance Criteria: README has Hero, User controls, Special Triggers, Agent section, Configurables sections. No AI-isms detected.
  - Steps:
    1. Read current `packages/core/README.md`
    2. Read `packages/core/src/index.ts` to understand exports
    3. Rewrite following the 5-section format
    4. Apply avoid-ai-writing audit
    5. Fix any flagged patterns

- completed: Task 2 — Workflow package README
  - Description: Rewrite `packages/workflow/README.md`. Workflow provides 20 structured development commands.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Commands table preserved. Flow diagram included. No AI-isms.
  - Steps:
    1. Read current README and skill files in `packages/workflow/skills/`
    2. Rewrite with Hero explaining the brainstorm→plan→work→review cycle
    3. User controls section with command table and examples
    4. Special Triggers section explaining coexists behavior
    5. Agent section explaining skill loading
    6. Configurables section (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 3 — Ralph package README
  - Description: Rewrite `packages/ralph/README.md`. Ralph enables long-running iterative tasks.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Loop lifecycle explained. No AI-isms.
  - Steps:
    1. Read current README and ralph source
    2. Rewrite with Hero explaining iterative loops
    3. User controls with ralph commands
    4. Special Triggers for workflow integration
    5. Agent section with ralph_start/ralph_done tools
    6. Configurables for loop settings
    7. Apply avoid-ai-writing audit

- completed: Task 4 — Memory package README
  - Description: Rewrite `packages/memory/README.md`. Memory provides persistent cross-session storage with vector search.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Storage layout explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining persistent memory concept
    3. User controls with memory commands
    4. Special Triggers for auto-injection and consolidation
    5. Agent section with memory tools
    6. Configurables for storage settings
    7. Apply avoid-ai-writing audit

- completed: Task 5 — Info-screen package README
  - Description: Rewrite `packages/info-screen/README.md`. Info-screen is a dashboard overlay.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Module registration explained. No AI-isms.
  - Steps:
    1. Read current README and info-screen source
    2. Rewrite with Hero explaining dashboard concept
    3. User controls with info commands
    4. Special Triggers for module discovery
    5. Agent section (info-screen has no agent tools)
    6. Configurables for display settings
    7. Apply avoid-ai-writing audit

- completed: Task 6 — Subagents package README
  - Description: Rewrite `packages/subagents/README.md`. Subagents enables parallel execution.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Parallel execution explained. No AI-isms.
  - Steps:
    1. Read current README and subagents source
    2. Rewrite with Hero explaining parallel execution
    3. User controls (subagents has no user commands, only agent tools)
    4. Special Triggers for workflow integration
    5. Agent section with spawn_helper/get_helper_result tools
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 7 — BTW package README
  - Description: Rewrite `packages/btw/README.md`. BTW provides parallel side conversations.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Thread model explained. No AI-isms.
  - Steps:
    1. Read current README and btw source
    2. Rewrite with Hero explaining side-conversation concept
    3. User controls with /btw commands
    4. Special Triggers for context sharing
    5. Agent section (BTW has no agent tools)
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 8 — Web-api package README
  - Description: Rewrite `packages/web-api/README.md`. Web-api provides web search, reading, and summarization.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Provider system explained. No AI-isms.
  - Steps:
    1. Read current README and web-api source
    2. Rewrite with Hero explaining web research capabilities
    3. User controls with web commands
    4. Special Triggers for research skills
    5. Agent section with web tools
    6. Configurables for provider API keys
    7. Apply avoid-ai-writing audit

- completed: Task 9 — Compactor package README
  - Description: Rewrite `packages/compactor/README.md`. Compactor is the context engine.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Zero-LLM compaction explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining context management
    3. User controls with compact commands
    4. Special Triggers for auto-compaction
    5. Agent section with compactor tools
    6. Configurables with presets and pipeline settings
    7. Apply avoid-ai-writing audit

- completed: Task 10 — Notify package README
  - Description: Rewrite `packages/notify/README.md`. Notify sends cross-platform notifications.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Platform setup explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining notification routing
    3. User controls with notify commands
    4. Special Triggers for event-based notifications
    5. Agent section with notify_user tool
    6. Configurables for platform credentials
    7. Apply avoid-ai-writing audit

- completed: Task 11 — Utility package README
  - Description: Rewrite `packages/utility/README.md`. Utility provides environment info, diagnostics, settings.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Tool set explained. No AI-isms.
  - Steps:
    1. Read current README and utility source
    2. Rewrite with Hero explaining dev environment tools
    3. User controls with utility commands
    4. Special Triggers (if any)
    5. Agent section with utility tools
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 12 — MCP package README
  - Description: Rewrite `packages/mcp/README.md`. MCP integrates Model Context Protocol servers.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. MCP concept explained. No AI-isms.
  - Steps:
    1. Read current README and mcp source
    2. Rewrite with Hero explaining MCP integration
    3. User controls with mcp commands
    4. Special Triggers for tool discovery
    5. Agent section with MCP tool exposure
    6. Configurables for server configuration
    7. Apply avoid-ai-writing audit

- completed: Task 13 — Ask-user package README
  - Description: Rewrite `packages/ask-user/README.md`. Ask-user provides structured user input.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Input modes explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining structured input concept
    3. User controls (keyboard navigation)
    4. Special Triggers for decision gating
    5. Agent section with ask_user tool
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 14 — Milestone package README
  - Description: Rewrite `packages/milestone/README.md`. Milestone tracks project progress.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. MILESTONES.md concept explained. No AI-isms.
  - Steps:
    1. Read current README and milestone source
    2. Rewrite with Hero explaining progress tracking
    3. User controls with milestone commands
    4. Special Triggers for workflow integration
    5. Agent section (if any tools)
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 15 — Kanboard package README
  - Description: Rewrite `packages/kanboard/README.md`. Kanboard provides visualization server.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. TUI overlay explained. No AI-isms.
  - Steps:
    1. Read current README and kanboard source
    2. Rewrite with Hero explaining kanban visualization
    3. User controls with kanboard commands
    4. Special Triggers for workflow integration
    5. Agent section (if any tools)
    6. Configurables for display settings
    7. Apply avoid-ai-writing audit

- completed: Task 16 — Footer package README
  - Description: Rewrite `packages/footer/README.md`. Footer renders persistent status bar.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Segment system explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining status bar concept
    3. User controls with footer commands
    4. Special Triggers for event subscriptions
    5. Agent section (footer has no agent tools)
    6. Configurables with presets and segment toggles
    7. Apply avoid-ai-writing audit

- completed: Task 17 — Updater package README
  - Description: Rewrite `packages/updater/README.md`. Updater provides auto-update and browsers.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Update flow explained. No AI-isms.
  - Steps:
    1. Read current README
    2. Rewrite with Hero explaining update mechanism
    3. User controls with updater commands
    4. Special Triggers for session-start checks
    5. Agent section (updater has no agent tools)
    6. Configurables for check interval and auto-update
    7. Apply avoid-ai-writing audit

- completed: Task 18 — Input-shortcuts package README
  - Description: Rewrite `packages/input-shortcuts/README.md`. Input-shortcuts provides keyboard shortcuts.
  - Dependencies: None
  - Acceptance Criteria: README has all 5 sections. Shortcut system explained. No AI-isms.
  - Steps:
    1. Read current README and input-shortcuts source
    2. Rewrite with Hero explaining keyboard shortcuts
    3. User controls with shortcut list
    4. Special Triggers for registration
    5. Agent section (input-shortcuts has no agent tools)
    6. Configurables (if any)
    7. Apply avoid-ai-writing audit

- completed: Task 19 — Root README rewrite
  - Description: Rewrite root `README.md` to boast functionalities, explain architecture, brief commands/agent tools, and add contribution rules.
  - Dependencies: Tasks 1-18
  - Acceptance Criteria: Root README has architecture overview, feature highlights, brief command table, contribution section. No AI-isms.
  - Steps:
    1. Read current root README
    2. Rewrite Hero to boast about the suite
    3. Architecture section explaining module system
    4. Brief commands table (short descriptions only)
    5. Brief agent tools table (short descriptions only)
    6. Contribution rules section
    7. Apply avoid-ai-writing audit

## Sequencing

```
Tasks 1-18 (package READMEs) — can run in parallel, no dependencies
Task 19 (root README) — after all package READMEs complete
```

## Risks

- **Some packages have minimal source code** — README may be thin. Focus on what exists.
- **Avoid-ai-writing skill may flag legitimate technical terms** — use `docs` context profile to allow technical vocabulary.
- **Large scope** — 19 tasks total. Consider batching (core packages first, then utility packages).

---

## Reviewer Remarks

REVIEWER-REMARK: Done 19/19

All 19 README files rewritten following the 5-section format:

**Package READMEs (18):**
- core, workflow, ralph, memory, info-screen, subagents, btw, web-api, compactor, notify, utility, mcp, ask-user, milestone, kanboard, footer, updater, input-shortcuts

**Root README:**
- Boasts functionalities (18 package descriptions)
- Architecture diagram showing event-based discovery
- Brief commands table (category/prefix/examples)
- Brief agent tools table
- Development setup and project structure
- Contributing guidelines

**Format applied:**
1. Hero — why this exists, base concept
2. User controls — commands, shortcuts
3. Special Triggers — coexists behavior, footer/info-screen registration
4. Agent section — tools available
5. Configurables — settings, presets

**AI-isms removed:**
- No em dashes (replaced with commas/periods)
- No bold overuse
- No emoji in headers
- No hollow intensifiers (truly, robust, comprehensive)
- No template phrases
- No generic conclusions
- Varied sentence length
- Direct, specific language

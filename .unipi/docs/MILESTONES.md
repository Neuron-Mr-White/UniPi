---
title: "Unipi Project Milestones"
created: 2026-04-28
updated: 2026-04-28
---

# Unipi Project Milestones

## Phase 1: Foundation & Core
> Monorepo scaffold, core module, workflow engine, ralph loop, and meta-package. All bug fixes and quick-work resolved.

- [x] Phase 1 Core scaffold — monorepo structure, @pi-unipi/core, constants, events
- [x] @pi-unipi/workflow extension — brainstorm, plan, work, and review skills
- [x] @pi-unipi/ralph — persistent multi-iteration development loop
- [x] unipi meta-package — npm install brings everything
- [x] npm publish configuration and root package.json
- [x] All 10 fix docs resolved (ask-user, memory, milestone, notify fixes)
- [x] All 11 quick-work docs resolved (telegram, subagent, registration fixes)
- [x] Hello world design entry point

## Phase 2: Feature Modules
> All major feature packages built, integrated, and tested.

- [x] Info Screen — TUI dashboard with tabbed groups, settings, boot render (25/25 tasks)
- [x] Subagents — parallel agent spawning, file locking, ESC propagation, custom types (15/15 tasks)
- [x] Memory — persistent cross-session memory, hybrid search, FTS5, embedding (12/12 tasks)
- [x] Compactor — message pipeline, session tracking, sandbox, tools, diff rendering (23/23 tasks)
- [x] MCP — Model Context Protocol client, catalog sync, tool translator, overlays (10/10 tasks)
- [x] Notify — multi-platform notifications (native, Gotify, Telegram), events, TUI setup (13/13 tasks)
- [x] Utilities Enchantment — process lifecycle, cache, analytics, diagnostics, batch execution (17/17 tasks)
- [x] Ask-User / Utility — structured user input, single/multi-select, freeform, timeout (10/10 tasks)
- [x] Web API — 7 search providers, web-read, web-llm-summarize, cache, settings TUI (20/20 tasks)
- [x] Autocomplete Enhancement — fuzzy matching, command registry, provider integration (5/5 tasks)

## Phase 3: Milestone & Kanban
> Project tracking, visualization, and workflow dashboards.

- [x] Milestone module — parser, writer, session hooks, coexist triggers, commands
- [x] Milestone onboard skill — scan docs, propose phases, write MILESTONES.md
- [x] Milestone update skill — sync milestones with completed work
- [ ] Milestone README and workflow README documentation update
- [ ] Kanboard module scaffold — package structure, constants, types
- [ ] Kanboard HTTP server with port allocation
- [ ] Kanboard parsers — spec, plan, milestone, quick-work, debug, fix, chore, review
- [ ] Kanboard shared HTML layout and web pages (milestone, workflow)
- [ ] Kanboard copy-to-clipboard component
- [ ] Kanboard TUI overlay
- [ ] Kanboard doctor skill and command registration
- [ ] Kanboard extension entry, README, and integration testing

## Phase 4: Impeccable & Design Quality
> Integrate Impeccable design system for frontend excellence. Audit and perfect Unipi's own UI.

- [ ] Build @pi-unipi/impeccable package — wrap impeccable skill and 23 commands for Unipi
- [ ] Integrate impeccable references (typography, color, spatial, motion, interaction, responsive, UX writing)
- [ ] Import impeccable anti-patterns catalog into Unipi workflow
- [ ] Unipi frontend style audit — run /impeccable audit and /impeccable critique on all TUI overlays
- [ ] Fix guide enchantment package — enhance fix workflow with design-aware guidance and anti-pattern detection
- [ ] Leverage impeccable in workflow skills — integrate audit/polish into plan and review phases
- [ ] Add impeccable CLI detection (npx impeccable detect) as a workflow tool
- [ ] Write impeccable integration skill documentation

## Phase 5: Polish & Enhancement
> Sound notifications, priority system, deferred testing, and quality improvements.

- [ ] Notify Sound & Priority — SoundConfig, ChannelConfig, EventConfig types
- [ ] Notify MIDI playback engine and default sound asset
- [ ] Notify priority threshold dispatch logic
- [ ] Notify native appID fix (default "Pi Notifications")
- [ ] Notify TUI settings overlay — event priority 0-10 cycle, threshold slider
- [ ] Notify user MIDI copy utility for custom sounds
- [ ] Compactor Ralph audit — review 3 external packages for integration gaps
- [ ] Ask-User deferred manual testing — single-select, multi-select, freeform, timeout
- [ ] Ask-User skill integration testing
- [ ] Info Screen acceptance criteria verification (10 items)

## Phase 6: Extension Manager & Release
> Pi extension management tooling, final packaging, publishing, and distribution.

- [ ] Pi extension manager — discover, install, update, and remove pi extensions
- [ ] Extension registry and version management
- [ ] Extension health check and dependency resolution
- [ ] Full Release chore — all code committed, main branch, npm logged in
- [ ] All packages typecheck cleanly
- [ ] All tests pass
- [ ] All packages mounted correctly in root and info-screen
- [ ] All commands registered correctly in command registry
- [ ] Documentation is accurate and compelling
- [ ] All packages published to npm with new versions
- [ ] Changes pushed to GitHub
- [ ] Git tag created

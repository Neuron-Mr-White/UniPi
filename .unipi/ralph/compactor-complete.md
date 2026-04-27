## Task: Complete All Deferred @pi-unipi/compactor Items

Complete all deferred items and fix critical wiring gaps in the compactor package.

### Critical Fixes (must do first)

1. **Tool Registration** — All 10 tool files exist but are NOT registered via `pi.registerTool()`. Need to create `packages/compactor/src/tools/register.ts` that registers all tools with proper TypeBox schemas, then call it from `session_start` in index.ts.

2. **Display Override Wiring** — Tool override renderers exist as pure functions but are NOT connected to Pi's tool display. Need to wire them via the `tool_result` event handler to transform output before display.

3. **Command Stubs → Real** — 7 of 9 commands just print "use the tool". Wire them to actually invoke the tool functions directly.

### Deferred Tasks to Complete

4. **Task 3: TUI Settings Overlay** — Interactive overlay for navigating strategies, toggling, cycling modes, applying presets. Follow ask-ui.ts pattern: `(tui, theme, kb, done) => { render, invalidate, handleInput }`. Register via `pi.registerCommand("compact-settings", ...)`.

5. **Task 20: Skills** — Create skill files:
   - `packages/compactor/skills/compactor/SKILL.md` — routing decision tree
   - `packages/compactor/skills/compactor-tools/SKILL.md` — tool reference card
   - `packages/compactor/skills/compactor-ops/SKILL.md` — engineering ops orchestration
   - `packages/compactor/skills/compactor-stats/SKILL.md` — stats display
   - `packages/compactor/skills/compactor-doctor/SKILL.md` — diagnostics

6. **Task 10 Partial: Trigram/RRF/Fuzzy** — Add trigram search, RRF fusion, fuzzy correction to ContentStore.

7. **Task 12 Partial: `.pi/settings.json` Permission Patterns** — Read permission patterns from project settings.

8. **Task 14 Partial: Syntax Highlighting + Nerd Font Detection** — Add syntax highlighting to diff renderer, detect Nerd Fonts for fancy indicators.

9. **Task 22 Partial: Integration Tests** — Write integration tests with real session fixtures. Measure coverage.

10. **Task 23: Performance + Edge Cases** — Benchmark compaction on large sessions, test edge cases (empty session, no files, no commits, corrupt DB, missing config), verify process cleanup.

### Key Patterns to Follow

- Tool registration: Use `(pi as any).registerTool?.(tool)` pattern from MCP extension
- ToolDefinition: `{ name, label, description, parameters: TypeBoxSchema, execute: async (toolCallId, params, signal, onUpdate, ctx) => AgentToolResult }`
- TUI overlay: Follow ask-ui.ts pattern from @pi-unipi/ask-user
- Skills: Follow @pi-unipi/mcp skill structure

### Verification

After all changes:
- `npx tsc --noEmit --skipLibCheck` must pass
- `bun test packages/compactor/tests/` must pass (all existing + new tests)
- All 10 tools must be registered in session_start
- All 9 commands must do real work (not stubs)
- Skills directory must have 5 SKILL.md files

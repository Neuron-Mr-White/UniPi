---
title: "Workflow Architecture & Command System — Gathered Context"
type: context-gathered
date: 2026-04-29
---

# Workflow Architecture & Command System — Gathered Context

## 1. Package Structure

```
@pi-unipi/unipi (umbrella package)
├── @pi-unipi/core          — constants, events, sandbox, utils
├── @pi-unipi/workflow      — 20 commands, 19 skills, sandbox enforcement
├── @pi-unipi/ralph         — long-running dev loops
├── @pi-unipi/memory        — cross-session memory (memory_store, memory_search, etc.)
├── @pi-unipi/compactor     — context management (compact, ctx_execute, ctx_index, etc.)
├── @pi-unipi/ask-user      — structured user input (ask_user)
├── @pi-unipi/notify        — notifications (notify_user)
├── @pi-unipi/utility       — session utilities (ctx_batch, ctx_env, set_session_name)
├── @pi-unipi/web-api       — web research (web_search, web_read, web_fetch, etc.)
├── @pi-unipi/mcp           — MCP server integration
├── @pi-unipi/kanboard      — task board UI
├── @pi-unipi/milestone     — milestone tracking
└── @pi-unipi/btw           — side-conversation workflow
```

## 2. Workflow Flow

```
brainstorm → plan → work → review-work → consolidate
    ↑                                        │
    └────────────────────────────────────────┘
                    (loop)
```

### Detailed Flow with Prefixes

```
/unipi:brainstorm <topic>
    └── generates: .unipi/docs/specs/YYYY-MM-DD-<topic>-design.md
        └── prefix: specs:

/unipi:plan specs:<file> (multiple allowed)
    └── generates: .unipi/docs/plans/YYYY-MM-DD-<topic>-plan.md
        └── prefix: plan:

/unipi:work plan:<file>
    └── generates: commits on branch (worktree or main)
        └── progress tracked in plan file (unstarted → in-progress → completed)

/unipi:review-work plan:<file>
    └── generates: REVIEWER-REMARK appended to plan file
        └── output: .unipi/docs/reviews/ (optional)

/unipi:consolidate
    └── generates: .unipi/memory/ files
```

### Alternative Flows

```
Quick:     /unipi:quick-work <task>              → .unipi/docs/quick-work/
Debug:     /unipi:debug <bug> → /unipi:fix       → .unipi/docs/debug/ + .unipi/docs/fix/
Research:  /unipi:research <topic>                → .unipi/docs/research/
Context:   /unipi:gather-context <topic>          → .unipi/docs/context-gathered/
Scan:      /unipi:scan-issues <scope>             → findings in conversation
Document:  /unipi:document <target>               → .unipi/docs/generated/
Chore:     /unipi:chore-create → chore-execute    → .unipi/docs/chore/
Auto:      /unipi:auto <topic>                    → full pipeline (brainstorm→plan→work→review→merge)
```

## 3. Command Registration Architecture

### Registration Chain
1. `@pi-unipi/workflow/index.ts` → extension entry point
2. Calls `registerWorkflowCommands(pi, options)` from `commands.ts`
3. Each command registered via `pi.registerCommand("unipi:<name>", { ... })`
4. Command handler: loads SKILL.md → builds message → sends via `pi.sendUserMessage()`

### Command Registration Object
```typescript
pi.registerCommand("unipi:<name>", {
  description: string,
  getArgumentCompletions: (prefix) => items[] | null,
  handler: async (args, ctx) => {
    // 1. Apply sandbox (save tools, set new tools)
    // 2. Load SKILL.md content
    // 3. Build message: "Execute the <skill> workflow.\n\nArguments: <args>\n\n<skill_content>...</skill_content>"
    // 4. Send as user message
  }
})
```

### Autocomplete System
- `getArgumentCompletions(prefix)` returns `{ value, label, description }[]` or `null`
- Fuzzy matching in `@mariozechner/pi-tui/dist/fuzzy.js` — score-based, no priority
- `CombinedAutocompleteProvider` in `@mariozechner/pi-tui/dist/autocomplete.js`
- Registration order: builtins → prompt templates → extension commands (`unipi:*`) → skill commands (`skill:*`)

### Current Autocomplete Providers per Command
| Command | Provider | Prefix |
|---------|----------|--------|
| `plan` | `suggestSpecFiles` | `specs:` |
| `work` | `suggestPlanFiles` | `plan:` |
| `review-work` | `suggestPlanFiles` | `plan:` |
| `auto` | `suggestPlanFiles` | `plan:` |
| `fix` | `suggestDebugFiles` | `debug:` |
| `chore-execute` | `suggestChoreFiles` | `chore:` |
| `worktree-create` | `suggestWorktrees` | (branch name) |
| `worktree-merge` | `suggestWorktrees` | (branch name) |
| `research` | `suggestResearchFiles` | `research:` |
| `gather-context` | `suggestGatheredFiles` | `gathered:` |
| Others | `null` (free-text) | — |

## 4. Sandbox System

### Sandbox Levels (Current)
| Level | Tools | Used By |
|-------|-------|---------|
| `read_only` | read, grep, find, ls | worktree-list, consultant |
| `research` | read, grep, find, ls, bash, web_* | gather-context, scan-issues, research |
| `brainstorm` | read, grep, find, ls, write, ask_user | brainstorm |
| `write_unipi` | read, write, edit, grep, find, ls, ask_user | plan, consolidate, document, chore-create |
| `debug` | read, grep, find, ls, write, bash, ask_user | debug |
| `review` | read, write, edit, grep, find, ls, bash, ask_user | review-work |
| `full` | all 35+ tools | work, auto, fix, quick-fix, quick-work, worktree-create, worktree-merge, chore-execute |

### Sandbox Enforcement
1. **Tool filtering**: `pi.on("tool_call")` blocks tools not in current sandbox level
2. **System prompt injection**: `pi.on("before_agent_start")` injects `<sandbox>` block telling LLM what's available
3. **Tool list update**: `pi.setActiveTools(tools)` updates available tools
4. **Restore on end**: `pi.on("agent_end")` restores original tools

### Sandbox Flow per Command
```
handler called
  → save current tools
  → getToolsForCommand(cmd.name)
  → setActiveTools(tools, level)
  → load SKILL.md
  → send message
  → [agent runs with restricted tools]
  → agent_end fires
  → restore original tools
```

## 5. All Available Tools (with @pi-unipi/unipi installed)

### File Operations
| Tool | Purpose | Source |
|------|---------|--------|
| `read` | Read file contents (text + images) | pi built-in |
| `write` | Create/overwrite files | pi built-in |
| `edit` | Precise text replacement in files | pi built-in |
| `bash` | Execute shell commands | pi built-in |

### Web Tools (@pi-unipi/web-api)
| Tool | Purpose |
|------|---------|
| `web_search` | Search web (DuckDuckGo, Jina, SerpAPI, Tavily, Perplexity) |
| `web_read` | Read URL content as markdown |
| `web_llm_summarize` | Fetch + LLM summarize URL |
| `web_fetch` | Browser-grade TLS fetch |
| `batch_web_fetch` | Concurrent multi-URL fetch |

### Memory Tools (@pi-unipi/memory)
| Tool | Purpose |
|------|---------|
| `memory_store` | Store cross-session memory |
| `memory_search` | Search memories (scope: project/all) |
| `memory_delete` | Delete memory by title/ID |
| `memory_list` | List project memories |
| `global_memory_search` | Search all projects |
| `global_memory_list` | List all projects |

### Compactor Tools (@pi-unipi/compactor)
| Tool | Purpose |
|------|---------|
| `compact` | Trigger manual context compaction |
| `vcc_recall` | Search session history (BM25/regex) |
| `ctx_execute` | Run code in sandboxed environment (11 languages) |
| `ctx_execute_file` | Execute file in sandbox |
| `ctx_batch_execute` | Batch code execution |
| `ctx_index` | Index content into FTS5 |
| `ctx_search` | Search indexed content |
| `ctx_fetch_and_index` | Fetch URL + index |
| `ctx_stats` | Context savings dashboard |
| `ctx_doctor` | Diagnostics |

### Utility Tools (@pi-unipi/utility + @pi-unipi/ask-user + @pi-unipi/notify)
| Tool | Purpose |
|------|---------|
| `ask_user` | Structured user input (single-select, multi-select, freeform) |
| `notify_user` | Send notifications (native, Gotify, Telegram) |
| `ctx_batch` | Atomic batch commands |
| `ctx_env` | Environment info |
| `set_session_name` | Set session title |

### Ralph Tools (@pi-unipi/ralph)
| Tool | Purpose |
|------|---------|
| `ralph_start` | Start long-running dev loop |
| `ralph_done` | Advance loop iteration |

## 6. Directory Structure

```
.unipi/
├── docs/
│   ├── specs/              ← brainstorm output (design specs)
│   ├── plans/              ← plan output (implementation plans)
│   ├── generated/          ← document output (docs, guides)
│   ├── reviews/            ← review remarks
│   ├── debug/              ← debug reports
│   ├── fix/                ← fix reports
│   ├── quick-work/         ← quick-work summaries
│   ├── chore/              ← reusable chore definitions
│   ├── research/           ← research reports
│   └── context-gathered/   ← gathered context
├── memory/                 ← consolidate memory
├── config/                 ← badge, mcp, notify configs
├── ralph/                  ← ralph loop state
└── worktrees/              ← git worktrees
```

## 7. Naming Conventions

### File Naming
- Pattern: `YYYY-MM-DD-<topic>-<type>.md`
- Examples:
  - `2026-04-29-auth-redesign-design.md` (spec)
  - `2026-04-29-auth-redesign-plan.md` (plan)
  - `2026-04-29-auth-timeout-debug.md` (debug)
  - `2026-04-29-auth-timeout-fix.md` (fix)

### Command Naming
- All prefixed with `unipi:` (from `UNIPI_PREFIX` constant)
- Kebab-case: `brainstorm`, `plan`, `review-work`, `quick-fix`, `chore-execute`
- Handoff format: `/unipi:<command> <prefix>:<file> <description>`

### Prefix Convention
| Prefix | Content | Source |
|--------|---------|--------|
| `specs:` | Design spec files | `/unipi:brainstorm` output |
| `plan:` | Implementation plan files | `/unipi:plan` output |
| `debug:` | Debug reports | `/unipi:debug` output |
| `chore:` | Chore definitions | `/unipi:chore-create` output |
| `research:` | Research reports | `/unipi:research` output |
| `gathered:` | Gathered context | `/unipi:gather-context` output |

### Task Status Lifecycle (in plan files)
| Status | Meaning |
|--------|---------|
| `unstarted:` | Not started |
| `in-progress:` | Being worked on |
| `completed:` | Done and verified |
| `failed:` | Attempted but failed |
| `awaiting_user:` | Needs user action |
| `blocked:` | Waiting on dependency |
| `skipped:` | Intentionally not doing |

### Brainstorm Checklist Semantics
- `[ ]` = unplanned (not covered by a plan)
- `[x]` = planned (covered by a plan, NOT done)
- Implementation progress tracked in plan file, not spec

## 8. Integration Points

### Events System (`pi.events`)
- `UNIPI_EVENTS.MODULE_READY` — module announces presence
- `UNIPI_EVENTS.MODULE_GONE` — module disconnects
- `pi.on("session_start")` — session begins
- `pi.on("session_shutdown")` — session ends
- `pi.on("tool_call")` — intercept tool calls
- `pi.on("before_agent_start")` — inject system prompt
- `pi.on("agent_end")` — cleanup

### Cross-Module Detection
- Ralph detection: checks if `ralph_start` tool exists in `pi.getAllTools()`
- Module discovery: listens for `MODULE_READY` events
- Sandbox enforcement: per-command tool filtering

## 9. Key Files

| File | Purpose |
|------|---------|
| `packages/core/constants.ts` | All shared constants (commands, dirs, tools) |
| `packages/core/sandbox.ts` | Sandbox levels and tool mappings |
| `packages/core/utils.ts` | Shared utilities (sanitize, initUnipiDirs, etc.) |
| `packages/core/events.ts` | Event type definitions |
| `packages/workflow/index.ts` | Extension entry point, sandbox enforcement |
| `packages/workflow/commands.ts` | Command registration, autocomplete providers |
| `packages/workflow/skills/*/SKILL.md` | Skill instructions for each command |

## 10. Command Suggestion System (External)

### Architecture
- Fuzzy matching: `@mariozechner/pi-tui/dist/fuzzy.js` — pure score-based
- Autocomplete: `@mariozechner/pi-tui/dist/autocomplete.js` — `CombinedAutocompleteProvider`
- Registration: `pi-coding-agent/dist/modes/interactive/interactive-mode.js`

### Registration Order
1. Built-in system commands (`BUILTIN_SLASH_COMMANDS`)
2. Prompt templates
3. Extension commands (`unipi:*` via `extensionRunner.getRegisteredCommands()`)
4. Skill commands (`skill:*` when `enableSkillCommands` is true)

### Known Issue
- No priority system for command sorting
- `skill:` and `unipi:` commands with same suffix get identical fuzzy scores
- Need priority mechanism or deduplication logic

# Unipi

All-in-one extension suite for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Install

**All-in-one:**
```bash
pi install npm:@pi-unipi/unipi
```

**Individual packages:**
```bash
pi install npm:@pi-unipi/core
pi install npm:@pi-unipi/workflow
pi install npm:@pi-unipi/ralph
pi install npm:@pi-unipi/memory
pi install npm:@pi-unipi/info-screen
pi install npm:@pi-unipi/subagents
pi install npm:@pi-unipi/btw
pi install npm:@pi-unipi/web-api
pi install npm:@pi-unipi/compactor
pi install npm:@pi-unipi/notify
pi install npm:@pi-unipi/utility
pi install npm:@pi-unipi/mcp
pi install npm:@pi-unipi/ask-user
```

## Packages

| Package | Description |
|---------|-------------|
| `@pi-unipi/core` | Shared utilities, event types, constants |
| `@pi-unipi/workflow` | 20 structured development workflow commands |
| `@pi-unipi/ralph` | Long-running iterative development loops |
| `@pi-unipi/memory` | Persistent cross-session memory with vector search |
| `@pi-unipi/info-screen` | Dashboard and module registry overlay |
| `@pi-unipi/subagents` | Parallel sub-agent execution with file locking |
| `@pi-unipi/btw` | Parallel side conversations with `/btw` |
| `@pi-unipi/web-api` | Web search, read, and summarize with provider selection |
| `@pi-unipi/compactor` | Session compaction, context management, batch execution |
| `@pi-unipi/notify` | Cross-platform notifications (native, Gotify, Telegram) |
| `@pi-unipi/utility` | Environment info, diagnostics, settings inspector, cleanup |
| `@pi-unipi/mcp` | MCP server discovery, connection, and tool integration |
| `@pi-unipi/ask-user` | Structured user input with options and freeform text |

## Commands

### Workflow (`/unipi:*`)

| Command | Description |
|---------|-------------|
| `/unipi:brainstorm` | Collaborative discovery |
| `/unipi:plan` | Strategic planning |
| `/unipi:work` | Execute plan in worktree |
| `/unipi:review-work` | Review what was built |
| `/unipi:consolidate` | Merge findings, update docs |
| `/unipi:auto` | Full pipeline — brainstorm → plan → work → review → merge |
| `/unipi:worktree-create` | Create git worktree |
| `/unipi:worktree-list` | List all worktrees |
| `/unipi:worktree-merge` | Merge worktree back |
| `/unipi:consultant` | Expert panel review |
| `/unipi:quick-work` | Fast single-task execution |
| `/unipi:gather-context` | Research codebase |
| `/unipi:document` | Generate documentation |
| `/unipi:scan-issues` | Find bugs, anti-patterns |
| `/unipi:debug` | Active bug investigation — reproduce, diagnose, root-cause |
| `/unipi:fix` | Fix bugs using debug reports |
| `/unipi:quick-fix` | Fast one-shot fix for clear bugs |
| `/unipi:research` | Deep codebase investigation and documentation review |
| `/unipi:chore-create` | Create reusable chore (deploy, publish, etc.) |
| `/unipi:chore-execute` | Run a saved chore |

### Ralph (`/unipi:ralph`)

| Command | Description |
|---------|-------------|
| `/unipi:ralph start <name>` | Start a loop |
| `/unipi:ralph stop` | Pause current loop |
| `/unipi:ralph resume <name>` | Resume a paused loop |
| `/unipi:ralph status` | Show all loops |
| `/unipi:ralph cancel <name>` | Delete loop state |
| `/unipi:ralph archive <name>` | Archive completed loop |
| `/unipi:ralph clean` | Clean completed loops |
| `/unipi:ralph nuke` | Delete all ralph data |

### Memory (`/unipi:*-memory-*`)

| Command | Description |
|---------|-------------|
| `/unipi:memory-process <text>` | Store extracted memories |
| `/unipi:memory-search <term>` | Search project memories |
| `/unipi:memory-consolidate` | Consolidate session into memory |
| `/unipi:memory-forget <title>` | Delete a memory |
| `/unipi:global-memory-search <term>` | Search global memories |
| `/unipi:global-memory-list` | List all global memories |

### BTW (`/btw*`)

| Command | Description |
|---------|-------------|
| `/btw [--save] <question>` | Side conversation (contextual) |
| `/btw:tangent [--save] <q>` | Contextless tangent thread |
| `/btw:new [question]` | Fresh thread with main-session context |
| `/btw:clear` | Dismiss and clear thread |
| `/btw:inject [instructions]` | Send full thread to main agent |
| `/btw:summarize [instr]` | Summarize and inject into main agent |

### Info Screen (`/unipi:info*`)

| Command | Description |
|---------|-------------|
| `/unipi:info` | Show info dashboard |
| `/unipi:info-settings` | Configure info display |

### Web API (`/unipi:web-*`)

| Command | Description |
|---------|-------------|
| `/unipi:web-settings` | Configure providers and API keys |
| `/unipi:web-cache-clear` | Clear all cached web content |

### Compactor (`/unipi:compact*`)

| Command | Description |
|---------|-------------|
| `/unipi:compact` | Compact session into brief |
| `/unipi:compact-recall` | Recall from compacted sessions |
| `/unipi:compact-stats` | Show compaction statistics |
| `/unipi:compact-doctor` | Diagnose compactor issues |
| `/unipi:compact-settings` | Configure compactor |
| `/unipi:compact-preset` | Apply compaction presets |
| `/unipi:compact-index` | Index context for search |
| `/unipi:compact-search` | Search indexed context |
| `/unipi:compact-purge` | Purge old compacted data |

### Notify (`/unipi:notify-*`)

| Command | Description |
|---------|-------------|
| `/unipi:notify-settings` | Configure notification platforms |
| `/unipi:notify-set-gotify` | Set Gotify server config |
| `/unipi:notify-set-tg` | Set Telegram bot config |
| `/unipi:notify-test` | Test notification delivery |

### Utility (`/unipi:*`)

| Command | Description |
|---------|-------------|
| `/unipi:env` | Show environment info |
| `/unipi:doctor` | Run diagnostics |
| `/unipi:status` | Show module status |
| `/unipi:cleanup` | Clean stale temp files |
| `/unipi:reload` | Reload extensions |

### MCP (`/unipi:mcp-*`)

| Command | Description |
|---------|-------------|
| `/unipi:mcp-add` | Add MCP server |
| `/unipi:mcp-settings` | Configure MCP servers |
| `/unipi:mcp-sync` | Sync MCP tools |
| `/unipi:mcp-status` | Show MCP connection status |
| `/unipi:mcp-reload` | Reload MCP connections |

### Tools

| Tool | Package | Description |
|------|---------|-------------|
| `ralph_start` | ralph | Start a ralph loop |
| `ralph_done` | ralph | Signal iteration complete |
| `spawn_helper` | subagents | Spawn parallel sub-agent |
| `get_helper_result` | subagents | Retrieve background agent result |
| `memory_store` | memory | Store/update memory |
| `memory_search` | memory | Search project memories |
| `memory_delete` | memory | Delete memory by ID |
| `memory_list` | memory | List project memories |
| `global_memory_search` | memory | Search global memories |
| `global_memory_list` | memory | List global memories |
| `web_search` | web-api | Search the web via provider |
| `web_read` | web-api | Extract content from URL |
| `web_llm_summarize` | web-api | Summarize web content via LLM |
| `notify_user` | notify | Send cross-platform notifications |
| `ask_user` | ask-user | Structured user input with options |
| `compact` | compactor | Compact session context |
| `vcc_recall` | compactor | Recall from compacted sessions |
| `ctx_execute` | compactor | Execute with context management |
| `ctx_batch_execute` | compactor | Batch execute with rollback |
| `ctx_index` | compactor | Index context for search |
| `ctx_search` | compactor | Search indexed context |
| `ctx_fetch_and_index` | compactor | Fetch and index web content |
| `ctx_stats` | compactor | Show compaction statistics |
| `ctx_doctor` | compactor | Diagnose compactor issues |

## How It Works

**Core** provides shared infrastructure — event types, constants, utilities — so modules discover each other without tight coupling.

**Workflow** provides 20 commands guiding work from idea to completion: brainstorm → plan → work → review → consolidate, plus quick-fix, debug, research, chore, and more.

**Ralph** enables long-running iterative tasks. Start a loop, the agent works through iterations, reflects periodically, and completes when done.

**Memory** provides persistent cross-session memory with SQLite + vector search. Project-scoped and global memories with hybrid search.

**Info Screen** is a dashboard overlay showing module status, registered tools, and custom groups from all modules.

**BTW** adds a parallel side-conversation channel. Ask questions while the main agent keeps working, then inject or summarize the thread back.

**Subagents** enables parallel execution with file locking, activity tracking, and custom agent types.

**Web API** provides web search, page reading, and LLM summarization through a ranked provider system. DuckDuckGo and Jina work out of the box; paid providers (SerpAPI, Tavily, Firecrawl, Perplexity) are configured via `/unipi:web-settings`.

**Compactor** manages session context with compaction, indexing, search, and batch execution. Keep context lean without losing important information.

**Notify** sends notifications across platforms — native OS, Gotify, and Telegram. Configure once, get alerts everywhere.

**Utility** provides environment info, diagnostics, settings inspection, and cleanup tools for maintaining your development environment.

**MCP** integrates Model Context Protocol servers — discover, connect, and use external tool servers seamlessly.

**Ask User** provides structured user input with multiple-choice, multi-select, and freeform text options.

## Module Discovery

Modules announce presence via `pi.events`. When `@pi-unipi/workflow` detects `@pi-unipi/ralph`, it enables loop integration. Each module works standalone.

## Development

```bash
git clone https://github.com/Neuron-Mr-White/unipi.git
cd unipi
npm install
npm run typecheck
```

## License

MIT

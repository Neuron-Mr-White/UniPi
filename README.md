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
```

## Packages

| Package | Description |
|---------|-------------|
| `@pi-unipi/core` | Shared utilities, event types, constants |
| `@pi-unipi/workflow` | 13 structured development workflow commands |
| `@pi-unipi/ralph` | Long-running iterative development loops |
| `@pi-unipi/memory` | Persistent cross-session memory with vector search |
| `@pi-unipi/info-screen` | Dashboard and module registry overlay |
| `@pi-unipi/subagents` | Parallel sub-agent execution with file locking |
| `@pi-unipi/btw` | Parallel side conversations with `/btw` |
| `@pi-unipi/web-api` | Web search, read, and summarize with provider selection |

## Commands

### Workflow (`/unipi:*`)

| Command | Description |
|---------|-------------|
| `/unipi:brainstorm` | Collaborative discovery |
| `/unipi:plan` | Strategic planning |
| `/unipi:work` | Execute plan in worktree |
| `/unipi:review-work` | Review what was built |
| `/unipi:consolidate` | Merge findings, update docs |
| `/unipi:worktree-create` | Create git worktree |
| `/unipi:worktree-list` | List all worktrees |
| `/unipi:worktree-merge` | Merge worktree back |
| `/unipi:consultant` | Expert panel review |
| `/unipi:quick-work` | Fast single-task execution |
| `/unipi:gather-context` | Research codebase |
| `/unipi:document` | Generate documentation |
| `/unipi:scan-issues` | Find bugs, anti-patterns |

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

## How It Works

**Core** provides shared infrastructure — event types, constants, utilities — so modules discover each other without tight coupling.

**Workflow** provides 13 commands guiding work from idea to completion via brainstorm → plan → work → review → consolidate.

**Ralph** enables long-running iterative tasks. Start a loop, the agent works through iterations, reflects periodically, and completes when done.

**Memory** provides persistent cross-session memory with SQLite + vector search. Project-scoped and global memories with hybrid search.

**Info Screen** is a dashboard overlay showing module status, registered tools, and custom groups from all modules.

**BTW** adds a parallel side-conversation channel. Ask questions while the main agent keeps working, then inject or summarize the thread back.

**Subagents** enables parallel execution with file locking, activity tracking, and custom agent types.

**Web API** provides web search, page reading, and LLM summarization through a ranked provider system. DuckDuckGo and Jina work out of the box; paid providers (SerpAPI, Tavily, Firecrawl, Perplexity) are configured via `/unipi:web-settings`.

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

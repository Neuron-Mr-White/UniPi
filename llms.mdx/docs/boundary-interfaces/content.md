# Boundary Interfaces (/docs/boundary-interfaces)



This document describes the system's external invocation interfaces, including CLI commands, API endpoints, configuration parameters, and other boundary mechanisms.

## Command Line Interface (CLI) [#command-line-interface-cli]

### pi extension activation (default export) [#pi-extension-activation-default-export]

**Description**: Every @pi-unipi/\* package exposes a default `(pi: ExtensionAPI) => void | Promise<void>` activation function referenced by the package.json `main` field. The Pi coding agent host loads the package, calls this function, and the package registers tools, slash commands, hooks and TUI widgets. There is no standalone binary; the startup surface is the extension loader plus configuration files and environment variables.

**Source File**: `./packages/*/index.ts, ./packages/*/src/index.ts`

**Arguments**:

* `pi` (ExtensionAPI): required - Host-provided ExtensionAPI instance used to register tools, commands, hooks and UI.

**Options**:

* `~/.unipi/config/<module>.json`(json file): optional - Global per-module configuration file (e.g. background-tasks.json, subagents.json, compactor). Loaded and validated at activation; missing files are scaffolded with defaults where supported. (default: `module defaults`)
* `<cwd>/.unipi/config/<module>.json`(json file): optional - Workspace-level configuration override. Deep-merged over the global layer, workspace values win.

**Usage Examples**:

```bash
pi  # host loads @pi-unipi/* extensions listed in its extension config
```

```bash
import unipiSubagents from '@pi-unipi/subagents'; unipiSubagents(pi);
```

### /unipi:model [#unipimodel]

**Description**: Opens the fusion model picker TUI overlay. Lets the user select a lead/sidekick model pair from the Pi model registry, applies the result to the persisted FusionPreset, spawns the sidekick runtime and publishes session status (active pair, savings). Also injects itself as the first suggestion of the built-in `/model` autocomplete.

**Source File**: `./packages/fusion/src/index.ts`

**Usage Examples**:

```bash
/unipi:model
```

```bash
/model  # fusion picker is pinned as first suggestion
```

### /unipi:fusion-preset [#unipifusion-preset]

**Description**: Opens the preset editor overlay for editing fusion presets (lead/sidekick pairs, effort levels, badges, cost overrides). Changes are persisted to the global preset file with an optional project-layer override.

**Source File**: `./packages/fusion/src/index.ts`

**Usage Examples**:

```bash
/unipi:fusion-preset
```

### /unipi:ralph [#unipiralph]

**Description**: Starts or stops a Ralph-Wiggum style autonomous loop. Dispatches to handleStart / handleStop, registers Ralph tools and argument completions, and emits RALPH\_LOOP\_START / RALPH\_LOOP\_END unipi events.

**Source File**: `./packages/ralph/index.ts`

**Arguments**:

* `subcommand` (string): required - `start <prompt/options>` to begin a loop, `stop` to terminate the running loop.
* `rest` (string): optional - Remaining argument text passed to handleStart (loop prompt / options).

**Usage Examples**:

```bash
/unipi:ralph start Fix all failing tests until green
```

```bash
/unipi:ralph stop
```

### /unipi:stash-settings [#unipistash-settings]

**Description**: Opens the settings overlay for customizing input-shortcut keybindings (stash, undo, redo, append register, copy, cut, toggle thinking).

**Source File**: `./packages/input-shortcuts/src/index.ts`

**Options**:

* `ALT+S`(keybinding): optional - Chord key that opens the shortcut action overlay; the chosen action runs as a deferred callback after the overlay closes. (default: `ALT+S`)
* `ALT+I`(keybinding): optional - Inserts a literal tab character into the input editor. (default: `ALT+I`)

**Usage Examples**:

```bash
/unipi:stash-settings
```

### /unipi:info [#unipiinfo]

**Description**: Shows the tabbed info-screen dashboard overlay. Renders cached data first, then refreshes in the background; module-ready events from other packages are batched to avoid excessive re-renders.

**Source File**: `./packages/info-screen/index.ts`

**Options**:

* `autoCloseMs`(number (ms)): optional - Optional auto-close timer passed to showOverlay when triggered programmatically.

**Usage Examples**:

```bash
/unipi:info
```

### /unipi:info-settings [#unipiinfo-settings]

**Description**: Opens the info-screen settings editor (group visibility, refresh behavior).

**Source File**: `./packages/info-screen/index.ts`

**Usage Examples**:

```bash
/unipi:info-settings
```

### /unipi:readme [#unipireadme]

**Description**: Displays the Unipi README inside a TUI overlay.

**Source File**: `./packages/updater/src/index.ts`

**Usage Examples**:

```bash
/unipi:readme
```

### /unipi:changelog [#unipichangelog]

**Description**: Displays the package changelog inside a TUI overlay.

**Source File**: `./packages/updater/src/index.ts`

**Usage Examples**:

```bash
/unipi:changelog
```

### /unipi:updater-settings [#unipiupdater-settings]

**Description**: Edits updater settings (check frequency / enable). On session\_start the updater loads settings, queries the npm registry via the checker when a check is due, and shows an update overlay if a newer version exists.

**Source File**: `./packages/updater/src/index.ts`

**Usage Examples**:

```bash
/unipi:updater-settings
```

### /unipi:continue | /unipi:reload | /unipi:status | /unipi:cleanup | /unipi:env | /unipi:doctor | /unipi:badge [#unipicontinue--unipireload--unipistatus--unipicleanup--unipienv--unipidoctor--unipibadge]

**Description**: Utility package commands: continue the last session, reload extensions, print status, clean up runtime dirs, show environment/prefix-cache info, run diagnostics, and set the session name badge shown in the Herdr pane title.

**Source File**: `./packages/utility/src/index.ts`

**Arguments**:

* `badge text` (string): optional - For /unipi:badge, the name badge / session label to display.

**Usage Examples**:

```bash
/unipi:status
```

```bash
/unipi:doctor
```

```bash
/unipi:badge my-feature
```

### /unipi:\* background-task commands (task manager, settings) [#unipi-background-task-commands-task-manager-settings]

**Description**: Background-tasks package commands that open the task manager overlay (openTaskManager) and the settings UI (openSettings). Nothing is registered when config `enabled` is false.

**Source File**: `./packages/background-tasks/src/index.ts, ./packages/background-tasks/src/config.ts`

**Arguments**:

* `initialTaskId` (string): optional - Optional task id to focus when opening the task manager.

**Options**:

* `UNIPI_BG_*`(env): optional - Environment variables injected into spawned background task processes / read by the runtime (temp-root runtime directory, task metadata).
* `enabled`(boolean): optional - Master switch in background-tasks.json; when false the module registers no tools, commands or hooks. (default: `true`)

**Usage Examples**:

```bash
/unipi:tasks
```

```bash
/unipi:tasks-settings
```

### /unipi:\* workflow, kanboard, milestone, mcp, memory, notify, ask-user, compactor, image commands [#unipi-workflow-kanboard-milestone-mcp-memory-notify-ask-user-compactor-image-commands]

**Description**: Each package registers its own /unipi:\* command set through core constant tables (WORKFLOW/KANBOARD\_COMMANDS, MILESTONE\_COMMANDS, MCP\_COMMANDS, COMPACTOR\_COMMANDS, IMAGE\_COMMANDS, UPDATER\_COMMANDS). Workflow commands dispatch to skills and enforce sandbox levels; kanboard commands start/stop the local board server; mcp commands manage server definitions; compactor commands trigger/configure compaction; image commands configure providers and models.

**Source File**: `./packages/workflow/index.ts, ./packages/kanboard/index.ts, ./packages/milestone/index.ts, ./packages/mcp/src/index.ts, ./packages/compactor/src/index.ts, ./packages/image/src/index.ts, ./packages/core (constants)`

**Usage Examples**:

```bash
/unipi:workflow <phase>
```

```bash
/unipi:kanboard
```

```bash
/unipi:mcp
```

```bash
/unipi:compact
```

```bash
/unipi:memory
```

### agent tool: spawn\_helper [#agent-tool-spawn_helper]

**Description**: LLM-invocable tool registered by the subagents package (typebox schema). Routes to management actions, workflowScript execution, or a legacy single child launch. Enforces agent enablement, budgets, depth guard, spawn limits, context policy, timeout defaults and output truncation. Parent ESC aborts all children.

**Source File**: `./packages/subagents/src/index.ts, ./packages/subagents/src/tool-handler.ts`

**Arguments**:

* `agent` (string): optional - Agent name or alias to spawn (resolved against built-in and custom agents).
* `task / prompt` (string): optional - Task description handed to the child agent.
* `workflowScript` (object): optional - Multi-step workflow script executed by the workflow runtime.
* `action` (string): optional - Management action (list, status, abort, etc.).

**Options**:

* `timeout`(number): optional - Per-child timeout; defaults applied from config. (default: `config default`)
* `async`(boolean): optional - Run via the async runner and retrieve later with get\_helper\_result. (default: `false`)

**Usage Examples**:

```bash
spawn_helper({ agent: "researcher", task: "Summarize the auth module" })
```

### agent tool: get\_helper\_result [#agent-tool-get_helper_result]

**Description**: Retrieves the output/status of an asynchronously spawned helper by id.

**Source File**: `./packages/subagents/src/index.ts`

**Arguments**:

* `id` (string): required - Helper run identifier returned by spawn\_helper.

**Usage Examples**:

```bash
get_helper_result({ id: "run-123" })
```

### agent tools: ctx\_env, set\_session\_name [#agent-tools-ctx_env-set_session_name]

**Description**: Utility tools exposed to the model: ctx\_env reports context/environment information; set\_session\_name sets the session name badge.

**Source File**: `./packages/utility/src/index.ts`

**Arguments**:

* `name` (string): optional - Session name for set\_session\_name.

**Usage Examples**:

```bash
set_session_name({ name: "refactor-auth" })
```

### agent tools: web-search, multi-web-content-read, web-llm-summarize [#agent-tools-web-search-multi-web-content-read-web-llm-summarize]

**Description**: Web-api tools: search the web via configured providers, fetch and extract content from multiple URLs through the smart-fetch engine (wreq-js + defuddle), and summarize fetched content with an LLM.

**Source File**: `./packages/web-api/src/index.ts`

**Arguments**:

* `query` (string): optional - Search query for web-search.
* `urls` (string\[]): optional - List of URLs for multi-web-content-read / web-llm-summarize.

**Usage Examples**:

```bash
web-search({ query: "typebox schema examples" })
```

### agent tools: image\_generate, image\_recognize [#agent-tools-image_generate-image_recognize]

**Description**: Image package tools registered from IMAGE\_TOOLS. Vision-related tools are gated off when the active model lacks image input (applyVisionGating). Generation goes through the OpenAI images/generations-compatible adapter.

**Source File**: `./packages/image/src/index.ts, ./packages/image/src/openai-images-api.ts`

**Arguments**:

* `prompt` (string): optional - Image generation prompt.
* `model` (string): optional - Image model id, normalized by normalizeModelId. (default: `configured default`)

**Usage Examples**:

```bash
image_generate({ prompt: "architecture diagram of the compactor" })
```

### agent tools: ask\_user, background task tools, compactor tools, memory tools, notify tools, MCP-bridged tools [#agent-tools-ask_user-background-task-tools-compactor-tools-memory-tools-notify-tools-mcp-bridged-tools]

**Description**: Other packages register tool sets via core constants (ASK\_USER\_TOOLS, COMPACTOR\_TOOLS, NOTIFY\_TOOLS) and dynamic registration: ask-user prompts the human with TUI selectors; background-tasks starts/monitors shell tasks (startTask); compactor compacts context and stores sessions; memory saves/recalls memories; notify dispatches to notification platforms; mcp translates every tool listed by a connected MCP server into a Pi tool.

**Source File**: `./packages/ask-user/index.ts, ./packages/background-tasks/src/index.ts, ./packages/compactor/src/index.ts, ./packages/memory/index.ts, ./packages/notify/index.ts, ./packages/mcp/src/index.ts`

**Usage Examples**:

```bash
ask_user({ question: "Which branch?", options: ["main", "dev"] })
```

### config: background-tasks.json [#config-background-tasksjson]

**Description**: Layered JSON configuration for the background-tasks module. Global file \~/.unipi/config/background-tasks.json is deep-merged with \<cwd>/.unipi/config/background-tasks.json (workspace wins). Unknown keys are rejected by validateBackgroundTasksConfig; global writes are atomic (temp file + rename).

**Source File**: `./packages/background-tasks/src/config.ts`

**Options**:

* `enabled`(boolean): optional - Master switch for the whole module. (default: `true`)

**Usage Examples**:

```bash
{ "enabled": true }
```

## API Interfaces [#api-interfaces]

### GET/POST (dispatched by route(method, pattern, handler)) [http://127.0.0.1:\&lt;allocated-port>/](http://127.0.0.1:\&lt;allocated-port>/) (KanboardServer routes) [#getpost-dispatched-by-routemethod-pattern-handler-http127001ltallocated-port-kanboardserver-routes]

**Description**: Local HTTP server started by the kanboard package. Allocates a free port, refuses to start if a PID file indicates a running instance, and dispatches matching routes to handlers in server/routes (which call the kanban parser, workflow and milestone layouts to render board data). Intended for a browser UI on the same machine.

**Source File**: `./packages/kanboard/server/index.ts, ./packages/kanboard/server/routes/`

**Request Format**: HTTP request; route parameters extracted from pattern

**Response Format**: HTML / JSON / static assets with CONTENT\_TYPES MIME mapping

**Authentication**: None (localhost only, PID-file single instance guard)

### GET [http://127.0.0.1:\&lt;allocated-port>/\&lt;static](http://127.0.0.1:\&lt;allocated-port>/\&lt;static) path> and docs root [#get-http127001ltallocated-portltstatic-path-and-docs-root]

**Description**: Static asset serving (ui/static, docs root via getDocsRoot). Files are served with content type resolved from the CONTENT\_TYPES map; unknown paths fall through to 404.

**Source File**: `./packages/kanboard/server/index.ts (serveStatic)`

**Request Format**: HTTP GET with file pathname

**Response Format**: File bytes with Content-Type header

**Authentication**: None

### initialize, tools/list, tools/call MCP server stdio (outbound JSON-RPC 2.0) [#initialize-toolslist-toolscall-mcp-server-stdio-outbound-json-rpc-20]

**Description**: McpClient spawns each configured MCP server as a child process and speaks JSON-RPC over stdin/stdout. Performs the initialize handshake, lists tools (listTools), invokes tools (callTool) and correlates responses by id; all pending requests are rejected on disconnect/exit.

**Source File**: `./packages/mcp/src/bridge/client.ts`

**Request Format**: Newline-delimited JSON-RPC requests \{jsonrpc, id, method, params}

**Response Format**: JSON-RPC responses \{id, result|error} parsed from buffered stdout

**Authentication**: Process-level (server command/env from MCP config)

### POST \<baseUrl>/images/generations (outbound, OpenAI-compatible) [#post-baseurlimagesgenerations-outbound-openai-compatible]

**Description**: Single adapter that implements the OpenAI images/generations HTTP contract used by OpenAI, OpenRouter, OmniRoute and similar gateways. Joins base URL and path, normalizes model ids and converts HTTP failures into model-annotated error messages.

**Source File**: `./packages/image/src/openai-images-api.ts`

**Request Format**: JSON \{model, prompt, ...}

**Response Format**: JSON \{data: \[\{b64\_json | url}]}

**Authentication**: Bearer API key from provider configuration

### GET npm registry (outbound) [#get-npm-registry-outbound]

**Description**: Updater checker queries the npm registry for the latest @pi-unipi version on session start when a check is due, then shows an update overlay.

**Source File**: `./packages/updater/src/index.ts`

**Request Format**: HTTP GET package metadata

**Response Format**: JSON package manifest

**Authentication**: None

## Router Routes [#router-routes]

### / (kanboard board UI) [#-kanboard-board-ui]

**Description**: Root page of the local kanboard web UI; handlers render the board from parsed kanban/milestone documents.

**Source File**: `./packages/kanboard/server/routes/`

### /\<pattern> (route(method, pattern, handler)) [#pattern-routemethod-pattern-handler]

**Description**: Generic route registration API of KanboardServer. Routes are matched by HTTP method and pattern and dispatched to RouteHandler functions from the routes module (workflow and milestone layouts).

**Source File**: `./packages/kanboard/server/index.ts`

**Parameters**:

* `method` (string): HTTP method to match (GET, POST, ...).
* `pattern` (string): URL pattern, may include path parameters.

### /static/\* and docs root [#static-and-docs-root]

**Description**: Static file routes served by serveStatic with MIME lookup.

**Source File**: `./packages/kanboard/server/index.ts`

**Parameters**:

* `pathname` (string): Relative file path under ui/static or the docs root.

## Integration Suggestions [#integration-suggestions]

### Pi extension loading [#pi-extension-loading]

Install the desired @pi-unipi/\* packages (or the aggregate @pi-unipi/unipi package) and add them to the Pi coding agent extension list. Each package activates through its default export and registers commands/tools automatically.

**Example Code**:

```
// pi extension config
{
  "extensions": [
    "@pi-unipi/core",
    "@pi-unipi/subagents",
    "@pi-unipi/background-tasks",
    "@pi-unipi/compactor"
  ]
}
```

**Best Practices**:

* Always load @pi-unipi/core first; every other package imports its constants and event bus.
* Load info-screen and footer last so they observe MODULE\_READY events from other modules.
* Pin package versions together; packages share core contracts and are released as a set.

### Configuration files [#configuration-files]

Configure modules through layered JSON files: a global layer in \~/.unipi/config/\<module>.json and a workspace layer in \<cwd>/.unipi/config/\<module>.json. Workspace values override global ones.

**Example Code**:

```
// ~/.unipi/config/background-tasks.json
{
  "enabled": true
}

// <project>/.unipi/config/background-tasks.json
{
  "enabled": false
}
```

**Best Practices**:

* Keep secrets (API keys) out of workspace files committed to git; use the global layer or environment variables.
* Run /unipi:doctor after editing config; validation errors are reported through the validate\* helpers.
* Let the module scaffold defaults on first run instead of hand-writing every key.

### MCP servers [#mcp-servers]

Expose external tools to the agent by adding MCP server definitions (command, args, env) to the mcp config. The bridge spawns each server over stdio, lists its tools and registers them as Pi tools.

**Example Code**:

```
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

**Best Practices**:

* Prefer servers that respond quickly to initialize; pending requests are rejected on process exit.
* Use env references rather than inline secrets in server definitions.

### Inter-module events [#inter-module-events]

Packages communicate through the core event bus (UNIPI\_EVENTS, emitEvent, MODULE\_READY). Third-party extensions can listen to these events to react to module activation, compaction, ralph loops or fusion status changes.

**Example Code**:

```
import { UNIPI_EVENTS } from "@pi-unipi/core";
pi.events.on(UNIPI_EVENTS.MODULE_READY, (payload) => {
  console.log("module ready:", payload.module, payload.version);
});
```

**Best Practices**:

* Batch reactions to MODULE\_READY (as info-screen does) to avoid re-render storms.
* Never assume optional modules (e.g. @unipi/ralph) are present; detect them via MODULE\_READY.

### Kanboard local web UI [#kanboard-local-web-ui]

Start the kanboard HTTP server through the /unipi:kanboard command and open the printed localhost URL in a browser. The server picks a free port and writes a PID file to prevent duplicate instances.

**Example Code**:

```
const server = new KanboardServer(config);
server.route("GET", "/api/board", boardHandler);
const port = await server.start();
console.log(`http://127.0.0.1:${port}`);
```

**Best Practices**:

* Treat the server as localhost-only; it has no authentication.
* Call stop() on session end to remove the PID file.

***

**Analysis Confidence**: 6.5/10

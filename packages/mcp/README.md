# @pi-unipi/mcp

Browse a catalog of 7,800+ MCP servers, add them interactively, and use their tools in Pi. MCP (Model Context Protocol) servers expose external capabilities — GitHub operations, database queries, file system access — as tools the agent can call.

The add command opens a split-pane overlay: server browser on the left, JSON config editor on the right. Pick a server, edit its config, save. Tools from added servers are automatically registered as Pi tools with the pattern `{serverName}__{toolName}`.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:mcp-add` | Open browse and editor overlay to add MCP servers |
| `/unipi:mcp-settings` | Interactive settings with enable/disable/edit |
| `/unipi:mcp-sync` | Force sync server catalog from GitHub |
| `/unipi:mcp-status` | Text summary of all configured servers |
| `/unipi:mcp-reload` | Remind you to restart Pi so tool schemas reload as a clean cache epoch |

### Setup Flow

1. Run `/unipi:mcp-add`
2. Browse or search the server catalog
3. Edit the config in the right pane
4. Save and restart Pi to activate

## Special Triggers

When MCP is installed, all workflow skills get access to MCP server tools. Tools are named `{serverName}__{toolName}` — for example, `github__search_code` or `filesystem__read_file`.

MCP registers with the info-screen dashboard, showing server count, active servers, and total tools. The footer subscribes to `MCP_SERVER_STARTED`, `MCP_SERVER_STOPPED`, and `MCP_SERVER_ERROR` events to display MCP status.

## Agent Tools

MCP tools are registered dynamically based on configured servers. Once a server is added and Pi restarts, its tools become available to the agent.

### Deterministic Definitions and Cache Behavior

At session startup, enabled servers connect and discover tools in parallel. Registration waits for all discoveries to settle, then registers the successful combined tool set in canonical `{serverName}__{toolName}` order. Duplicate final names are rejected explicitly instead of allowing one definition to overwrite another.

MCP input properties are cloned and recursively canonicalized before registration: schema object keys use locale-independent UTF-16 code-unit order, valid schema `required` string arrays are sorted and deduplicated, a missing top-level `required` becomes `[]`, and literal-value arrays keep their source order. Each tool also receives a stable label matching its final Pi name. These stable definitions and registration order prevent equivalent MCP configurations from changing the serialized tool list between runs, improving provider prompt-cache reuse. A server that fails discovery is excluded from the combined set; a registration error fails startup for that prepared set and is not reported as successful.

Pi 0.80 cannot remove dynamically registered tools. Enabling, disabling, deleting, or changing MCP servers is therefore applied on the next Pi restart rather than mutating the tool list mid-session. This prevents stale schemas and makes the restart an explicit cache-epoch boundary.

### Bounded Results

MCP text results are model-visible up to a hard 64 KiB ceiling. A larger result keeps a bounded head/tail preview and, when the raw result is at most 16 MiB, writes the complete text to a private mode-0600 artifact under `~/.unipi/tool-results/`. Existing result directories are tightened to mode 0700. The returned result includes the path and directs the agent to use `read` with offset/limit. Results above the raw safety cap or filesystem write failures still return a bounded preview with an explicit non-retention warning. MCP image bytes are not written by this text bridge; image blocks remain represented by MIME metadata as before.

Example tool calls:
```
github__search_code({ query: "authentication middleware" })
github__list_pull_requests({ state: "open" })
filesystem__read_file({ path: "/home/user/config.json" })
```

The agent doesn't need to know about MCP directly — tools appear in its tool list with the server prefix.

## Configurables

### File Locations

```
~/.unipi/config/mcp/              ← Global defaults
{project}/.unipi/config/mcp/      ← Project overrides
```

### Files at Each Level

- **`mcp-config.json`** — Server definitions (standard MCP format)
- **`config.json`** — Metadata (enabled/disabled, sync preferences)
- **`auth.json`** — Sensitive environment variables (chmod 600, optional)

### Config Format

`mcp-config.json` uses the standard MCP format compatible with Claude Desktop, Cursor, and other MCP clients:

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
```

### Config Merge Rules

1. Server exists only in global — loaded normally
2. Server exists only in project — loaded normally
3. Server exists in both — project wins entirely
4. `"enabled": false` in project metadata — disabled even if defined globally

## Troubleshooting

**Server won't start:** Check `/unipi:mcp-status` for errors, verify the command exists on your system.

**Tools not appearing:** Ensure the server is running and supports the MCP protocol.

**Config issues:** Validate JSON syntax and check file permissions.

**Sync issues:** Run `/unipi:mcp-sync`, check network. The seed catalog (49 servers) is available offline as fallback.

## License

MIT

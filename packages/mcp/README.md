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

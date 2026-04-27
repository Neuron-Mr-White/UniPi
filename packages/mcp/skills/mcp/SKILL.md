---
name: mcp
description: "MCP server management — discover, connect, and use Model Context Protocol tools"
---

# MCP Tools

MCP (Model Context Protocol) servers provide external tools that extend pi's capabilities.
Tools from MCP servers are named `{serverName}__{toolName}` — e.g., `github__search_code`.

## Adding Servers

Use `/unipi:mcp-add` to browse the catalog of 7,800+ MCP servers and add them interactively.
The split-pane overlay lets you:
- **Browse**: Search the cached server catalog by name, description, or category
- **Select**: Pick a server to get a pre-filled config template
- **Custom**: Press `c` for an empty editor to add unlisted servers manually
- **Save**: Press Enter or Ctrl+S to validate and save

## Managing Servers

Use `/unipi:mcp-settings` to manage configured servers:
- **Toggle**: Press Space to enable/disable a server
- **Delete**: Press `d` then `y` to remove a server
- **Scope**: Press `g` for global config, `p` for project config
- **Sync**: Press `s` to refresh the catalog from GitHub

## Quick Status

Use `/unipi:mcp-status` for a text summary of all servers and their status.

## Config Hierarchy

MCP config supports **global defaults** with **project overrides**:

```
~/.unipi/config/mcp/              ← Global defaults (shared across all projects)
{project}/.unipi/config/mcp/      ← Project overrides (when present)
```

**Merge rules:**
1. Server only in global → used normally
2. Server only in project → used normally
3. Server in both → project wins entirely
4. `enabled: false` in project metadata → disabled even if defined globally

### Config Files

Each level has three files:
- `mcp-config.json` — Server definitions (standard MCP format, portable)
- `config.json` — Metadata (enabled/disabled, sync prefs)
- `auth.json` — Sensitive env vars (optional, chmod 600)

### Example mcp-config.json

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
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/pi/projects"]
    }
  }
}
```

## Using MCP Tools

Once an MCP server is running, its tools are available as pi tools.
They're named with the pattern `{serverName}__{toolName}`.

For example, if you add the GitHub MCP server, you'll have tools like:
- `github__search_code`
- `github__create_issue`
- `github__list_pull_requests`

You can call these tools directly in conversations.

## Troubleshooting

### Server won't start
- Check `/unipi:mcp-status` for error details
- Verify the command exists: `which npx` or `which docker`
- Check that required env vars are set in the config

### Tools not appearing
- Ensure the server status shows "running"
- Check if the server supports the MCP tools protocol
- Try restarting pi after adding a new server

### Config issues
- Validate JSON syntax in your config files
- Check file permissions (mcp-config.json should be readable)
- Use `/unipi:mcp-settings` to view current configuration

### Catalog sync issues
- Run `/unipi:mcp-sync` to force a refresh
- Check network connectivity to GitHub
- The seed catalog (49 servers) is available offline as fallback

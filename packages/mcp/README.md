# @pi-unipi/mcp

MCP (Model Context Protocol) server management extension for Pi coding agent. Browse a catalog of 7,800+ MCP servers, add them interactively, and use their tools seamlessly within pi.

## Features

- **Browse Catalog**: Search and discover MCP servers from the awesome-mcp-servers collection
- **Interactive Add**: Split-pane overlay with server browser + JSON config editor
- **Settings Management**: Enable/disable, edit, delete servers with scope switching
- **Config Hierarchy**: Global defaults with project-level overrides
- **Auto-Discovery**: Tools from MCP servers are automatically registered as pi tools
- **Offline Support**: Bundled seed catalog with 49 curated servers as fallback

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:mcp-add` | Open browse + editor overlay to add MCP servers |
| `/unipi:mcp-settings` | Interactive settings with enable/disable/edit |
| `/unipi:mcp-sync` | Force sync server catalog from GitHub |
| `/unipi:mcp-status` | Text summary of all configured servers |

## Setup

1. Install as part of the unipi extension suite
2. Add MCP servers via `/unipi:mcp-add` or manually edit config files
3. Restart pi to activate newly added servers

## Configuration

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

1. Server exists only in global → loaded normally
2. Server exists only in project → loaded normally
3. Server exists in both → **project wins entirely**
4. `"enabled": false` in project metadata → **disabled** even if defined globally

## Tool Naming

MCP tools are registered with the pattern `{serverName}__{toolName}`:
- `github__search_code`
- `filesystem__read_file`
- `brave-search__brave_web_search`

## Architecture

```
packages/mcp/
├── src/
│   ├── index.ts              # Extension entry, command registration
│   ├── types.ts              # TypeScript interfaces
│   ├── config/
│   │   ├── schema.ts         # Defaults and validation
│   │   ├── manager.ts        # Config read/merge/write
│   │   └── sync.ts           # Catalog fetch and caching
│   ├── bridge/
│   │   ├── client.ts         # MCP JSON-RPC client (stdio)
│   │   ├── translator.ts     # MCP tool → pi tool
│   │   └── registry.ts       # Server lifecycle management
│   └── tui/
│       ├── add-overlay.ts    # /unipi:mcp-add UI
│       └── settings-overlay.ts # /unipi:mcp-settings UI
├── data/
│   └── seed-servers.json     # Offline fallback catalog (49 servers)
├── skills/mcp/
│   └── SKILL.md              # Agent instructions
├── package.json
└── README.md
```

## Troubleshooting

- **Server won't start**: Check `/unipi:mcp-status` for errors, verify command exists
- **Tools not appearing**: Ensure server is running, check MCP protocol support
- **Config issues**: Validate JSON syntax, check file permissions
- **Sync issues**: Run `/unipi:mcp-sync`, check network, seed catalog available offline

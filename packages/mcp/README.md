# MCP

Connect MCP servers to Pi so the agent can call their tools.

`@pi-unipi/mcp` · part of [UniPi](../../README.md)

MCP (Model Context Protocol) is a standard way for a server to give tools to an AI agent. Examples are GitHub operations, database queries and file access.

## What it does

- Starts each enabled MCP server at session start and registers its tools as Pi tools.
- Names each tool `<server>__<tool>`, for example `github__search_code`.
- Lets you browse a server catalog and add a server from a TUI overlay.
- Reads server configs from a global folder and a project folder. The project config wins.
- Limits each tool result to 64 KiB of text. It saves the full text of a larger result to a file.
- Supports 20 servers at most.

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/mcp
```

To add a server:

1. Open `/unipi:settings`.
2. Select the **MCP** group.
3. Select **Add server…**.
4. Search the catalog and select a server. You can also paste a custom config.
5. Edit the JSON config in the right pane. Save it.
6. Restart Pi.

## Commands

| Command | What it does |
|---|---|
| `/unipi:mcp-status` | Shows each server, its state, its tool count and the last error. |

The **MCP** group in `/unipi:settings` has four actions:

| Action | What it does |
|---|---|
| **Configure MCP servers…** | Opens a list of servers. Enable, disable or edit a server. |
| **Add server…** | Opens the catalog browser and the JSON config editor. |
| **Sync catalog…** | Downloads the server list from `punkpeye/awesome-mcp-servers` on GitHub. |
| **Reload servers…** | Tells you to restart Pi. |

## Agent tools

This package has no fixed tools. Each running server adds its own tools.

```text
github__search_code({ query: "authentication middleware" })
filesystem__read_file({ path: "/home/user/config.json" })
```

## Configuration

| Path | What it holds |
|---|---|
| `~/.unipi/config/mcp/` | Global server configs. |
| `<project>/.unipi/config/mcp/` | Project server configs. |

Each folder can hold two files:

- `mcp-config.json` holds the server definitions. UniPi writes it with mode `0600`.
- `config.json` holds the enabled state of each server.

`mcp-config.json` uses the common MCP format that Claude Desktop and Cursor also use:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
```

Merge rules:

1. A server in one folder only loads as defined.
2. A server in both folders uses the project definition.
3. A server with `"enabled": false` in the project `config.json` does not start.

## How it works

At session start, all enabled servers connect at the same time. Each request to a server has a 10-second timeout. When all servers finish, the package registers the tools of the good servers in one sorted list. A server that fails does not add tools.

The package sorts the keys in each tool schema. Thus the tool list is the same from one run to the next, and the provider can reuse its prompt cache. Refer to [Prefix cache](../../docs/architecture/prefix-cache.md).

Pi cannot remove a tool during a session. Thus a change to a server takes effect at the next Pi start.

When a result is more than 64 KiB, the agent gets the start and the end of the text. If the full text is 16 MiB or less, the package writes it to `~/.unipi/tool-results/` with mode `0600`. The result gives the file path, so the agent can use `read` to see the rest.

The catalog file is `~/.unipi/config/mcp/servers.json`. If this file does not exist, the package uses a list of 49 servers that ships with it.

The Info Screen shows an **MCP Servers** group with total, active and failed servers and the tool count.

## Troubleshooting

- **A server does not start.** Run `/unipi:mcp-status` to see the error. Make sure that the server command is on your `PATH`.
- **New tools do not show.** Restart Pi.
- **The sync fails.** Examine your network. The 49-server list stays available.

## See also

- [Prefix cache](../../docs/architecture/prefix-cache.md)
- [Commands reference](../../docs/reference/commands.md)
- [Info Screen](../info-screen/README.md)

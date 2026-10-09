# Memory

Memory keeps facts, decisions and preferences across sessions, so the agent
does not lose them when a session ends.

`@pi-unipi/memory` · part of [UniPi](../../README.md)

## What it does

- Stores each memory as a Markdown file in `~/.unipi/memory/<project>/<type>/<id>.md`.
  The type is `preference`, `decision`, `pattern` or `summary`.
- Adds each file to a [MemPalace](https://github.com/mempalace/mempalace) palace
  for semantic search. Other tools that use MemPalace can read the same palace.
- Shows a memory reminder on the first turn of a session.
- After a task, a background side session can store what it learned. This side
  session adds nothing to your conversation.
- If MemPalace is not available, memory uses only the Markdown files. If `uv` is
  available, the package tries `uv tool install mempalace`.

The project name is the sanitized base name of the working folder.

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/memory`.
2. Type `/unipi:memory status` to see the backend, the daemon and the memory counts.
3. Tell the agent to remember a fact. The agent calls `memory_store`.

## Commands

| Command | What it does |
|---|---|
| `/unipi:memory status` | Shows the backend, daemon, reader, counts, switches, pending writes and migration state. |
| `/unipi:memory recall on\|off` | Turns the start reminder on or off for this session only. |
| `/unipi:memory write on\|off` | Turns the write tools on or off for this session only. |
| `/unipi:memory migrate` | Converts v2 memories to the v3 layout. It makes backups first. |
| `/unipi:memory-search <term>` | Searches the memories of this project. |
| `/unipi:global-memory-search <term>` | Searches the memories of all projects. |
| `/unipi:global-memory-list` | Lists the memories of all projects. |
| `/unipi:memory-forget <title>` | Deletes a memory by title. |
| `/unipi:memory-process <text>` | Tells the agent to find memories in the text and store them. |
| `/unipi:memory-consolidate` | Tells the agent to store memories from this session. |

## Agent tools

| Tool | What it does |
|---|---|
| `memory_store` | Writes a memory file and adds it to the palace. |
| `memory_search` | Searches all projects by default. Use `scope: "project"` for this project only. |
| `memory_list` | Lists the memories of this project. |
| `memory_delete` | Deletes a memory by title or ID. |

`global_memory_search` and `global_memory_list` are aliases for the search and
list of all projects.

## Settings

Namespace `memory`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `recallAtStart` | `true` | Shows the memory reminder on the first turn. Search and list stay available. |
| `write` | `true` | Turns on `memory_store`, `memory_delete` and the save pass. |
| `wakeUp` | `true` | Adds `mempalace wake-up --wing <project>` output to the reminder. |
| `saveMode` | `side` | `side` uses a background session. `reminder` asks the agent to save. `off` stops the save pass. |
| `autoStartDaemon` | `false` | Starts a MemPalace daemon for Pi. While it runs, MemPalace servers in other tools cannot write. |
| `mempalaceAutoUpdate` | `true` | Checks PyPI each day and upgrades MemPalace with `uv`. |

Set `enabled` to `false` in `~/.config/mempalace/agent-hooks.json` to stop the
reminders. Set `UNIPI_DEBUG_MEMORY=1` to write a log to `~/.unipi/logs/memory.log`.

## How it works

Writes go to the MemPalace daemon job queue when a daemon runs. Otherwise, the
package runs `mempalace mine` directly. If both fail, the write waits in a
pending file. The next session replays it. Reads go through one read-only
`mempalace-mcp` process for each session.

The read process starts on the first search, not at session start. It stops
after 10 minutes without a search, and the next search starts it again (about
1.5 s). One loaded read process uses about 300 MB of RAM.

Every MemPalace process that pi starts gets `MALLOC_ARENA_MAX=2`. Without it,
the daemon grows with each write job and does not give memory back. In a test,
it went from 80 MB to 1.3 GB after 160 jobs. With it, the daemon stays at about
380 MB. If you set `MALLOC_ARENA_MAX` yourself, pi keeps your value. A daemon
that runs already keeps its old settings until it restarts.

## Upgrade from v2

The migration does not start by itself. When the package finds v2 data, the
session card shows a hint.

1. Type `/unipi:memory migrate`.
2. Read the plan. Accept it.
3. Wait for the footer progress to finish. If Pi stops, the next session continues.

The migration copies the palace to `~/.mempalace/palace.bak-unipi-<ts>`. It
copies the memory folder to `~/.unipi/memory-v2-backup-<ts>`. To go back to v2,
put these copies back and install `@pi-unipi/unipi@2`.

## See also

- [Compaction](../../docs/architecture/compaction.md)
- [Settings reference](../../docs/reference/settings.md)
- [Tools reference](../../docs/reference/tools.md)

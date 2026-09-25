# @pi-unipi/memory

Persistent memory that survives across sessions, built on a shared
[MemPalace](https://github.com/mempalace/mempalace) palace — the same palace
Devin and zcode write into, so memories cross tools.

**Architecture**

- **Durable tier**: markdown files at `~/.unipi/memory/<project>/<type>/<id>.md`
  with YAML frontmatter (`id, title, tags, project, created, updated, type`;
  type ∈ `preference | decision | pattern | summary`) plus a per-project
  `mempalace.yaml` (`wing` + the 4 type rooms).
- **Searchable tier**: the MemPalace palace — MemPalace embeds every mined
  file itself; there is no embedding config here.
- **Writes** go through the MemPalace daemon's job queue (`mine` jobs for
  store, `mempalace_delete_by_source` for delete) — the daemon holds the
  palace writer lease, so it's the only path that can't collide with it.
  When no daemon is reachable and `autoStartDaemon` can't bring one up,
  writes fall back to direct `mempalace mine` or land in `.pending.json`
  and replay later.
- **Reads** go through one long-lived `mempalace-mcp --read-only` stdio
  process per session (~30ms per call, sees every drawer in the palace —
  pi, Devin, zcode, diaries).
- **Project = wing** = sanitized basename of cwd (the `agent_gate.py` rule).

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:memory status` | backend, daemon, reader, counts, switches, pending ops, conversion progress |
| `/unipi:memory recall on\|off` | session-only recall override |
| `/unipi:memory write on\|off` | session-only write override (toggles the tools) |

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Write the md file and file it into the palace (filed ✓ / queued ⧗ / markdown only ⚠) |
| `memory_search` | Semantic search across ALL projects + foreign drawers, chunks grouped by file |
| `memory_list` | List the current project's memories |
| `memory_delete` | Remove the md and its palace drawer(s) |

`global_memory_search`/`global_memory_list` remain registered as thin aliases
but are not advertised.

## Switches (`/unipi:settings` → Memory)

- **Recall memory at start** — off = no first-turn reminder/titles/wake-up;
  search and list stay callable with neutral wording.
- **Write memory** — off = `memory_store`/`memory_delete` inactive and no
  end-of-task save nudge.
- **Wake-up summary at start** — fold `mempalace wake-up --wing <project>`
  output into the reminder.
- **Start a MemPalace daemon for pi** (default off) — off: use a daemon when
  one is running, otherwise write directly (`mempalace mine`, honoring the
  user's `write_routing`) — safe next to MemPalace in other tools. On: pi
  starts a daemon so parallel pi sessions never collide, but MemPalace MCP
  servers in other tools become read-only while it runs.
- **MemPalace auto-update** — daily PyPI check + `uv tool upgrade`.

`~/.config/mempalace/agent-hooks.json {enabled:false}` mutes the reminders.

## Upgrading from v2

Migration is explicit, never automatic. When v2 data is detected (legacy
marker files, flat `*.md` in project dirs, or non-lowercase project dirs)
the session card and footer show a hint. Run:

```
/unipi:memory migrate
```

Pi prints the plan (file count, dir renames, rough duration, backup
locations), asks for confirmation, then runs the conversion in the
background — footer progress and a final notification. The conversion:

1. Backs the palace up to `~/.mempalace/palace.bak-unipi-<ts>` AND the
   memory tree to `~/.unipi/memory-v2-backup-<ts>`.
2. Starts a temporary MemPalace daemon when none is running (stopped again
   at the end unless "Start a MemPalace daemon for pi" is on).
3. Collects flat `<project>/*.md` files and old bridge drawers
   (`unipi_preference|decision|pattern|summary` rooms, full content hydrated
   via `get_drawer` — never a preview).
4. Normalizes project dirs to the sanitized name (collisions merge;
   same-id duplicates keep the newer `updated`, losers go to `.conflicts/`).
5. Moves files into `<type>/`, writes `mempalace.yaml`, mines each project.
6. Verifies every record is findable, then deletes its old drawer by id —
   an old drawer is never deleted before its native copy verifies.

Expected duration: roughly a few minutes per ~1000 files (see the estimate
in the plan). Progress shows in the footer and `/unipi:memory status`.
State is resumable (`~/.unipi/memory/.conversion.json`) — if a run is
interrupted it continues on the next session.

v2 data stays usable before migrating: searches still find the old
`unipi://` drawers labelled "pi", and flat files still count in lists.

## Going back to v2

1. Quit pi and stop any daemon (`mempalace daemon stop`).
2. Restore the backups taken by the migration:

   ```
   rm -rf ~/.mempalace/palace
   cp -a ~/.mempalace/palace.bak-unipi-<ts> ~/.mempalace/palace
   rm -rf ~/.unipi/memory
   cp -a ~/.unipi/memory-v2-backup-<ts> ~/.unipi/memory
   ```

3. Reinstall v2: `npm i @pi-unipi/unipi@2`.

## Session lifecycle

- Start: warm reader spawned, pending journal replayed, conversion resumed
  in the background, session card rendered once counts land.
- First turn: recall reminder (memories + optional wake-up text).
- Task end: save nudge if nothing was stored.
- Shutdown: reader killed.

Events emitted for the footer: `MEMORY_STORED`, `MEMORY_DELETED`,
`UPDATE_APPLIED` (when the MemPalace install upgrades).

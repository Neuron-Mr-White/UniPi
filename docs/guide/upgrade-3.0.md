# Upgrade from UniPi 2.20 to 3.0

This page is for users of UniPi 2.20.x. It tells you what changes in 3.0,
what to do before and after the upgrade, and how to go back.

UniPi 3.0 is a large release. The main changes:

- **Long work modes.** `goal`, `ralph`, `swarm` and `graph` keep the agent on
  one task over many turns. Ralph is now one of these modes.
- **New memory.** Memory is rebuilt on MemPalace 3.10. Your 2.x memories stay
  on disk, but you must convert them once with `/unipi:memory migrate`.
- **New task board.** Kanboard is a local board server with a web board. The
  agent starts and finishes board tasks itself.
- **Plan mode and permission modes** replace the twenty workflow commands.
- **Rebuilt subagents, compactor and footer.** Some commands, tools and
  settings are gone. The table [Removed and renamed](#removed-and-renamed)
  lists each one.

## Before you upgrade

1. **Update Pi to 0.87.1 or later.** UniPi 3.0 needs Pi `^0.87.1`. Check your
   version with `pi --version`. With an older Pi, npm reports a peer
   dependency mismatch.
2. **Optional: install `uv`.** Memory uses
   [MemPalace](https://github.com/mempalace/mempalace) 3.10.0 or later for
   search. If MemPalace is not installed and `uv` is available, UniPi runs
   `uv tool install mempalace` for you. Without MemPalace, memory still works
   with the Markdown files only, and search is simpler.
3. **Windows only:** web reads need the Microsoft Visual C++ 2015-2022 runtime.
   Without it UniPi still loads and web reads use plain fetch. To install it,
   run `winget install Microsoft.VCRedist.2015+.x64`.

## Upgrade

Run:

```bash
pi install npm:@pi-unipi/unipi
```

Then restart Pi.

If you run a 3.0 alpha, you do not need to do anything. The updater sees that
3.0.0 is newer than your alpha and offers it at session start. Press `Y` to
install it. You can read the changes first with `/unipi:changelog`.

## After you upgrade — what to do

1. **Convert your memories (required if you used memory in 2.x).** Your 2.x
   memories are not converted by themselves. The first session after the
   upgrade asks once whether to convert them now. If you choose not to, the
   session card and the footer keep showing a hint.
   1. Type `/unipi:memory migrate`.
   2. Read the plan and accept it.
   3. Wait until the footer progress ends. If Pi stops, the next session
      continues the conversion.

   Before it converts anything, the migration copies the palace to
   `~/.mempalace/palace.bak-unipi-<ts>` and the memory folder to
   `~/.unipi/memory-v2-backup-<ts>`. To undo it, read "Upgrade from v2" in
   [packages/memory/README.md](../../packages/memory/README.md).
2. **Check memory with `/unipi:memory status`.** It shows the backend, the
   daemon, the counts and the migration state.
3. **Optional: turn on the MemPalace daemon.** `memory.autoStartDaemon` is now
   off by default. Turn it on in `/unipi:settings` → Memory if you run several
   Pi sessions at the same time and want them never to collide.
4. **Optional: turn on `ask_user`.** The `ask_user` tool is now off by default.
   When it is off, the agent asks its questions in its reply. Turn it on in
   `/unipi:settings` → Ask User.
5. **Use `/unipi:settings` for all settings.** The per-module settings
   commands (`/unipi:footer-settings`, `/unipi:notify-settings`,
   `/unipi:compact-settings` and others) are gone. `/unipi:settings <search>`
   opens the hub with a filter.
6. **Learn the new names of commands you used.** The most common ones:
   - `/unipi:lossless-compact` and `/unipi:compact` → `/unipi:compact-vcc`
   - `/unipi:compact-recall` → `/unipi:session-recall`
   - `/unipi:reload` → Pi's `/reload`
   - `/unipi:status`, `/unipi:env` → `/unipi:doctor`
   - `/unipi:brainstorm`, `/unipi:work` and the other workflow commands →
     plan mode (`/unipi:plan` or `Alt+P`) and the long work modes
     (`/unipi:goal`, `/unipi:ralph`, `/unipi:swarm`, `/unipi:graph`)
   - `spawn_helper`, `bg_delegate` → `run_subagent`

   The full list is in the table below.
7. **Optional: move project docs.** UniPi now writes specs, plans and notes to
   `docs/` in the project, not to `.unipi/docs/`. Old `.unipi/docs/` folders are
   not moved. Move them by hand if you want them in the new place.
8. **Optional: delete old data.** `~/.unipi/db/compactor` is no longer used.
   On first start, `~/.unipi/state/fusion` and `~/.unipi/trajectory` move to
   `~/.unipi/v2-archive/<name>-<ts>/`. Delete these when you are sure you do
   not go back to 2.x.
9. **Optional: if you installed single packages.** If you installed
   `@pi-unipi/image`, `@pi-unipi/ralph`, `@pi-unipi/milestone` or
   `@pi-unipi/trajectory` on their own, remove them with `pi remove`. Image
   tools are in `@pi-unipi/utility`. Ralph is in `@pi-unipi/long-horizon`.

## Removed and renamed

| What was removed or changed | What to use instead | Action needed? |
|---|---|---|
| Pi versions below 0.87.1 | Pi 0.87.1 or later | Yes |
| 2.x memory storage (Python bridge, SQLite and embedding backends) | Memory on MemPalace 3.10. Convert once with `/unipi:memory migrate` | Yes |
| Memory embedding settings (`provider`, `model`, `baseUrl`, `dimensions`, `apiKey`, `suppressMigrationWarning`) and `/unipi:memory-reembed` | Nothing. MemPalace embeds by itself. Old settings are ignored | No |
| Pi starts a MemPalace daemon | `memory.autoStartDaemon` is off by default. Pi writes directly unless a daemon already runs | No |
| `@pi-unipi/image` package | `@pi-unipi/utility`. The `image` settings stay the same | Yes, only if you installed it alone |
| `@pi-unipi/ralph` package | The `ralph` mode in `@pi-unipi/long-horizon`: `/unipi:ralph start`, `status`, `stop`, `resume`, `clear` | Yes, only if you installed it alone |
| `@pi-unipi/milestone` package and `/unipi:milestone-onboard`, `/unipi:milestone-update` | No replacement | Yes, only if you installed it alone |
| `@pi-unipi/trajectory` package and `/unipi:trajectory` | No replacement. Old data moves to `~/.unipi/v2-archive/` | Yes, only if you installed it alone |
| The twenty workflow commands: `/unipi:brainstorm`, `work`, `review-work`, `consolidate`, `worktree-create`, `worktree-list`, `worktree-merge`, `consultant`, `quick-work`, `gather-context`, `document`, `scan-issues`, `auto`, `debug`, `fix`, `quick-fix`, `research`, `chore-create`, `chore-execute`, and the old `/unipi:plan` pipeline | Plan mode (`/unipi:plan`, `Alt+P`), permission modes (`/unipi:permission`, `Alt+M`) and the long work modes (`/unipi:goal`, `ralph`, `swarm`, `graph`) | Yes |
| The bundled workflow skills (`brainstorm`, `plan`, `work`, `debug`, `quick-fix`, `worktree-*` and others) | No replacement. `@pi-unipi/skill-registry` now only controls which skills the agent sees | No |
| Project docs in `.unipi/docs/` | `docs/` in the project. Old folders are not moved | No |
| The old Kanboard (htmx board that read `.unipi/docs/`, the TUI overlay, `/unipi:kanboard` as an on/off switch, `/unipi:kanboard-doctor`) | The new board: `/unipi:kanboard open`, `close`, `onboard`, `status`, `show`, `doctor`, plus `/unipi:kanboard-add`, `/unipi:kanboard-do`, `/unipi:kanboard-autowork` | Yes, run `/unipi:kanboard onboard` per project |
| Per-module settings commands: `/unipi:ask-user-settings`, `bg-settings`, `footer-settings`, `image-settings`, `info-settings`, `memory-settings`, `notify-settings`, `skills-settings`, `stash-settings`, `updater-settings`, `util-settings`, `web-settings`, `compact-settings`, `compact-preset`, `badge-settings`, `fusion-preset`, `web-cache-clear`, `mcp-add`, `mcp-settings`, `mcp-sync`, `mcp-reload`, `notify-set-gotify`, `notify-set-tg`, `notify-set-ntfy`, `notify-test`, `notify-recap-model` | `/unipi:settings`. Each module has a group there, with the setup and test actions | No |
| `/unipi:reload`, `/unipi:status`, `/unipi:env`, `/unipi:prefix-cache` | Pi's `/reload`. `/unipi:doctor` for health checks | No |
| Agent tools `ctx_env` and `set_session_name`, the name badge bar and `/unipi:badge-name`, `/unipi:badge-gen`, `/unipi:badge-toggle` | Sessions are named automatically. Use Pi's `/name` to set a name. Old `badge.*` settings carry over to `rename.*` | No |
| Subagent tools `spawn_helper`, `get_helper_result`, `bg_delegate`, `bg_result`, and workflow scripts, missions, schedules, budgets, acceptance gates, agent memory, worktrees, prompt templates and bundled agents | `run_subagent` (foreground, background, resume) with `subagent_explore`, `subagent_general` or a custom agent; `read_subagent` for results; `/unipi:agents` to manage agents. `backgroundTasks.delegate.*` settings are ignored | Yes |
| `/unipi:btw-new`, `/unipi:btw-tangent`, `/unipi:btw-clear`, `/unipi:btw-inject`, `/unipi:btw-summarize` and `--save` | `/unipi:btw [question]` opens a panel. Each question runs in a fresh read-only session | No |
| `/unipi:model`: `Ctrl+S` saves the default | `Alt+Enter`. The startup model is also in `/unipi:settings` → Fusion → Startup | No |
| Compactor session continuity (SQLite event log and restored snapshot), sandbox tools (`sandbox`, `sandbox_file`, `sandbox_batch`), the `compact`, `compactor_stats` and `compactor_doctor` tools, presets and strategy modes | Lossless summary rebuilt from the full session on each compaction. `~/.unipi/db/compactor` can be deleted. Old configs are translated | No |
| `/unipi:lossless-compact`, `/unipi:compact`, `/unipi:compact-recall` | `/unipi:compact-vcc`, `/unipi:compact-by-llm`, `/unipi:session-recall` | No |
| Compactor settings `sections.*`, `cooldownMs`, `repeatMinGrowthTokens`, `debug` | One **Summary sections** setting (old values still work). The two timing values are fixed. Debug output: `UNIPI_COMPACTOR_DEBUG=1` | No |
| Classic footer: presets, separators, segments, `/unipi:footer-help`, settings `preset`, `separator`, `zoneSeparator`, `showFullLabels`, `groups`, `glanceMode` | The glance frame is the only footer. Configure it in `/unipi:settings` → Footer. Old keys are ignored. `footer.enabled: false` gives the plain Pi editor | No |
| Footer `colorMode` value `mono` | `none` (stored `mono` loads as `none`) | No |
| `ask_user` on by default; its `timeout` parameter and the "allowed formats" switches | `ask_user` is off by default and asks 1–4 questions per call. Turn it on in `/unipi:settings` → Ask User | Yes, if you want it |
| Tool calls shown in Pi's own view | The default render style is `simple` (one line per tool call). Set `utility.render.style` to `regular` for Pi's view | No |
| Skill exposure settings under `utility.skills` (`skills.discovery`) | The `skills` namespace (`/unipi:skills`). Migrated automatically | No |
| `Alt+S` chord keys: registers 0–9, cut (`D`) and toggle thinking (`T`) | `A` appends the stash, `Y` copies the last reply, `K` adds the input to the Kanboard backlog | No |
| Background tasks setting `defaultTimeoutSeconds` | Nothing. No code read it | No |
| Web API settings `os` and `batchConcurrency`, the `llm-summarize` provider, the `source` parameter of `web_llm_summarize` | Engine defaults. Web tools that cannot work are hidden from the agent | No |
| `~/.unipi/state/fusion` and `~/.unipi/trajectory` | Moved to `~/.unipi/v2-archive/<name>-<ts>/` on first start. Delete by hand when you are sure | No |

## New in 3.0

**Long work modes**
- `/unipi:goal`, `/unipi:ralph`, `/unipi:swarm`, `/unipi:graph`: the agent continues until the task is done, blocked or over budget.
- In goal mode an independent verifier checks the goal before it ends.
- `/unipi:<mode> stop`, `resume`, `clear`, and `/unipi:regular` to go back to a normal session.
- `/unipi:visualize-progress` shows a live view of a run. Terminals with Kitty graphics show a chart.

**Plan and permission modes**
- Plan mode (`/unipi:plan`, `Alt+P`): the agent researches and writes only its plan, then you approve it.
- Permission modes `ask`, `auto` (default) and `full` (`/unipi:permission`, `Alt+M`). Dangerous commands always ask.

**Fusion and models**
- A lead model and a sidekick model in one session. The sidekick's steps show in the chat.
- Set the sidekick's thinking level in the `/unipi:model` Fusion row.

**Subagents and background work**
- `run_subagent` runs agents in the foreground or background. `Ctrl+B` sends a running one to the background.
- One work tray for background tasks, subagents and Dream: press `↓` on an empty input.
- The watchdog is on for bash calls. A bash call that looks stuck moves to a background task instead of being killed.
- `/unipi:bg-detach` moves the running bash call to the background by hand.

**Kanboard**
- A local board server with a web board, a dashboard and a "Needs you" inbox.
- The agent uses `start` and `finish` to move tasks, with status reports and attachments.
- `/unipi:kanboard-do` gives the agent a task budget. `/unipi:kanboard-autowork` lets it work all ready tasks.
- Remote access with a token: `/unipi:kanboard open --host`.

**Memory and Dream**
- Memories are Markdown files plus a MemPalace index that other tools can also read.
- A background side session saves what the agent learned, without adding to your chat.
- Dream (off by default) reviews past sessions and proposes memory lessons and skills for you to approve.

**Compactor**
- Lossless compaction that puts the current state first and cannot grow from one compaction to the next.
- A compaction card in the transcript shows tokens before and after.
- `/unipi:compact-then <prompt>` compacts, then continues with your prompt.

**Screens and footer**
- The glance footer frames the input and shows tokens, cost, speed and cache hits. It fits narrow terminals.
- The Unicrab start splash and a new `/unipi:info` dashboard with session, usage, tools and context pages.
- Unicrab hints: `Alt+H` for the next hint, `/unipi:hint` to browse them.
- Simple render style: one line per tool call. `Ctrl+O` shows details.

**UniPi phone app**
- Chat with a Pi session from the UniPi app, live in both directions.
- Answer dialogs and `ask_user` from the phone. Switch sessions, models and modes from the phone.
- Phone push notifications can be end-to-end encrypted.

**Other**
- `/unipi:summarize` re-summarizes the last reply. `/unipi:answer` answers the last reply in its own screen.
- Pasted images and files become attachments. New `image_edit` tool.
- Sessions are named automatically.
- `/unipi:move` re-links sessions, boards and memories after you move or rename a project folder.
- `/unipi:settings` explains each setting in an info panel.

## Going back to 2.20

Run:

```bash
pi install npm:@pi-unipi/unipi@2.20.5
```

Then restart Pi.

If you converted your memories, also put back the backups. The steps are in
"Upgrade from v2" in [packages/memory/README.md](../../packages/memory/README.md).
If you did not convert them, your 2.x memories are unchanged.

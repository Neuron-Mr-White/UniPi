## [3.0.0] — YYYY-MM-DD

UniPi 3.0 is the first stable release of the 3.x line. It replaces 2.20.5 as npm `latest`. Upgrade guide: [docs/guide/upgrade-3.0.md](docs/guide/upgrade-3.0.md).

### Highlights

- **Long work modes.** `goal`, `ralph`, `swarm` and `graph` (`@pi-unipi/long-horizon`) keep the agent on one task over many turns. Goal mode ends only when an independent verifier accepts the goal, or when the goal is blocked, stalled or over budget.
- **Memory on MemPalace 3.10.** Memories are Markdown files under `~/.unipi/memory/<project>/<type>/` plus a MemPalace index that other tools can read. 2.x memories are converted once with `/unipi:memory migrate`, with backups.
- **New Kanboard.** A Rust board server with a web board, a dashboard and a "Needs you" inbox. The agent moves its own tasks with `start` and `finish`; `/unipi:kanboard-do` and `/unipi:kanboard-autowork` control how much it may do.
- **Plan mode and permission modes** (`@pi-unipi/workflow`) replace the twenty workflow commands. Permission modes are `ask`, `auto` (default) and `full`.
- **Rebuilt subagents and Fusion.** `run_subagent` runs agents in the foreground or background; one work tray shows background tasks, subagents and Dream. The Fusion sidekick's steps stream into the chat.
- **Rebuilt compactor.** The lossless summary is rebuilt from the full session on each compaction and can no longer grow from one compaction to the next.
- **New screens.** The glance footer, the Unicrab start splash, the `/unipi:info` dashboard, Unicrab hints and a `simple` render style (one line per tool call, now the default).
- **UniPi phone app.** `@pi-unipi/app-bridge` lets the UniPi app chat with a Pi session live, answer dialogs and `ask_user`, and switch sessions, models and modes.

### Breaking changes

- **Pi `^0.87.1` is required.** All `@earendil-works/pi-*` peer dependencies moved from `^0.84.0` to `^0.87.1`.
  Do this: update Pi to 0.87.1 or later before you upgrade.
- **Memory rebuilt on MemPalace 3.10.** The Python bridge, the SQLite and embedding backends and the direct `upsert` write path are gone. 2.x data is never converted automatically.
  Do this: run `/unipi:memory migrate` once. Backups go to `~/.mempalace/palace.bak-unipi-<ts>` and `~/.unipi/memory-v2-backup-<ts>`.
- **Memory embedding settings removed.** `provider`, `model`, `baseUrl`, `dimensions`, `apiKey`, `suppressMigrationWarning`, the re-embed action and `/unipi:memory-reembed` are gone; MemPalace embeds by itself.
  Do this: nothing. Stale settings are ignored.
- **`memory.autoStartDaemon` defaults to off.** Pi writes directly (`mempalace mine`) unless a daemon already runs.
  Do this: turn it on in `/unipi:settings` → Memory if parallel Pi sessions must never collide.
- **`@pi-unipi/image` removed.** Image generation, editing and recognition are in `@pi-unipi/utility`, with the same `image` settings.
  Do this: nothing with the umbrella package; if you installed `@pi-unipi/image` alone, remove it and install `@pi-unipi/utility`.
- **`@pi-unipi/ralph` removed.** Ralph is a mode of `@pi-unipi/long-horizon` (`/unipi:ralph start|status|stop|resume|clear`).
  Do this: if you installed `@pi-unipi/ralph` alone, remove it and install `@pi-unipi/long-horizon`.
- **`@pi-unipi/milestone` and `@pi-unipi/trajectory` removed**, with `/unipi:milestone-onboard`, `/unipi:milestone-update` and `/unipi:trajectory`. There is no replacement.
  Do this: if you installed either alone, remove it with `pi remove`.
- **Workflow commands removed.** `/unipi:brainstorm`, `work`, `review-work`, `consolidate`, `worktree-create`/`-list`/`-merge`, `consultant`, `quick-work`, `gather-context`, `document`, `scan-issues`, `auto`, `debug`, `fix`, `quick-fix`, `research`, `chore-create`/`-execute` and the old `/unipi:plan` pipeline are gone. The bundled workflow skills are deleted too.
  Do this: use plan mode (`/unipi:plan`, `Alt+P`), permission modes (`/unipi:permission`, `Alt+M`) and the long work modes.
- **Project docs live in `docs/`.** Skills and plan mode write to `docs/` in the project; the `.unipi/docs/` convention is gone. Existing `.unipi/docs/` folders are not moved.
  Do this: move old `.unipi/docs/` content by hand if you want it in `docs/`.
- **Kanboard replaced.** The htmx/Alpine board, the TUI overlay and `/unipi:kanboard-doctor` are gone. The new board is the `unipi-kanboard` binary with a web board.
  Do this: run `/unipi:kanboard onboard` in each project, then `/unipi:kanboard open`.
- **Per-module settings commands removed.** `/unipi:*-settings`, `/unipi:compact-preset`, `/unipi:fusion-preset`, `/unipi:web-cache-clear`, the `mcp-*` setup commands, the `notify-set-*`/`notify-test`/`notify-recap-model` commands and the `badge-*` commands are absorbed into the settings hub.
  Do this: use `/unipi:settings` (or `/unipi:settings <search>`).
- **Utility slimmed.** `/unipi:reload`, `/unipi:status`, `/unipi:env`, `/unipi:prefix-cache`, the `ctx_env` and `set_session_name` tools and the name badge bar are gone. Sessions are named automatically; old `badge.*` settings carry over to `rename.*`.
  Do this: use Pi's `/reload`, `/unipi:doctor` and Pi's `/name`.
- **Subagents rebuilt.** `spawn_helper`/`get_helper_result`, `bg_delegate`/`bg_result`, workflow scripts, missions, schedules, budgets, acceptance gates, agent memory, worktrees, prompt templates and the bundled agents are gone. Saved `backgroundTasks.delegate.*` settings are ignored.
  Do this: use `run_subagent` with `subagent_explore`, `subagent_general` or a custom agent (`/unipi:agents`), and `read_subagent` for results.
- **BTW is an inline panel.** `/unipi:btw-new`, `-tangent`, `-clear`, `-inject`, `-summarize` and `--save` are gone.
  Do this: use `/unipi:btw [question]`; each question runs in a fresh read-only session.
- **`/unipi:model` saves the default with `Alt+Enter`**, not `Ctrl+S`.
  Do this: press `Alt+Enter`, or set the startup model in `/unipi:settings` → Fusion → Startup.
- **Compactor reworked.** Session continuity (the SQLite event log and restored snapshot), the sandbox tools, the `compact`, `compactor_stats` and `compactor_doctor` tools, presets and the strategy modes are gone. `/unipi:lossless-compact`, `/unipi:compact` and `/unipi:compact-recall` are removed. Old configs are translated.
  Do this: use `/unipi:compact-vcc`, `/unipi:compact-by-llm` and `/unipi:session-recall`; delete `~/.unipi/db/compactor` if you like.
- **Compactor settings pruned.** The `sections.*` booleans became one **Summary sections** setting (stored values still work); `cooldownMs` and `repeatMinGrowthTokens` are fixed; `debug` moved to `UNIPI_COMPACTOR_DEBUG=1`.
  Do this: nothing.
- **Classic footer removed.** Presets, separators, segments, `/unipi:footer-help` and the `preset`, `separator`, `zoneSeparator`, `showFullLabels`, `groups` and `glanceMode` settings are gone; the glance frame is the only footer. `colorMode: mono` loads as `none`.
  Do this: configure the footer in `/unipi:settings` → Footer; set `enabled: false` for the plain Pi editor.
- **`ask_user` is off by default and rebuilt.** One call carries 1–4 questions; the single-question form is still accepted (`timeout` is ignored); the "allowed formats" switches are gone.
  Do this: turn it on in `/unipi:settings` → Ask User if you want it.
- **`simple` is the default render style.**
  Do this: set `utility.render.style` to `regular` for Pi's own view.
- **Skill exposure settings moved** from `utility.skills` to the `skills` namespace (`@pi-unipi/skill-registry`), migrated on first read.
  Do this: nothing; use `/unipi:skills`.
- **`Alt+S` chords reworked.** The registers (0–9), cut and toggle-thinking keys are gone; `A` appends the stash, `Y` copies the last reply, `K` adds the input to the Kanboard backlog.
  Do this: nothing.
- **Settings removed:** `background-tasks.defaultTimeoutSeconds` (nothing read it); web-api `os` and `batchConcurrency`; the `llm-summarize` provider and the `source` parameter of `web_llm_summarize`.
  Do this: nothing.
- **2.x state archived.** `~/.unipi/state/fusion` and `~/.unipi/trajectory` move to `~/.unipi/v2-archive/<name>-<ts>/` on first start; they are never purged.
  Do this: delete the archive by hand when you no longer need 2.x.

### Added

- `long-horizon` (new package): `goal`, `ralph`, `swarm` and `graph` modes with one active owner and one park slot; `/unipi:<mode> status|stop|resume|clear`; `/unipi:regular`; a goal verifier; a goal progress estimate shown only to you; an optional judge that picks a mode per prompt (off by default).
- `long-horizon`: `/unipi:visualize-progress` — a live view of a run (steps, progress bars, log), drawn as a chart in terminals with Kitty graphics.
- `workflow`: plan mode (`/unipi:plan`, `Alt+P`) with a two-part plan (Summary and Implementation) and an approval overlay; permission modes `ask`, `auto`, `full` (`/unipi:permission`, `Alt+M`) with saved allow/deny rules and jev checks for unknown `bash` commands.
- `memory`: Markdown files plus MemPalace index; `/unipi:memory status|recall|write|migrate`; a background side session that saves what the agent learned (`saveMode`); markdown-only mode when MemPalace is missing; `uv tool install mempalace` when `uv` is available.
- `dream` (new package, off by default): reviews past sessions in the background, turns repeated false paths into memory lessons, and proposes skills and checks to approve or reject (`/unipi:dream`).
- `kanboard`: the `unipi-kanboard` binary for Linux, macOS and Windows; a local daemon with a web board, dashboard, labels, task owner, undo, archived projects, `@` task mentions, status reports and attachments; remote access with a token (`/unipi:kanboard open --host`); `/unipi:kanboard show` in the chat; `/unipi:kanboard-add`, `/unipi:kanboard-do` (task budget) and `/unipi:kanboard-autowork`.
- `subagents`: `run_subagent` (foreground, background, resume) with live cards, `Ctrl+B` to background, `Esc` to cancel, custom Markdown agents and `/unipi:agents`.
- One work tray for background tasks, subagents and Dream (`↓` on an empty input, `/unipi:bg-tasks`, `/unipi:subagents`).
- `watchdog` (new package): on by default for bash calls; a bash call that looks stuck returns to the agent and keeps running as a background task. `/unipi:bg-detach` does this by hand.
- `compactor`: lossless summary with current state first (Active Work, Your Requests, Latest State, Decisions & Constraints, Lessons, Project Knowledge, Files, Commits, Open Errors, Recent Transcript); credential redaction; a compaction card in the transcript; `/unipi:compact-then <prompt>`; compaction savings on the info screen.
- `skill-registry` (new package): per-skill **Enabled** and **Must show** per scope (`/unipi:skills`), a skill vault and judged skill exposure.
- Decision Model settings: one shared `decision-model` group for jev, used by long-horizon, permissions, skills, watchdog and the compactor.
- `footer`: the glance frame with session tokens and cost, configurable strip and badges, rainbow modes, and a responsive layout for narrow terminals.
- `info-screen`: the Unicrab start splash and a redesigned `/unipi:info` dashboard (This session, Usage, Tools, Skills, Modules, MCP, Compactor, Updates, Web, Memory, Keys) with session/project/global scope tags and a context breakdown.
- `core`: Unicrab hints (`Alt+H`, `Alt+Shift+H`, `/unipi:hint`); the settings hub explains each setting in an info panel; `/unipi:settings <search>`.
- `utility`: `simple`, `regular` and `advanced` render styles; automatic session naming; `/unipi:answer`; `/unipi:summarize` and the bundled `summarize` skill; `/unipi:retry`; pasted images and files as attachments; `image_edit`; `/unipi:move` to re-link sessions, boards and memories after a project move.
- `ask-user`: 1–4 questions per call with an automatic "Other" choice and image/file paste.
- `input-shortcuts`: `Ctrl+C` keeps the cleared input in the transcript; `↑` restores it.
- `app-bridge` (new package): the UniPi phone app can chat with a Pi session live, page through history, navigate sessions, use send modes, share media, answer dialogs and `ask_user`, see running work, and switch the working mode.
- `notify`: an **Input Needed** event for prompts that send no event of their own; end-to-end encrypted phone push; app deep links.
- `/unipi:doctor` reports a missing Microsoft Visual C++ runtime on Windows.

### Changed

- `fusion`: the sidekick's steps stream into the chat; blocking handoffs forward approvals to you; sidekick thinking level is set in the `/unipi:model` Fusion row; `/unipi:model` lists your preset models and searches the whole catalogue as you type.
- `web-api`: web tools that cannot work are hidden from the agent; tool failures are reported as errors.
- `background-tasks`: launch and completion notices are one-line chips.
- `utility`: `/unipi:cleanup` previews and asks before it removes files; v2 memory backups are never removed. `/unipi:doctor` also checks the model cache, the Decision Model key and skill exposure.
- One "Working…" state while background tasks or subagents that can wake the agent still run; notify sends one "All done".
- The updater stays on the channel you installed from and never offers an older version.
- Autocomplete offers every registered `/unipi:*` command.
- The judge picks models from Pi's own model registry; provider-specific code is gone.

### Fixed

- `image` (now in `utility`): generation failed for most users, and failures were reported to the agent as successes.
- `compactor`: the percentage trigger no longer aborts the run; stats come from the session's own compaction entries instead of a fixed guess; the kept tail and summary are sized to the model's context window, so compaction no longer overflows small-context models; secrets are redacted before summary items are clipped.
- `ask-user`: several `ask_user` calls in one message no longer open at the same time and hang the turn.
- `fusion`: the Fusion row can always be applied (model cache refresh on a miss, stale saved keys dropped); the shell-delegation nudge fires at most once per handoff gap and ignores read-only commands.
- `notify`: one "finished" notification per run, not one per chat change; closing any prompt stops its reminders.
- `core`, `updater`: version comparison orders prerelease versions correctly.
- Windows: a missing Visual C++ runtime no longer stops UniPi from loading; web reads fall back to plain fetch.

Full history of the 3.0 alphas: see the 3.0.0-alpha.* entries below.

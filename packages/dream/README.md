# Dream

Dream keeps the agent from repeating past mistakes. It reviews past session
struggles in the background, turns repeated false paths into memory lessons,
and proposes skills crafted from errors.

`@pi-unipi/dream` · part of [UniPi](../../README.md)

Dream is **off by default**. Turn it on in `/unipi:settings` → **Dream** →
"Dream in the background". While it is off nothing runs when pi opens (no
session scan, no digest, no child process); `/unipi:dream run` still starts
one by hand.

## What it does

- When on, on every pi open, checks whether enough new "struggle" sessions have piled
  up since the last dream.
- When due, spawns a detached background `pi` run (the dream) over compact
  session digests: every failed tool call with its recovery, and user
  corrections. Secrets are scrubbed before the digests reach the model.
- The dream applies memory lessons itself (through the memory package's
  tools, so the search index stays in sync) and merges duplicate or stale
  memory notes.
- Skills and automated checks only get **proposed**. The next pi open shows a
  "Dream report ready" card; you approve or reject with `/unipi:dream`.
- Approved skills land in the project's `.agents/skills/` and must pass the
  bundled `craft-skill` check, which rejects hardcoded secrets: values go in
  `<skill>/.env` (gitignored), names in `.env.example`.

## Quick start

1. Dream ships in `@pi-unipi/unipi`. To install it alone:
   `pi install npm:@pi-unipi/dream`.
2. Turn it on: `/unipi:settings` → Dream → "Dream in the background".
   (Or try one now without turning it on: `/unipi:dream run`.)
3. Work as usual. After enough new sessions, a dream runs on its own the next
   time you open pi in that project.
4. Watch it in the work tray (↓ from an empty editor → **Dream** tab), or
   type `/unipi:dream` for status.

## Watching a dream

- **TUI**: the work tray's **Dream** tab (shown once there is a dream or
  dreaming is on). Rows are runs (running / finished / failed / stopped, start
  time, duration, sessions digested, proposals pending). `↵` opens one: the
  report summary, its proposals, and the dream child's live trajectory
  (its own session, tool by tool) plus the log tail. Keys: `o` full report,
  `s` stop, `r` run now, `1`–`9` pick a proposal, `a` / `x` approve / reject
  (press twice to confirm), `d` dismiss, `←`/`esc` back. A dream never wakes
  the agent, so it does not show the "Working…" line.
- **UniPi app**: the chat's ⋯ menu → **Dream** (desktop: the palette's
  "Show Dream"). Same runs, live progress, the report as markdown, Approve /
  Reject buttons, Run now.

## Commands

| Command | What it does |
|---|---|
| `/unipi:dream` | Status: on/off, due or why not, last run, pending proposals. |
| `/unipi:dream tray` | Opens the work tray on the Dream tab. |
| `/unipi:dream report` | Prints the latest `DREAM_REPORT.md`. |
| `/unipi:dream approve <n>` | Lands proposal n (skills must pass the craft-skill check). |
| `/unipi:dream reject <n>` | Records a rejection for proposal n. |
| `/unipi:dream run` | Starts a dream now, ignoring the schedule (works while off). |
| `/unipi:dream stop` | Stops the running dream. |

## Settings

Namespace `dream`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `enabled` | **off** | Dream in the background: check whether one is due on pi open. |
| `minSessions` | 5 | New sessions required since the last dream. |
| `minGapHours` | 12 | Minimum hours between dreams. |
| `model` | (session default) | Optional `provider/model` for the dream child. |
| `thinking` | medium | The dream child's thinking level. |
| `skillsTarget` | `.agents/skills` | Where approved crafted skills land. |
| `maxRuntimeMin` | 40 | Hard cap for one dream run. |

## The craft-skill skill

Every skill the dream writes goes through `craft-skill`, and so should every
skill you ask the agent to write. It keeps `SKILL.md` short, front-loads the
description (the skill router only reads the first 200 characters), and runs
two scripts: `scaffold` (creates `.env.example`, `.gitignore`, `.env`) and
`check` (fails on unignored `.env` files or secret-like values outside it).

## What a dream is allowed to do

- Memory edits: applied directly (lessons, merges, deletions).
- Skills and checks: proposed only, never applied without approval.
- Nothing else: the child runs without extensions or skills beyond
  craft-skill and memory, in its own session directory, capped by a timeout.

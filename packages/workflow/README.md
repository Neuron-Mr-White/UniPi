# @pi-unipi/workflow

Two always-on session mechanisms:

- **permission modes** — every tool call passes a gate before it runs: `ask`, `auto`
  (default), or `full`. In `auto`, a cheap **jev** (TypeSafe System One) call judges
  ambiguous bash instead of prompting you for everything.
- **plan mode** — a read-only session that can only write its own plan file, then
  hands you an approval prompt when the plan is ready.

The twenty slash commands this package used to register (`/unipi:brainstorm`,
`/unipi:work`, `/unipi:review-work`, `/unipi:auto`, …) are gone; their skills moved
to [@pi-unipi/skill-registry](../skill-registry/README.md) and stay loadable via
`/skill:<name>`. Plan mode and ordinary prompting replace the command pipeline.

## Commands & keys

| Command / key | Effect |
|---|---|
| `/unipi:plan [on\|off\|view\|approve]` | Toggle/enter plan mode, view the plan file, or run the approval prompt |
| `Alt+P` | Toggle plan mode |
| `/unipi:permission [ask\|auto\|full]` | Set or show the permission mode |
| `Alt+M` | Cycle `ask → auto → full` |

## Permission modes

| Mode | Behaviour |
|---|---|
| `ask` | Prompt before every write/edit, bash call, and other tool |
| `auto` (default) | Read-only tools always run; writes inside the workspace (or the temp dir) run; dangerous commands still prompt; anything else is judged by jev — `safe` with confidence ≥ `jevConfidence` runs, otherwise it prompts |
| `full` | Everything runs except commands matching a saved **deny** rule |

Classification order for a tool call:

1. **Saved rules** — glob rules (`allow`/`deny`) stored per project, checked first.
   Deny rules apply in every mode, including `full`.
2. **Read-only tools** — `read`, `grep`, `find`, `ls`, `ffgrep`, `fffind`,
   `memory_search`, `web_search`, `bg_status`, `ask_user`, … always allowed.
3. **`write` / `edit`** — allowed in `auto`/`full` when the resolved path is inside
   the workspace or the temp dir; outside it always prompts.
4. **`bash`** — split into simple commands (quote-aware) and classified:
   - **dangerous** patterns (`rm -rf`, `sudo`, `dd`, `mkfs`, `chmod -R`, `curl | sh`,
     `git push --force`, `git reset --hard`, `git clean -f`, `kill -9`/`pkill`,
     writes into `~/.ssh`, `~/.aws`, `/etc`, reading `.env`/`id_rsa`/`*.pem`) always
     prompt — even in `ask` mode;
   - **read-only allowlist** (`ls`, `cat`, `grep`, `find` without `-exec`, `git
     status/diff/log`, `jq`, `diff`, …) runs in `auto`;
   - anything else: one jev `risk` question (`safe` / `needs_approval` /
     `dangerous`) over `cwd` + the command. jev failure → prompt.
5. **Other tools** (MCP, subagents, background tasks) — allowed in `auto`/`full`;
   `ask` mode prompts.

### The approval prompt

```
Allow bash: rm -rf /tmp/wd-test?
jev: dangerous 0.94
  1. Allow once                     ← Enter
  2. Always allow `rm -rf *`
  3. Deny
  4. Deny with note…
```

The first option is selected, so `Enter` allows once. `Always allow …` writes a
project-scoped allow rule for the suggested pattern (bash: first word(s) + `*`,
write/edit: the containing directory glob). `Deny with note…` collects a note that
becomes part of the block reason the agent sees:
`Blocked by permission (user denied): <note>`. `Esc` denies.

With no UI (print mode, subagent children) nothing ever prompts: it behaves like
`full`, except saved deny rules and dangerous patterns are blocked with a reason.

## Plan mode

Entering plan mode (`/unipi:plan`, `Alt+P`):

- state is persisted per session, so a resume keeps it;
- a compact message states the rules: investigation only, the plan file is the ONLY
  writable path (`.unipi/plans/<YYYY-MM-DD>-<short-session-id>.md`), bash is limited
  to read-only commands;
- every later turn gets a short reminder `[plan mode: read-only · plan file … ·
  call plan_submit when ready]` — appended as a message, never to the system prompt,
  so the provider prefix cache stays intact.

Enforcement runs before the permission gate: writes to anything but the plan file are
blocked, bash must match the read-only allowlist (no jev), and mutating tools such as
`bg_run` are refused with
`Plan mode is read-only. Write your plan to <path> and call plan_submit.`

`plan_submit` shows the approval prompt — `Approve & implement` (Enter),
`Keep planning…` (your feedback returns as the tool result so the agent keeps going),
or `Discard plan`. Approving turns plan mode off, answers `Plan approved.`, and queues
the plan markdown as the next user message with the instruction to implement it.
`/unipi:plan view` shows the plan file; `/unipi:plan approve` runs the same approval
path without the tool call.

## Settings

Registered as the `permission` namespace and rendered by `/unipi:settings` →
**Permissions**:

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `ask` · `auto` · `full` |
| `jevJudge` | `true` | Let jev judge ambiguous bash in `auto` |
| `jevConfidence` | `0.7` | Minimum jev confidence to accept `safe` |
| `rules` | `[]` | Saved rules (count shown; clear via the action row) |

The footer shows the active mode (`auto` dim, `ask` accent, `full` warning) and a bold
`PLAN` marker while plan mode is active.

## Debugging

`UNIPI_DEBUG_PERMISSION=1` appends every decision to
`~/.unipi/logs/permission.log`:

```
decision tool=bash mode=auto verdict=jev risk=needs_approval confidence=0.82 action=ask cmd="npm publish"
```

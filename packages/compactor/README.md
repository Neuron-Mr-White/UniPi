# @pi-unipi/compactor

Compaction for Pi that keeps work going. When the context fills up, the compactor replaces older messages with a summary. The full history stays in the session file, so nothing is lost and anything can be recalled.

## Methods

| Method | What it does | Cost |
|---|---|---|
| **Lossless** (default) | Builds a structured summary without a model call, in milliseconds. | Free |
| **Lossless + jev** | The lossless summary, then jev (the Decision model, TypeSafe jev) drops items no longer in force: completed one-off requests, reversed decisions, fixed errors, an outdated report. Their room goes to other items. | ~0.5–2 s, fractions of a cent |
| **Model summary** | Pi's own model-written summary, with the active-work block added on top. | One model call |

jev only drops what it is confident about: decisions (including your answers to agent questions) need ≥92% certainty, one-off requests ≥80%, errors ≥75%. Your first and latest requests are never dropped. With no jev key or on timeout it falls back to the plain lossless summary. It uses the Decision-model settings (`/unipi:settings → Long-Horizon → Judge`).

### The lossless summary

It is rebuilt from the **full** session history on every compaction, never merged onto the previous summary, so it cannot drift or grow over time. Sections, in the order a resuming model needs them:

1. **Active Work**: the goal, ralph loop or kanboard task in flight, supplied by those modules from their own state.
2. **Your Requests**: the user's own messages and answers to agent questions (`ask_user`: "question → answer"). Text that extensions send with the user role (loop prompts, nudges, notifications) is excluded.
3. **Latest State**: the most recent step and the last full progress report.
4. **Decisions & Constraints**: the user's instructions ("keep the orange theme") and earlier answers to agent questions. Bug reports, pasted text and code blocks are left out.
5. **Files**: modified, created and read files, as relative paths.
6. **Commits**: hash and subject.
7. **Open Errors**: recent failures that were not followed by a success.
8. **Recent Transcript**: a ranked slice of recent work.

Each section has its own share of a hard budget (auto: 1.5k–4k tokens, scaling with session size). Credentials the user typed (passwords, API keys, tokens) are redacted; `session_recall` still has them. A closing line points the model to `session_recall`.

## When it compacts

- **Pi's context limit** (default): Pi decides when, using its own compaction settings (`compaction.reserveTokens`, per-model overrides). The compactor decides what the summary contains. Pi continues the run after compacting.
- **At a percentage**: compacts once context use reaches the set percentage. This happens at a turn boundary, so running goal, ralph and kanboard loops are not interrupted.

## Settings

`/unipi:settings → Compactor`

| Setting | Default | |
|---|---|---|
| Method | lossless | lossless · lossless + jev · model summary |
| Pi's /compact | same as Method | What Pi's built-in `/compact` does |
| When | Pi's context limit | Or: at a percentage |
| Percentage | 80 | Used when When = at a percentage |
| Notifications | on | A notice when compaction runs or fails |

**Advanced compaction** (collapsed): smart keep tail, summary budget, per-section toggles, percentage cooldown and repeat growth, extra instructions for model summaries, debug output.

Configs from before the rework are translated automatically: `overrideDefaultCompaction: false` becomes Method = model summary, and `autoCompaction.enabled` becomes When = at a percentage.

## Commands

| Command | |
|---|---|
| `/unipi:compact-vcc [keep:N]` | Lossless compaction now; `keep:N` keeps the last N user turns |
| `/unipi:compact-jev [keep:N]` | Lossless compaction pruned by jev |
| `/unipi:compact-by-llm [focus]` | Model-summary compaction now; optional text focuses the summary |
| `/unipi:session-recall <query>` | Search the full session history (`scope:all`, `page:N`) |
| `/unipi:compact-stats` | This session's compactions and savings |
| `/unipi:compact-doctor` | Check settings, Pi's compaction switch, leftovers |
| `/unipi:compact-help` | Command summary |

Deprecated: `/unipi:compact` and `/unipi:lossless-compact` (use `/unipi:compact-vcc`), `/unipi:compact-recall` (use `/unipi:session-recall`).

## Tools

- `session_recall`: keyword/regex search over the session branch, including compacted-away messages. `expand` returns full entries by index (the `#N` refs in summaries); `mode: "touched"` lists files.
- `context_budget`: how full the context is.

## For other modules

Register an active-work provider so summaries lead with your state:

```ts
import { registerCompactionContext } from "@pi-unipi/core";
registerCompactionContext("my-module", () => (running ? "Task X is in progress — …" : null));
```

Compactions applied at a turn boundary (percentage trigger) do not fire Pi's `session_compact`; listen to `UNIPI_EVENTS.COMPACTOR_COMPACTED` to react to every compaction.

## Removed in 3.0

- **Session continuity**: the SQLite event log and the hidden snapshot restored after compaction. It logged every session under one shared ID, so snapshots mixed projects and grew to ~60k tokens. The summary now derives files, errors and commits from the session itself. `/unipi:compact-doctor` reports the old `~/.unipi/db/compactor` directory, which can be deleted.
- **Sandbox tools** (`sandbox`, `sandbox_file`, `sandbox_batch`), the `compact` tool (it never compacted), `compactor_stats` / `compactor_doctor` tools (use the commands), presets, and the inert strategy modes.

---
name: cron
description: Schedule a one-time or repeating unattended `pi -p` run on this PC — the host (`unipi-host serve`) owns it, no pi window needed. Use when the user asks to schedule something, remind them, repeat a task daily/hourly/weekly, or run something later ("remind me in 2 hours", "every morning summarize my inbox", "check this every 5 minutes"). Covers listing/editing/removing jobs and checking what a past run did.
---

# cron — scheduled, unattended pi runs

`unipi-host` (the UniPi desktop host) runs a scheduler inside `serve`.
A cron job fires `pi -p "<prompt>"` on its own — on a cron schedule or
once at a given time — with nobody there to answer it. You set jobs up
with the `unipi-host cron` CLI.

## Before anything: write a self-contained, one-shot prompt

The job runs **unattended**: no one will be there to answer a question,
approve a choice, or clarify anything. Write the prompt as if you were
briefing someone who will never hear back from you:

- State the whole task in the prompt text — don't rely on "like we
  discussed" or anything from this conversation; the scheduled run
  starts a fresh pi session with no memory of it.
- Decide for it, don't ask it to decide. If there's a choice to make,
  make it in the prompt ("use the top 5", "pick the most recent file").
- **Say where the result goes** — a job that only prints to a log
  nobody reads isn't useful. Options:
  - **A file**: "write the summary to ~/notes/digest.md (overwrite each time)"
    or "append a line to ~/logs/check.log".
  - **A note in the project** (if this looks like a coding/notes
    project): "add a kanboard task with the result" or similar, if
    the project uses one.
  - **A notification from the job itself**: add `--notify` (below). The
    host sends one when the run finishes, so the prompt doesn't have to.
  - At minimum, the job's own summary (the last thing pi says) is kept
    and can be read back — mention that to the user if nothing richer
    applies.
- Keep it short and concrete. One job, one clear outcome.

## Setting it up

1. **Pick (or create) a folder** for the job to run in (`--cwd`) — it
   must exist. Reuse the project folder if this is about an existing
   project; otherwise a plain folder like `~/jobs/<name>` is fine
   (`mkdir -p` it first if it's new).
2. **Add the job**:

   ```bash
   unipi-host cron add --name "<short name>" \
     --prompt "<the full, self-contained prompt — see above>" \
     --schedule "<plain language, see below>" \
     --cwd <the folder>
   ```

   For a one-time reminder, use `--at` instead of `--schedule`:

   ```bash
   unipi-host cron add --name "<short name>" --prompt "<prompt>" \
     --at "in 2 hours" --cwd <the folder>
   ```

   Plain-language schedules/times that work: `every 5 minutes`,
   `every day at 9:00`, `weekdays at 18:30`, `every monday 08:00`,
   `hourly`, `daily` for `--schedule`; `in 2 hours`, `tomorrow at 9`
   for `--at`. A 6-field cron (seconds first) or an exact `at:
   <RFC3339>` instant also works, for anything the phrasing above
   doesn't cover. `--tz <IANA zone>` picks the zone (default: this
   PC's).

   Optional flags worth offering:
   - **`--notify ntfy,telegram,gotify --notify-on done,failed`**: the host
     notifies on the user's own channels when a run ends. Without
     `--notify` it uses the user's enabled channels, for failed runs only.
     `--notify-on` takes `done`, `failed` and `skipped`.
     `unipi-host cron test-notify <id>` sends one test message.
   - **`--wake-here`**: when a run finishes, the host sends THIS session a
     short message ("[cron] <name> finished: <status>. <summary>…"), so you
     can follow up on the result. An idle session runs it at once, a busy
     one queues it, and if the session is closed it is dropped. Use it when
     the user wants you to act on the result ("check back when it's done").
     `--wake-session <session file>` links another session instead.

3. **Confirm the schedule back to the user**: `cron add` (and `cron
   edit`) print the resolved cron expression and the next 3 fire
   times — read those back to the user so they know exactly when it
   will run, e.g. "set for weekdays at 18:30 — next: 2025-06-10 18:30,
   2025-06-11 18:30, 2025-06-12 18:30 (Europe/Berlin)".

## Managing jobs

```bash
unipi-host cron list                      # every job, schedule, enabled/disabled
unipi-host cron show <id>                 # one job + its recent runs
unipi-host cron edit <id> --schedule "..."   # change just what's given
unipi-host cron enable <id> / disable <id>
unipi-host cron rm <id>                   # remove it (and its run history)
unipi-host cron run <id>                  # fire it right now, for testing
unipi-host cron stop <id>                 # kill it mid-run
unipi-host cron pause / resume            # pause every job host-wide; running ones finish
unipi-host cron status                    # next fire per job, what's running
```

## Checking results

```bash
unipi-host cron runs <id> [--limit N]     # history: ok / failed / timeout / skipped, newest first
unipi-host cron log <run id>              # one run's captured output, session path, cost
```

After setting a job up (or when the user asks how it's going), check
`cron runs <id>` once it should have fired — don't just assume it
worked. A `failed`/`timeout` run's reason explains what went wrong
(bad cwd, pi not found, over its cost cap, the time limit).

## Rules

- **Never create a job the user didn't ask for.** No "just in case"
  schedules, no duplicate jobs for the same thing — `cron list` first
  if unsure whether one already exists.
- **Remove test jobs.** If you create one to check something works
  (e.g. during setup, or to demonstrate), `cron rm` it once you're
  done — don't leave scratch jobs on the user's schedule.
- **One job, one task.** Don't fold unrelated things into a single
  prompt to save a job slot.
- If the user wants to change a job, prefer `cron edit` over
  delete-and-recreate (it keeps the run history and the id).

## If the host isn't running

This skill needs `unipi-host serve` running on this PC (it's how
`unipi-host` is on PATH in the first place, via the UniPi desktop
app). If `unipi-host cron …` fails to connect, tell the user to check
the UniPi app is open — don't try to start the host yourself.

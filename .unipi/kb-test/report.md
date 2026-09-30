# Kanboard start/finish live test — coffee (parts A, B, C)

Date: 2026-09-29 · Spec: `docs/specs/2026-09-29-kanboard-progress-monitor.md`
Board UI screenshot (agent chip, from the first part-A run): `board-agent-chip.png`

## Setup

- Machine: coffee (ssh, Ubuntu 26.04), node 24 via mise.
- Load mode: **published package** — `npm:@pi-unipi/unipi@alpha` registered in
  `~/.pi/agent/settings.json` `packages`; installed **@pi-unipi/unipi 3.0.0-alpha.12**
  under `~/.pi/agent/npm` (kanboard TS under the install is byte-identical to the
  repo source for `reminders.ts`; binary `unipi-kanboard 3.0.0-alpha.12` at
  `~/.pi/agent/npm/node_modules/@pi-unipi/kanboard-linux-x64/bin/unipi-kanboard`).
- pi 0.87.1 headless: `cd ~/kb-b && pi -p "do KB-1 and KB-2" --approve`.
- Model: coffee default `dva/deepseek-v4-flash-low` (omniroute); the long-horizon
  judge abstained (confidence 0.56 < 0.6) → `defaultMode: goal`, and goal mode
  switched the working model to **openrouter/moonshotai/kimi-k2.6** (per-run model
  recorded below; identical in every run).
- Scratch: project `~/kb-b` (git repo), board isolated via `UNIPI_KANBOARD_HOME=~/kb-board`
  (nothing written under `~/.unipi` for the board), project slug `kb-b-63fb9e`
  (deterministic for the root path), tasks KB-1/KB-2 recreated in **todo** before
  every run (`~/kb-reset.sh`), files reset (`README.md` with the `recieve` typo,
  `src/` emptied). Reminders toggled via the project settings file
  `~/kb-b/.unipi/config/kanboard/config.json` (`{"slug":…,"reminders":true|false}` —
  the path from `packages/kanboard/src/settings.ts` + `core/src/settings/paths.ts`).
- Per-run measurement: an analyzer mirroring `reminders.ts` ordering logic walked each
  session jsonl (start/finish vs first file-changing call; R1 = `[kanboard] … still Todo`
  appended to a tool result; R2 = `custom_message` with `customType:
  unipi:kanboard-reminder`). Scratch artifacts (`~/kb-runs/…`) were deleted after this
  report was written; only the board data (`~/kb-board`) was kept on coffee. All line
  numbers below were verified against those captures.

## A. Deterministic board checks — PASS

Direct binary calls (agent actor, explicit `--session`):

| # | Check | Result |
|---|-------|--------|
| A1 | `start KB-1` (session s1): todo → in_progress, `run.owner=agent`, `run.session=s1`, activity "started (pid …)" actor=agent | PASS |
| A2 | `finish KB-1` without `--comment` refused | PASS (usage error, exit 2) |
| A3 | `finish KB-1 --comment` from session s2 refused: "started by session s1, not this one (s2)" | PASS |
| A4 | `finish KB-1 --comment …` from s1: in_progress → in_review | PASS |
| A5 | `start` on a non-todo task refused ("the task is in_review, not todo") | PASS |
| A6 | `start`/`finish` free (no `/unipi:kanboard-do` window; `guard.ts` FREE_WRITES) | PASS — every live run below used them with no -do turn and no guard refusal |

## B. Live agent behaviour

(prompt: `do KB-1 and KB-2`; per-run table below)

Success criterion (spec): **≥ 9/10 ON runs with start-before-first-edit AND finish-before-end for
BOTH tasks → NOT MET: 3/10.**

"first genuine mutation" = first edit/write tool call or first bash command that really changes
project files (`npm init/install`, file writes). The code's own R1 trigger is far more
conservative (see F4/F5), so both measures are recorded below (✓/✗ use genuine mutation).

### Reminders ON (10 runs, default)

| run | dur | R1 | R2 | start KB-1 | start KB-2 | first mutation | finish 1 | finish 2 | end board |
|-----|----|----|----|-----------|-----------|----------------|---------|---------|-----------|
| on-1 | 112s | – (silent: started in time) | – | L44 ✓ | L44 ✓ | L56 write | L63 ✓ | L63 ✓ | in_review/in_review |
| on-2 | 90s | L17 (on read-only `find\|sort`) | – | L20 ✓ | L20 ✓ | L26 `npm init` | L50 ✓ | L50 ✓ | in_review/in_review |
| on-3 | 19s | – | – | — | — | none | — | — | todo/todo (asked for clarification, did nothing) |
| on-4 | 121s | – (silent: KB-2 already started) | **L44 → finished L47** | L25 ✗ (edit L23 first) | L21 ✓ | L23 edit README | L47 ✓ | L47 ✓ | in_review/in_review |
| on-5 | 85s | L21 (on plain `kanboard list`) | – | L26 ✓ | L42 ✗ | L28 write | L40 ✓ | L46 ✓ | in_review/in_review |
| on-6 | 135s | L21 (on `node --version`) | – | L24 ✓ | L35 ✗ | L28 write | L33 ✓ | L39 ✓ | in_review/in_review |
| on-7 | 86s | L19 (**fired, ignored**) | – | — | — | L30 write | — | — | todo/todo (work done, board never touched) |
| on-8 | 125s | – (silent: started in time) | **L51 → finished L54** | L31 ✓ | L31 ✓ | L37 edit README | L54 ✓ | L54 ✓ | in_review/in_review |
| on-9 | 88s | – | – | L14 ✓ | L36 ✗ (start at finish time) | L26 write | L34 ✓ | L36 ✓ | in_review/in_review |
| on-10 | 133s | L39 (on `which/node --version`) | – | L40 ✓ | L56 ✗ | L49 write | L54 ✓ | L61 ✓ | in_review/in_review |

Both-task pass: **on-1, on-2, on-8 = 3/10**. Broken down:

- **finish-before-end: 8/8 engaged runs** (every run that touched the board finished BOTH
  tasks with a `--comment` summary before exiting; the 2 disengaged runs did neither).
- **start-before-edit for the first-worked task: 8/8 engaged runs.**
- **start-before-edit for the second task: 3/8** — the dominant failure mode: the agent works
  KB-1 to completion, then does KB-2's file work, and only then runs `start KB-2` immediately
  before `finish KB-2` (on-9 has both on the same line). The board still ends correct, but
  KB-2 was "In Progress" only for the instant of its finish.
- **No engagement: 2/10** (on-3 asked what KB-1/KB-2 are instead of reading the board; on-7 did
  all the work but never used start/finish despite R1 firing).
- R1 fired in 5/10 (on-2,5,6,7,10), always with correct IDs; correctly silent in on-1/8/9
  (session had started tasks before any file-changing call) and on-4 (a task was already
  started — spec's `started = ∅` condition).
- R2 fired in 2/10 (on-4, on-8), **delivered headless** (see next section), agent complied both times.
- Tokens/tools per run (rough): 6–40 tool calls, 6k–100k input / 0.5–5k output tokens,
  ≈$0.01–0.09 per run, all on `openrouter/moonshotai/kimi-k2.6`.

### Reminders OFF (5 runs, `reminders:false` in `~/kb-b/.unipi/config/kanboard/config.json`)

| run | R1 | R2 | start KB-1 | start KB-2 | first mutation | finish 1 | finish 2 | end board |
|-----|----|----|-----------|-----------|----------------|---------|---------|-----------|
| off-1 | – | – | L50 ✓ | L64 ✗ | L57 write | L64 ✓ | L72 ✓ | in_review/in_review |
| off-2 | – | – | — | — | L29 write | — | — | todo/todo (work done, board untouched) |
| off-3 | – | – | L52 ✓ | L66 ✗ | L57 write | L62 ✓ | L72 ✓ | in_review/in_review |
| off-4 | – | – | L30 ✓ | L40 ✗ | L33 write | L38 ✓ | L45 ✓ | in_review/in_review |
| off-5 | – | – | — | — | L48 edit | — | — | todo/todo (work done, board untouched) |

- **No R1/R2 in any OFF run** — the setting is honored (reminder text absent from all 5 jsonls).
- Same shape as ON minus the reminders: first task started before edits (3/3 engaged), second
  task started late (3/3 engaged), finishes with comments (3/3 engaged), 2/5 disengaged
  (both derailed by the guard/credits confusion — F1/F3).
- ON vs OFF headline: correct final board 8/10 ON vs 3/5 OFF; the strict start-timing
  criterion fails equally in both — the failure mode (second task started at finish time)
  happens after R1's once-per-turn window, and R2 only reacts at turn end.

## R2 delivery (headless caveat)

**Headless `pi -p` DOES deliver R2.** Evidence:

1. on-4: turn ended with tasks started but unfinished → `custom_message
   {customType: "unipi:kanboard-reminder"}` at session line 44 (full CLI prefix in the text)
   → follow-up turn → both `finish … --comment` at L47. Same shape in on-8 (R2 L51,
   finishes L54).
2. Dedicated probe (`~/kb-runs/r2probe`; prompt: run `start KB-1`, then stop, no finish):
   turn 1 starts KB-1 → agent_end → R2 delivered as a follow-up turn (agent acknowledged,
   declined per my explicit instruction) → second agent_end → **second R2 → cap reached
   (MAX_REMINDERS_PER_TASK = 2), no third reminder, pi -p exits**. Board left KB-1
   in_progress claimed by `pi-1597395` — the designed steady state.

No interactive tmux needed (the caveat's fallback was only for non-delivery). Delivery works
because the reminder is sent at `agent_settled` via `sendReminder(..., { triggerTurn: true })`
(packages/kanboard/index.ts:241-247, packages/kanboard/src/reminders.ts:282-284).

## C. Two concurrent sessions

Two concurrent `pi -p "do KB-1"` sessions in `~/kb-b` (A launched first, B 3 s later), fresh
board (KB-1/KB-2 todo), reminders ON.

- **Who got the claim: A** (session `pi-1597692`). Its transcript: `list` (L20, KB-1 todo) →
  `start KB-1` (L23, "claimed by this session", board activity 14:37:19) → work →
  `finish KB-1 --comment "Created src/math.ts …"` (L30, board 14:38:01).
- **What B did:** duplicated the same file work (both wrote `src/math.ts` + test; contents
  compatible, test passing), never claimed. Its board interaction was entirely guard-blocked
  (F1/F2): `which unipi-kanboard; ls; find …` (L25) and `… dump` (L28) blocked as
  "credits used up", and its actual claim attempt `start KB-1 2>&1; … review KB-1 2>&1`
  (L40) was blocked **because the invalid `review` subcommand is a non-free write — the free
  `start` in the same compound call was lost with it**. B concluded "kanboard write credits
  are currently exhausted", said it couldn't sync the board, and stopped. Binary-level
  contention ("started by session X, not this one") was therefore never reached — the guard
  decided the race, not the board.
- **Board consistency afterwards: OK.** KB-1 `in_review` with the claimer's summary (`run`
  cleared), KB-2 untouched `todo`, `validate: ok`, activity log coherent (user created →
  agent pi-1597692 started → finished). No double-claim, no torn state.

## Bugs / findings

All evidence = session-jsonl line numbers in `~/kb-runs/<run>/session.jsonl` on coffee
(verified against per-run board.json / `show --json` captures).

**F1 — Guard blocks read-only commands that merely mention the binary (HIGH, live impact).**
`kanboardInvocations` (packages/kanboard/src/guard.ts:78-97) treats every `unipi-kanboard`
token as an invocation; `which unipi-kanboard`, `type unipi-kanboard`,
`find … -name "unipi-kanboard"`, `pip show pi-unipi-kanboard` parse as sub `""` → not
READONLY, not FREE_WRITES → `check()` (guard.ts:160-166) returns "kanboard write credits
used up — run /unipi:kanboard-do to reload" for commands that never touch the board. Hit in
10/15 part-B runs + part-C B (on-1 L12/L15/L21, off-1 L11/L14/L20/L25, off-3 L11/L25/L40,
off-5 L14, partc session-1 L25/L28). Root cause of most board disengagement: agents read
the block as "CLI unusable".

**F2 — One non-free invocation blocks the whole compound bash call, including free writes
(HIGH).** `check()` returns on the first chargeable invocation (guard.ts:163), so
`… start KB-1 2>&1; … review KB-1 2>&1` was blocked entirely — the free `start` never ran
(partc session-1 L40). Same mechanism swallowed `start KB-1` glued after an invalid
`done KB-2` in on-4 L25.

**F3 — Blocked agents poison project memories with "credits exhausted" (HIGH, compounding).**
on-4 stored `kb_b_project_state_and_kanboard_credits` ("Kanboard write credits were
exhausted … tasks could not be marked done via the CLI" — false: start/finish are free);
off-2 and off-5 then read that memory and skipped the board entirely. Cross-project memory
search made it worse: on-4's `memory_search` (scope all) surfaced the earlier kb-test run's
memories (`kbt_61_already_in_review_cannot_be_started`, …) before it had any refusal of its
own. The refusal text (guard.ts:13) never says start/finish are free, so agents cannot
self-correct. 3+ runs lost to this chain. (I deleted `~/.unipi/memory/kb_b/*` before part C
as scratch cleanup; part C then engaged cleanly.)

**F4 — R1's `shellChangesFiles` splits on `|` inside quotes (LOW, conservative).** The
redirect test strips quoted spans first (reminders.ts:65) but the segment split at
reminders.ts:66 uses the raw string, so `grep -E "kb-b|kb_b"` splits mid-string and the
`kb_b"` fragment counts as a mutating command. Pilot run: R1 appended to a pure
`find … | grep -E "kb-b|kb_b" | head` result. R1 fires early (never misses) — spec-safe,
but noisy.

**F5 — READ_COMMANDS allowlist is narrow for a node project (LOW, conservative).** `node`,
`npx`, `npm`, `sort`, `xargs`, `git stash`, `pip` are "file-changing" per reminders.ts:44-49
and 62-69, so `node --version` / `npx tsx --version` / `find | sort` armed R1 (on-6 L21,
on-10 L39, on-2 L17, on-7 L19). With F4, R1's "first file-changing call" is in practice
"the third or fourth bash call of any kind".

**F6 — `done <ID>` attempts get a credits message instead of "no such subcommand" (LOW).**
on-4 L25/L39 ran `unipi-kanboard … done KB-2/KB-1`; the guard rejects the unknown sub as a
chargeable write before the binary can reject it, feeding F3's misreading.

**F7 — Behavioural (the main gap vs the spec's 9/10 bar): the second task is started at
finish time.** 5/8 engaged ON runs (on-4,5,6,9,10) worked KB-2's files before `start KB-2`,
usually one call before `finish KB-2`. R1 cannot catch this: it fires once per turn and is
silenced once any task is started (`started = ∅` in the spec; `tasks.some(ownedStart)` gate
at reminders.ts:183-185). R2 reacts only after a turn ends with the task in_progress — by
then the agent has usually finished. A per-task R1 (nudge when a still-Todo mentioned task's
work begins, even after another was started) is the likely fix.

**Verified fine (non-findings):** start/finish genuinely free (no -do window in any run);
finish always carried `--comment` (0 missing in 24 finish calls across all parts); R1 IDs
always correct; reminder caps respected (R2 cap 2 confirmed by the probe); reminders fully
silent in all OFF runs; `validate: ok` after every scenario; no daemon spawned by any run;
per-process session claims correct in part C.

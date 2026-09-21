# long-horizon design (v3)

Status: draft for review. Builds on `docs/long-horizon-study.md` (mechanisms) and the v3 task plan.
Decisions locked by user: **mcode's goal (propose+verify) · Maka's swarm + graph · our /ralph kept ·
mode-gated tool exposure via a prompt judge (TypeSafe jev-1.13)**.

---

## 1. The core idea: one coordinator, four modes, tools exposed per mode

The agent never sees all long-horizon tools at once. A **gate** resolves the active
**mode** for each turn and exposes only that mode's tool set + orchestration prompt.
Everything else stays a **deferred tool** (pi 0.86 native deferred loading — activation
does not rewrite the prefix-cache).

```
user prompt
   │
   ▼
[gate] 1. explicit /unipi:<mode> <prompt>  → that mode (turn override)
       2. active automation owner?          → owner's mode (no judge call)
       3. judge enabled + configured?       → TypeSafe Choice {goal|ralph|swarm|graph|none}
       4. fallback                          → default mode = goal
   │
   ▼
expose: mode tools + orchestration prompt fragment + always-on infrastructure
```

### Tool exposure matrix

| Tools | goal | ralph | swarm | graph (v2) | always-on |
|---|---|---|---|---|---|
| `create_goal` `get_goal` `update_goal` | ● | | | | |
| `ralph_done` (+ loop status tool) | | ● | | | |
| `swarm_status`, `swarm_yield` | | | ● | ● | |
| `view_agent_graph` `update_agent_graph` `agent_output` | | | | ● | |
| `spawn_helper` `bg_delegate` `bg_run` (delegation) | deferred | deferred | ● | ● | |
| `todowrite` (visible plan) | ● | ● | ● | ● | |
| file/shell/memory/ask_user/notify/web/sandbox/context | | | | | ● |

Rationale: delegation in goal/ralph is *deferred-loadable*, not absent — a goal that
genuinely needs fan-out can load it, but the default surface stays minimal.
`none` (judge says ordinary turn) = infrastructure only, no mode tools.

## 2. The judge (TypeSafe System One)

One `POST https://api.typesafe.ai/v1/systemone` call per **new user message only**
(never on continuations/wakes/recovery):

```json
{
  "state": "<user prompt>",
  "model": "jev-latest",
  "questions": {
    "mode": {
      "type": "choice",
      "instructions": "Which execution mode fits this request?",
      "criteria": {
        "goal":  "one objective pursued across turns until verifiably true",
        "ralph": "work through a task file / checklist over many iterations",
        "swarm": "several independent items that parallel workers can settle, then synthesize",
        "graph": "multi-step work where later steps depend on earlier results",
        "none":  "ordinary conversational or coding request"
      }
    },
    "decomposable": { "type": "noul", "instructions": "Can this be split into independent parallel items?" }
  }
}
```

- **Confidence gate**: `confidence < threshold (default 0.6)` → keep active owner, else
  default mode. Optionally surface a one-line note (`/unipi:mode` to override). Configurable.
- **Fail-open**: timeout (~1s budget) / error / no key → active owner, else default. The gate
  never blocks a turn on the judge.
- **Auth**: `TYPESAFE_API_KEY` (direct) or OpenRouter base/key — both configurable in the
  utility settings hub (judge on/off, model, baseUrl, threshold, default mode).
- **Determinism for tests**: injectable transport; record/replay fixtures in CI.

## 3. Edge cases (the matrix we agreed to think through)

| Case | Behavior |
|---|---|
| Explicit `/unipi:<mode>` with **no active owner** | Switch. Mode applies to this turn; if it spawns an owner (loop/goal), the owner persists |
| Explicit switch **while an owner is active** | **Suspend-and-switch**: owner → `paused(superseded_by:<mode>)`, state persisted + status line shown; never silently kill a token-burning owner. Resume via `/unipi:<mode> resume` or `/unipi:continue` |
| Judge suggests a different mode **while an owner is active** | **Owner wins** — the prompt is steering into the current owner. No switch, no judge-triggered suspension. (Judge dissent logged as telemetry only) |
| Mid-turn slash command | Queued by pi; mode resolves at next turn admission. No mid-turn tool-surface swaps |
| **Crash / restart** | **Repair, don't resume**: reload `.unipi/long-horizon/state.json`, reattach owner's tools, surface status (`goal "X" active · 12/50 · interrupted`). Mid-flight turn = retracted turn → recovery fragment (mcode pattern): agent must call `get_goal`/status tool first, treat it as source of truth. Judge not consulted |
| User says **"continue"** | Owner active/paused → resume owner (no judge). Owner terminal/absent → normal resolution (judge/default) |
| **Compaction** mid-owner | Kickoff contract + owner status live in compactor preserved-sections; state is disk-backed; after compaction the coordinator re-injects a compact status fragment. Judge not involved |
| **Wake during owner mode** (bg task completes) | Coordinator wakes in the owner's mode with its tools. If the user typed meanwhile, user turn first, continuation queued behind (Maka: user always wins) |
| Owner reaches terminal state | Tools stay exposed until turn end (agent reports), then surface drops to infrastructure; next prompt re-resolves |
| Judge off / unconfigured | Default mode = goal (per plan) — goal tools always available, heavier machinery hidden |

**Owner rules** (mcode's one-automation-owner, Maka's lease/revision):

- One **active** owner per session: goal | ralph-loop | swarm | graph.
- Owner state persisted on every transition: `{mode, ownerId, status, revision, lease, updatedAt}`.
- `paused` owners are kept (max 1 parked owner in v1) and resumable; resuming replaces the active owner.
- Control lease `{ownerId, generation}` so a stale `update_goal`/`ralph_done` from a
  pre-suspend turn is rejected, not applied.

## 4. Mode internals (inherited from the study)

- **goal**: mcode propose+verify. Worker calls `update_goal(status:"complete")` → host settles via
  independent evaluator (session-external, bounded, fail-open-neutral on verifier failure,
  `missing[]` fed back on `not_met`, `notMetStreak`). Continuation: kickoff contract once
  (cache-stable), one-line hints after, `NO_PROGRESS`/`NO_TOOL` nudges, 5-turn terminal audit,
  backoff on `waiting`, wrap-up turn on budget exhaustion. Maka's stall cap + revision checkpoint +
  baseline-pending budget + status-reason taxonomy.
- **ralph**: our task-file loop unchanged (checklist on disk, iteration cadence, reflection),
  re-hosted on the coordinator: gains stall cap, budgets, control lease (stale `ralph_done`
  rejected), completion claim → verifier when all items check.
- **swarm**: Maka's prescription over our transports. Orchestration prompt block (Maka's
  swarm-mode block adapted): ≥2 independent items, batch-schedule via `spawn_helper`/`bg_delegate`,
  then yield (end turn); wakes drive the next supervisor turn; `swarm_status` projection;
  replace-failed; finish + dedupe + synthesize. "Do not manufacture parallelism."
- **graph** (v2): dependent DAG — `update_agent_graph` with input frontiers over committed
  results, monotonic topology, explicit finish. Deferred until swarm proves the wake/claim
  machinery.

## 5. Implementation layout

```
packages/long-horizon/
  src/
    index.ts          entry: commands, gate hook, tool registration, events
    modes.ts          mode registry: id, tools[], prompt fragment, owner kind
    owner.ts          automation-owner machine + .unipi/long-horizon/state.json persistence
    gate.ts           before_agent_start: resolve → tool surface + prompt fragment + status line
    judge/
      typesafe.ts     /v1/systemone client (injectable fetch; openrouter fallback base)
      resolve.ts      question builder, confidence gate, 1-entry cache (hash → decision, TTL)
    tools/
      goal.ts         create_goal / get_goal / update_goal (mcode schemas, lease-guarded)
      todo.ts         todowrite (snapshot-replace; footer/info-screen render from events)
      ralph.ts        ralph_done + loop_status (ralph_start stays command-side)
      swarm.ts        swarm_status projection + swarm_yield
      graph.ts        v2 stub (registered only in graph mode, errors "not yet available")
    engine/
      continuation.ts turn-end → settle → continue|wait|stop (shared by goal+ralph)
      verifier.ts     evaluator adapter (bounded evidence brief; injectable for tests)
      runaway.ts      step-end detectors → steer-once nudges (anti-poisoning text)
    prompts/
      goal-kickoff.ts mcode contract (once) + hint templates
      swarm-block.ts  Maka-style orchestration block
  tests/              scripted-provider scenarios; judge fixtures; no network in CI
```

Config in the **utility settings hub** (v3 plan: all module settings in one place):
`long_horizon.judge.enabled | provider(typesafe|openrouter) | model | baseUrl | threshold |
default_mode | note_on_low_confidence`.

pi seams: `before_agent_start` (surface + fragment), `defineTool` custom tools,
slash commands, events for footer/info-screen (`owner-changed`, `mode-resolved`),
compactor preserved sections, pi 0.86 deferred tools for the exposure matrix.

## 6. Sandbox testing plan

```
mise run sandbox   # pi + long-horizon only, judge on, requires TYPESAFE_API_KEY or OPENROUTER_API_KEY
```

- Task: `pi --no-extensions --no-skills -e packages/long-horizon/test-sandbox.ts`
  (thin entry: coordinator + stubbed heavy tools; real judge if key present, else fail-open default).
- CI (no network): **scripted-provider** pattern already proven in background-tasks tests —
  fake provider replays scripted turns; judge transport mocked with recorded fixtures.
- Scenario matrix to cover:
  1. judge off → goal tools exposed; `/unipi:swarm x` overrides
  2. judge on → classification routes + low-confidence fallback
  3. mid-goal explicit `/unipi:swarm` → goal parked, swarm tools, resume returns goal active
  4. crash → restart restores owner + tools + status; retracted-turn recovery fragment
  5. "continue" after terminal → re-resolve
  6. compaction mid-goal → contract survives, continuation hint still one-line
  7. wake during swarm → supervisor turn with swarm tools; user-first ordering
  8. stale `update_goal`/`ralph_done` after suspend → lease rejection

## 7. Open questions

1. Should judge-ON still allow `none` (plain turns get no goal tools), or is goal-always the rule?
   (Design assumes `none` exists; "goal by default" applies to judge-OFF only.)
2. Parking limit: keep at most 1 paused owner (simplest UX) or a park list?
3. Should ralph mode also expose goal tools for per-item deep work? (Design: no in v1.)
4. Graph in v1 as a stub that error-hints "use /unipi:swarm", or fully hidden?

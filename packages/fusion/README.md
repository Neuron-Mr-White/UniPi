# @pi-unipi/fusion

Local Fusion for UniPi: a Devin-inspired lead + persistent sidekick pair, a
curated model preset, and a keyboard-first picker (`/unipi:model`). It uses
pi's extension and RPC APIs natively.

## `/unipi:model` — the picker

```
╭ Model ───────────────────────────────────────────────────────────────╮
│/ Type to search                                                       │
│───────────────────────────────────────────────────────────────────────│
│❭ Fusion                  ← ▰▰▰▱▱ → Medium     Lead Claude Fable… ▾    │
│· GLM-5.3 Flash ✱        ▰▰▰▰▰   Max                              │
│· Claude Fable 5.1       ▰▰▰▱▱   Medium                           │
│· DeepSeek V4.1 Flash ✱  ▰▱▱▱▱   High                             │
│  ↓ more below                                                        │
│                                                                       │
│  ━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━               │
│  Input      Cached input   Output     Sidekick input                 │
│  $10 / 1M   $0.25 / 1M     $50 / 1M   $0.2 / 1M                     │
│  Sidekick cached input   Sidekick output                             │
│  $0.02 / 1M              $1.2 / 1M                                   │
│                                                                       │
│  ✱ New  ✱ Promotion  ✱ Beta · Pairs frontier intelligence with cost-efficient execution │
│↑↓ select · tab lead · ←→ effort · ↵ confirm · esc cancel              │
╰───────────────────────────────────────────────────────────────────────╯
```

- **Row order**: the active selection pinned first, then the Fusion row (when a
  pair is configured), then recent (≤5, MRU), then the preset models, then
  **every other available model** — the catalogue is never hidden; the preset
  only controls ordering. When a single model is selected its row lights up
  with `✓`; when Fusion is selected the selection lives on the Fusion row and
  plain rows stay unmarked.
- **`←`/`→`** steps the highlighted row's effort (pi thinking level:
  off → minimal → low → medium → high → xhigh → max) and it is **remembered per
  model**. The five-cell bar fills with `▰` and uses `▱` for remaining levels.
  The Fusion row keeps its own lead/sidekick efforts, so adjusting Fusion never
  rewrites a model's standalone level.
- **`tab`** on the Fusion row cycles focus: effort → lead → sidekick
  (`shift+tab` reverses). Focused columns open an inline dropdown over the
  preset lists; `↵` applies, `esc` collapses.
- **Price panel**: the highlighted model's blended price is marked on a
  logarithmic red→orange→yellow→green→cyan→blue→violet slider. Fusion shows
  `Input`, `Cached input`, `Output`, `Sidekick input`, `Sidekick cached input`,
  and `Sidekick output`.
- **Confirm** applies: `pi.setModel`, `pi.setThinkingLevel(effort)`, updates
  MRU + persisted active selection, and shows `Fusion · Lead ◆ Sidekick` in
  the footer. Switching the model through pi's own `/model`/Ctrl+P drops
  Fusion mode.
- Because pi intercepts `/model` inside its editor before extensions run, the
  command cannot be replaced — instead typing `/model` pins `/unipi:model`
  as the **first autocomplete suggestion**.
- Fast Mode is not implemented because pi has no equivalent capability.

Hand-edited preset badge metadata renders `✱` as New, Promotion, or Beta:

```json
{"badges": {"provider/model": "new"}}
```

## `/unipi:fusion-preset` — curation

Two-column checklist over every available model:

```
╭ Fusion preset ───────────────────────────────────────────────────────╮
│Fusion preset · 2 lead · 2 sidekick · writes to global                │
│Search: (type to filter)                                               │
│    L   S    model                                                     │
│ › [x] [ ]  provider/lead                                              │
│   [ ] [x]  provider/sidekick                                          │
│↑↓ select · ←→ column · space toggle sidekick · Enter save · esc cancel │
╰───────────────────────────────────────────────────────────────────────╯
```

- `←`/`→` (or `tab`) switches the L/S column, `space` toggles membership,
  `Enter` saves & closes, `esc` cancels, and typing filters. Selected models
  float to the top so the curated set is always visible.
- Defaults are not edited here: confirming a Fusion pair in `/unipi:model`
  records it as the preset default.

Any model key in the registry is allowed — there is no OAuth/subscription gate.

## Persistent sidekick

Confirming a Fusion pair selects the lead for the session. The `sidekick` tool
runs one lazy-spawned child pi per lead session; its session file is persisted
at `~/.unipi/state/fusion/sidekick/<lead-session-id>.jsonl`. Context and shells
persist across handoffs. The sidekick's context compacts independently of the
lead's (it is its own pi session). `sidekick({message, block:true})` waits by
default; `block:false` returns immediately and delivers a
`<subagent_completion_notification>`. Calling it while busy steers the same
handoff. `read_subagent({agent_id?, block?, timeout?})` reads or waits for a
handoff.

The child receives `UNIPI_FUSION_CHILD=1` and `UNIPI_SUBAGENT_CHILD=1`; the
Fusion extension guard prevents child processes from registering Fusion tools,
commands, or lead policy.

The lead gets the persistent delegation policy through `before_agent_start`,
and the first direct `edit`/`write` receives a one-time delegation nudge.
`/unipi:fusion-stats` reports sidekick tokens, costs at sidekick and lead
rates, estimated savings, handoff count, and runtime state. The footer shows
savings above `$0.005`.

## Storage

```json
// ~/.unipi/config/fusion/preset.json (global)
// <cwd>/.unipi/fusion-preset.json    (project override; lists replace, objects merge)
{
  "schema_version": 1,
  "lead": ["provider/lead"],
  "sidekick": ["provider/sidekick"],
  "default": {"lead": "provider/lead", "sidekick": "provider/sidekick"},
  "effort": {"provider/sidekick": "high"},
  "badges": {"provider/sidekick": "new"},
  "recent": ["provider/lead"],
  "active": {"kind": "fusion", "lead": "provider/lead", "sidekick": "provider/sidekick"}
}
```

## Status

- [x] Preset store, project layering, curation UI, autocomplete boost
- [x] Picker effort bars, price slider, price panel, badges, legend
- [x] Persistent sidekick runtime, blocking/non-blocking tools, steering,
      progress, completion card, session isolation
- [x] Lead policy, first-edit nudge, savings estimate, footer and stats command

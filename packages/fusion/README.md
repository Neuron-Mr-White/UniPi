# @pi-unipi/fusion

Devin-inspired model UX for UniPi: a curated model preset, a keyboard-first
picker (`/unipi:model`), and (next step) a Local Fusion runtime with a
persistent sidekick agent.

Architecture learned from [Devin Fusion](https://cognition.com/blog/devin-fusion)
and the Devin CLI; implemented natively on pi's extension APIs.

## `/unipi:model` — the picker

```
╭ Model ───────────────────────────────────────────────────────────────╮
│/ Type to search                                                       │
│───────────────────────────────────────────────────────────────────────│
│❭ GLM 5.3 Flash            ← ◼◼◼◼◻ → High       [omniroute]           │
│· Fusion                     ◼◼◼◼◻   High       Lead Opus… ▾  Sidekick…▾│
│  ▸ Claude Opus 4.6 (Thinking) *                                       │
│    Claude Sonnet 4.6 (Thinking)                                       │
│· Claude Opus 4.6 (Think…    ◼◼◼◼◻   High       [omniroute]           │
│                                                                       │
│  Input      Cached input   Output     Sidekick input  Sidekick output │
│  $10 / 1M   $0.25 / 1M     $50 / 1M   $0.2 / 1M       $1.2 / 1M      │
│  Pairs frontier intelligence with cost-efficient execution            │
│↑↓ select · tab lead · ←→ effort · ↵ confirm · esc cancel              │
╰───────────────────────────────────────────────────────────────────────╯
```

- **Row order**: the active selection pinned first, then the Fusion row (when a
  pair is configured), then recent (≤5, MRU), then the preset models, then
  **every other available model** — the catalogue is never hidden; the preset
  only controls ordering. The model currently working lights up: `✓` on the
  session model, `◆` on the active sidekick.
- **`←`/`→`** steps the highlighted row's effort (pi thinking level:
  off → minimal → low → medium → high → xhigh) and it's **remembered per model**.
  The Fusion row keeps its own lead/sidekick efforts, so adjusting Fusion never
  rewrites a model's standalone level.
- **`tab`** on the Fusion row cycles focus: effort → lead → sidekick
  (`shift+tab` reverses). Focused columns open an inline dropdown over the
  preset lists; `Enter` applies, `esc` collapses.
- **Confirm** applies: `pi.setModel`, `pi.setThinkingLevel(effort)`, updates
  MRU + persisted active selection, and shows `Fusion · Lead ◆ Sidekick` in
  the footer. Switching the model through pi's own `/model`/Ctrl+P drops
  Fusion mode automatically.
- Because pi intercepts `/model` inside its editor before extensions run, the
  command cannot be replaced — instead typing `/model` pins `/unipi:model`
  as the **first autocomplete suggestion**.

## `/unipi:fusion-preset` — curation

Two-column checklist over every available model:

```
╭ Fusion preset ───────────────────────────────────────────────────────╮
│Fusion preset · 2 lead · 2 sidekick · writes to global                │
│Search: (type to filter)                                               │
│    L   S    model                                                     │
│ › [x] [ ]  omniroute/antigravity/claude-opus-4-6-thinking            │
│   [ ] [x]  omniroute/zai/glm-5.3-flash   (default sidekick)          │
│↑↓ move · ←→ column · space toggle lead · ↵ default lead · ^Y save …  │
╰──────────────────────────────────────────────────────────────────────╯
```

- `←`/`→` (or `tab`) switches the L/S column, `space` toggles membership,
  `Enter` saves & closes, `esc` cancels, typing filters. Selected models float
  to the top so the curated set is always visible.
- Defaults are not edited here: confirming a Fusion pair in `/unipi:model`
  records it as the preset default.

## Storage

```jsonc
// ~/.unipi/config/fusion/preset.json (global)
// <cwd>/.unipi/fusion-preset.json    (project override; lists replace, effort merges)
{
  "schema_version": 1,
  "lead": ["omniroute/antigravity/claude-opus-4-6-thinking"],
  "sidekick": ["omniroute/zai/glm-5.3-flash"],
  "default": { "lead": "...", "sidekick": "..." },
  "effort": { "omniroute/zai/glm-5.3-flash": "high" },
  "recent": ["..."],
  "active": { "kind": "fusion", "lead": "...", "sidekick": "..." }
}
```

Any model key in the registry is allowed — there is no OAuth/subscription gate.

## Status

- [x] Preset store (global + project layers), picker, curation UI, autocomplete boost
- [ ] Local Fusion runtime: persistent `sidekick` child agent (lead+sidekick
      architecture: one long-lived child pi with its own context, `sidekick`
      tool with blocking/non-blocking dispatch, interrupt injection, delegate-
      by-default lead policy, savings estimate)

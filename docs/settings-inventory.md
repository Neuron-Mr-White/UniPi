# Settings inventory — every settings surface across all modules (2026-09-22)

UPDATED (phase C): all legacy /unipi:*-settings overlays are DELETED —
/unipi:settings is the single settings surface. Remaining bespoke overlays are
interactive wizards/tools (setup flows, task manager, help), not settings.

Source of truth for the /unipi:settings hub. Engine = core settings engine
(`~/.unipi/config/<ns>/config.json` global, `<cwd>/.unipi/config/<ns>/config.json` project).

Legend: ✅ adopted · 🔶 adopted partial (depth remains) · ❌ not yet · ➖ N/A

| Module | Namespace | Storage today | Status | Remaining plan |
|---|---|---|---|---|
| long-horizon | `long-horizon` | engine file | ✅ | — |
| footer | `footer` | engine file | ✅ | dynamic Segments page + separator/zoneSeparator enums (overlay deleted) |
| compactor | `compactor` | engine file | ✅ | strategy mode enums, Auto, Pipeline, preset action rows (overlay deleted) |
| ask-user | `ask-user` | engine file (was pi-settings unipi.askUser) | ✅ | — |
| notify | `notify` | engine file | ✅ | Events page (multiselect platforms), defaultPlatforms/silence/renotify, platform Setup+test actions (overlay deleted) |
| notify-ntfy | (folded into `notify`) | ~~`notify/ntfy.json`~~ → notify config.json `ntfy` subtree | ✅ | imported once per scope; schema: enabled/serverUrl/priority; saveNtfyConfig → engine |
| autocomplete | `command-enchantment` | engine file (was same path) | ✅ | — |
| utility | `utility` | engine file, project-scope | ✅ | skills.mode judged/all/off (jev-judged exposure, pi-settings flag migrated); badge side-effect wired via hub onChanged |
| info-screen | `info-screen` | engine file (A_KEY import of pi-settings unipi.info) | ✅ | dynamic Groups & stats page + Group order `order` field (overlay deleted) |
| image | `image` | `~/.unipi/config/image/config.json` | ✅ | generate.model presets, recognize capability image-input + systemPrompt (overlay deleted) |
| web-api | `web-api` | `~/.unipi/config/web-api/` | ✅ | provider pages, browser/os/includeReplies enums added (overlay deleted) |
| updater | `updater` | `~/.unipi/config/updater/config.json` | ✅ | interval + autoUpdate enums (overlay deleted) |
| memory | `memory` | engine file (legacy ~/.unipi/memory/config.json imported once) | ✅ | provider none/inherit/openrouter/custom, presetsByProvider, baseUrl, reembed action (settings-tui deleted) |
| input-shortcuts | `input-shortcuts` | engine file, project (legacy file imported once) | ✅ | chordKey/tabInsertKey enums + hint + keybinding validator (overlay deleted) |
| subagents | `subagents` | `~/.unipi/config/subagents.json` g + `<cwd>/.unipi/config/subagents.json` p | ❌ | register + route; maxConcurrent (number), enabled, types.explore/work toggles |
| background-tasks | `background-tasks` | engine files g+p | ✅ | maxOutputBytes added (overlay deleted) |
| mcp | — | `<cwd>/.unipi/config/mcp/` | ➖ | SKIPPED by design: the config is a server REGISTRY (content/state), not settings — hub has no mcp fields (see settings-vs-state distinction) |
| fusion | `fusion` | preset files (arrays/effort/recent/prices) + engine overlay | ✅ | hub edits the DEFAULT PAIR via model pickers (engine layer wins on load); curated lists stay with /unipi:fusion preset action |
| watchdog | `watchdog` | engine file | ✅ | jev judges long-running tool calls; kills or warns |
| btw | — | none found | ➖ | stateless |
| workflow | — | none found | ➖ | deprecated path (v3-tasks) |
| kanboard | — | none found | ➖ | full rewrite pending (v3-tasks) |

## Hidden-surface notes (found during audit)
1. `notify/ntfy.json` is a SECOND file beside config.json — engine holds one file per
   namespace, so ntfy folds into `notify` config.json via one-time import.
2. `info-screen` pi-settings block is imported by the A_KEY migration (engine-only since phase C).
3. `memory` keeps config under `~/.unipi/memory/` (its own root, NOT config/).
4. `input-shortcuts` splits registers (state, stays) from config (settings, hub).
5. `subagents/index.ts:792` references a legacy `badge.json` — duplicate of utility's
   legacy migration; harmless, gone once both read the engine.
6. `updater`/`image`/`web-api` already write the canonical engine paths — registration is
   a pure code-path swap, no data migration.
7. Env-var settings (TYPESAFE_API_KEY / OPENROUTER_API_KEY) remain env-tier — the hub's
   stored keys (judge.apiKey, web-api provider keys) win over env by design.

## Shipped field types
- `model` (capability-filtered, presets, providerKey, emptyOption, custom…): judge.model,
  verifierModel, badge.generationModel, image generate/recognize, notify recap.model,
  memory embedding.model, fusion lead/sidekick.
- `multiselect` (checkbox list): notify defaultPlatforms, event platforms, silence platforms.
- `order` (reorder editor): info-screen groupOrder.
- `action` rows: compactor presets, notify setup wizards + test, memory re-embed.
- `secret` fields: judge.apiKey, web-api provider apiKeys, notify gotify/telegram/ntfy
  tokens, memory apiKey.

# Settings inventory — every settings surface across all modules (2026-09-22)

Source of truth for the /unipi:settings hub. Engine = core settings engine
(`~/.unipi/config/<ns>/config.json` global, `<cwd>/.unipi/config/<ns>/config.json` project).

Legend: ✅ adopted · 🔶 adopted partial (depth remains) · ❌ not yet · ➖ N/A

| Module | Namespace | Storage today | Status | Remaining plan |
|---|---|---|---|---|
| long-horizon | `long-horizon` | engine file | ✅ | judge.model + verifierModel → `model` type |
| footer | `footer` | engine file (was pi-settings unipi.footer) | 🔶 | add separator enum, zone separator, groups show toggles |
| compactor | `compactor` | engine file (paths already canonical) | 🔶 | strategy `mode` enums, pipeline opts |
| ask-user | `ask-user` | engine file (was pi-settings unipi.askUser) | ✅ | — |
| notify | `notify` | engine file (was same path) | 🔶 | gotify url/token/priority, telegram token+chatId, event matrix, recap |
| notify-ntfy | (fold into `notify`) | **2nd file** `notify/ntfy.json` g+p | ❌ | one-time import into notify config.json; fields: enabled, serverUrl, priority, topic, token(secret) |
| autocomplete | `command-enchantment` | engine file (was same path) | ✅ | — |
| utility | `utility` | engine file, project-scope (was `<cwd>/.unipi/config/util-settings.json`) | ✅ | badge.generationModel → `model` type; skill-discovery toggle (pi-settings) |
| info-screen | `info-screen` | **pi-settings `unipi.info`** | ❌ | register + A_KEY-style import; bootMode enum, group toggles |
| image | `image` | `~/.unipi/config/image/config.json` (canonical already) | ❌ | register + route; generate.enabled/model(`model`)/outputDir, recognize model + prompts |
| web-api | `web-api` | `~/.unipi/config/web-api/` (canonical) | ❌ | register + route; per-provider enabled + apiKey (secret), defaults (browser os enum, maxChars, timeout, batchConcurrency) |
| updater | `updater` | `~/.unipi/config/updater/config.json` (canonical) | ❌ | register + route; checkInterval enum (30min/1h/6h/1d), autoUpdate enum |
| memory | `memory` | **own root** `~/.unipi/memory/config.json` | ❌ | register ns `memory` + one-time import; embedding provider enum, model(`model`), apiKey(secret), dimensions, mempalaceAutoUpdate |
| input-shortcuts | `input-shortcuts` | `<cwd>/.unipi/config/input-shortcuts-config.json` (project) | ❌ | register (project-primary) + legacy import; chordKey, tabInsertKey (allowCustom enums of key names) |
| subagents | `subagents` | `~/.unipi/config/subagents.json` g + `<cwd>/.unipi/config/subagents.json` p | ❌ | register + route; maxConcurrent (number), enabled, types.explore/work toggles |
| background-tasks | `background-tasks` | `background-tasks.json` g+p (flat in config/) | ❌ | register + route; enabled, notifyOnCompletion, triggerOnCompletion, defaultTimeoutSeconds |
| mcp | `mcp` | `<cwd>/.unipi/config/mcp/` (manager) | ❌ | register main toggles (defer server list — content, not settings) |
| fusion | `fusion` | `~/.unipi/config/fusion/preset.json` + project `<cwd>/.unipi/fusion-preset.json` | ❌ | register + route; lead/sidekick lists → `model` picker fields, default pair, prices (defer) |
| btw | — | none found | ➖ | stateless |
| workflow | — | none found | ➖ | deprecated path (v3-tasks) |
| kanboard | — | none found | ➖ | full rewrite pending (v3-tasks) |

## Hidden-surface notes (found during audit)
1. `notify/ntfy.json` is a SECOND file beside config.json — engine holds one file per
   namespace, so ntfy folds into `notify` config.json via one-time import.
2. `info-screen` still reads pi-settings (`unipi.info`) — same pattern footer/ask-user had.
3. `memory` keeps config under `~/.unipi/memory/` (its own root, NOT config/).
4. `input-shortcuts` splits registers (state, stays) from config (settings, hub).
5. `subagents/index.ts:792` references a legacy `badge.json` — duplicate of utility's
   legacy migration; harmless, gone once both read the engine.
6. `updater`/`image`/`web-api` already write the canonical engine paths — registration is
   a pure code-path swap, no data migration.
7. Env-var settings (TYPESAFE_API_KEY / OPENROUTER_API_KEY) remain env-tier — the hub's
   stored keys (judge.apiKey, web-api provider keys) win over env by design.

## Field-type plan for the new UX
- `model` type (searchable 5-row picker): judge.model, judge.verifierModel,
  badge.generationModel, image.generate.model, image.recognize.model,
  memory embedding.model, fusion lead/sidekick entries.
- `allowCustom` enums: input-shortcuts key names, notify event platforms (free text).
- `secret` fields: judge.apiKey, web-api provider apiKeys, notify gotify/telegram/ntfy
  tokens, memory apiKey.

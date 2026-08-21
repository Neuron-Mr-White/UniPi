# @pi-unipi/compactor

Deterministic context management for Pi/UniPi. The compactor keeps long coding sessions usable by replacing large conversation history with a structured, zero-LLM summary, while preserving session recall, continuity snapshots, stats, sandbox helpers, and safer tool display.

## What it does

- **Zero-LLM compaction:** Pi asks for compaction; UniPi builds the summary locally instead of spending model tokens on a summarization call.
- **Session continuity:** important goals, changed files, commits, blockers, preferences, and a recent transcript survive compaction.
- **Optional percentage trigger:** UniPi can compact at a configured context percentage before Pi's fixed reserve-token safety net fires.
- **Recall:** agents can search the append-only session branch, including messages that no longer fit in live LLM context.
- **Runtime helpers:** sandbox execution, context budget checks, diagnostics, and stats.
- **Display guards:** tool output/diff rendering is clamped and summarized to avoid noisy or terminal-breaking output.

The compaction pipeline is deterministic and runs locally. It does not call an LLM during compaction.

---

## Quick start

```text
/unipi:compact-settings
```

1. Choose a preset in **Presets**.
2. Optionally enable **Auto → Percentage Trigger**.
3. Press **Enter** to save.
4. Use `/unipi:lossless-compact` when you want to compact immediately.

Config files:

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.unipi/config/compactor/config.json` | Used by default |
| Per project | `<project>/.unipi/config/compactor.json` | Enabled from settings with **Project Override** |

Per-project config is merged over global config when the current project directory is known.

---

## User-facing slash commands

| Command | What it does | Notes |
|---|---|---|
| `/unipi:lossless-compact` | Immediately calls Pi compaction with UniPi's zero-LLM sentinel. | Main manual compaction command. |
| `/unipi:compact` | Deprecated alias for `/unipi:lossless-compact`. | Kept for backward compatibility. |
| `/unipi:session-recall <query>` | Searches current session history with BM25/regex recall. | Uses the append-only session branch when available, so pre-compaction messages can still be found. |
| `/unipi:compact-recall <query>` | Deprecated alias for `/unipi:session-recall`. | Kept for backward compatibility. |
| `/unipi:compact-stats` | Shows session events, compaction count, token savings, sandbox runs, and search counts. | Stats are DB-backed with runtime fallbacks. |
| `/unipi:compact-doctor` | Runs diagnostics for config, SQLite/session DB, and runtimes. | Useful when stats/recall/sandbox look broken. |
| `/unipi:compact-settings` | Opens the TUI settings overlay. | Tabs: Presets, Strategies, Auto, Pipeline. |
| `/unipi:compact-preset <name>` | Applies a preset globally. | Names: `precise`, `balanced`, `thorough`, `lean`. Old names map to new ones: `opencode→precise`, `verbose→thorough`, `minimal→lean`. |
| `/unipi:compact-help` | Shows compact help inside Pi. | Quick command reference. |

Content/project indexing is not part of this package. Use `read`/`bash` (rg) for project search.

---

## User-facing settings

Open settings with `/unipi:compact-settings`.

Keyboard:

| Key | Action |
|---|---|
| `Tab` | Switch tabs |
| `↑/↓` | Move selection |
| `Space` | Cycle/toggle selected value |
| `/` | Search inside the Strategies tab |
| `Enter` | Save and close |
| `Esc` | Cancel |

### Presets tab

Presets are profiles that set strategies, the implemented Auto Injection pipeline behavior, and sandbox mode.

| Preset | Intended use | Important effects |
|---|---|---|
| `precise` | Code-heavy work, minimal waste | Full compaction sections, sandbox enabled, Auto Injection off. |
| `balanced` | Daily/default profile | Compact transcript, sandbox enabled, Auto Injection on. |
| `thorough` | Debug/audit sessions | Full transcript, sandbox enabled, Auto Injection on. |
| `lean` | Quick fixes or short sessions | Brief/minimal compaction sections, no sandbox, no session continuity, Auto Injection off. |

The **Project Override** row controls where settings are saved:

- `disabled` → save global config.
- `enabled` → save `<project>/.unipi/config/compactor.json` for only this project.

### Strategies tab

These settings control what is extracted into compaction summaries or how related compactor features behave.

| Setting | Values | Meaning |
|---|---|---|
| `Verbose Debug` | `on`, `off` | Enables internal debug state. Console debug output is intentionally muted to avoid TUI rendering issues. |
| `Session Goals` | `full`, `brief`, `off` | Extracts the user's active goals/request history into `[Session Goal]`. |
| `Files & Changes` | `all`, `modified-only`, `off` | Tracks read, created, edited, and written files in `[Files And Changes]`. |
| `Commits` | `full`, `brief`, `off` | Captures git commit hashes/messages detected in the conversation. |
| `Outstanding Context` | `full`, `critical-only`, `off` | Keeps blockers, TODOs, pending decisions, and follow-ups. |
| `User Preferences` | `all`, `recent-only`, `off` | Preserves user preferences learned during the session. |
| `Brief Transcript` | `full`, `compact`, `minimal`, `off` | Keeps a rolling recent transcript after the structured sections. |
| `Session Continuity` | `full`, `off` | Controls XML-style resume snapshots. Off prevents snapshot creation and injection; Pi’s normal compaction summary still remains. |
| `Sandbox Execution` | `all`, `off` | Controls sandbox tool registration. Changes require a session reload. Allowed languages and output limit are enforced from config. |

Config-only legacy field: `fts5Index` remains in the schema for compatibility. It is hidden from Compactor settings and presets. Legacy `sessionContinuity.mode: "essential-only"`, `eventCategories`, and `sandboxExecution.mode: "safe-only"` values remain loadable; essential-only behaves as full and safe-only behaves as enabled/all until explicit filtering/security policies are designed. Legacy `toolDisplay` and `showTruncationHints` fields also remain loadable but are deprecated and ignored; their profile names were never mapped to runtime renderer modes. Narrow-terminal diff clamping remains active as independent safety behavior.

### Auto tab

These settings control UniPi-managed percentage auto-compaction. They are separate from Pi core's own `compaction.reserveTokens` behavior.

**Prefix-cache policy:** every compaction replaces provider-visible history and starts a new cache epoch. UniPi therefore keeps this second percentage trigger **off by default** and does not compact repeatedly merely to shorten a cache-hit request. Pi core remains the default safety trigger: with its documented defaults it compacts when estimated context exceeds `contextWindow - 16,384` reserved response tokens, while keeping about 20,000 recent tokens. If you deliberately enable the UniPi percentage trigger, 80% is an earlier explicit boundary and the cooldown/growth guards prevent loops. UniPi's compiler is deterministic and zero-LLM; it does not issue a second summarizer request.

| Setting | Default | Meaning |
|---|---:|---|
| `Percentage Trigger` | `off` | When on, UniPi checks context usage at `turn_end` and can call compaction when the threshold is reached. Disabled by default for backward compatibility. |
| `Threshold` | `80%` | Trigger point using Pi's live `ctx.getContextUsage().percent`. |
| `Cooldown` | `60s` | Minimum time between UniPi-triggered compaction attempts. Prevents loops. |
| `Repeat Growth` | `4k` | If usage is still above threshold after compaction, require this many new tokens before triggering again. |
| `Notifications` | `on` | Shows user-visible notifications for UniPi-triggered compaction attempts/results. |

Example config:

```json
{
  "autoCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "cooldownMs": 60000,
    "repeatMinGrowthTokens": 4000,
    "notify": true
  }
}
```

### Pipeline tab

The Pipeline tab exposes only behavior implemented by the current runtime.

| Setting | Preset behavior | Current effect |
|---|---|---|
| `Auto Injection` | On in `balanced`, `thorough`; off in `precise`, `lean` | Adds behavioral/session state to the one-shot resume context after compaction. |

Deprecated config-only compatibility fields are still accepted so existing files load without migration failures, but they are ignored and no longer controlled or advertised by presets: `ttlCache`, `mmapPragma`, `proximityReranking`, `timelineSort`, and `progressiveThrottling`.

Other config-only pipeline field:

| Field | Meaning |
|---|---|
| `customNoisePatterns` | Extra regex/string patterns used by session recall filtering to remove noisy user blocks. |

---

## What the agent gets

### Agent tools

The extension registers tools during `session_start` after the session DB is initialized.

| Tool | Purpose |
|---|---|
| `compact` | Agent-facing compaction request; supports `dryRun: true` preview. Slash command `/unipi:lossless-compact` is the user-facing immediate compaction path. |
| `session_recall` | Search current session history with BM25 or regex. Defaults to 10 hits, hard-caps pages at 50, and caps expanded hit text at 16 KiB. |
| `vcc_recall` | Deprecated alias for `session_recall`. |
| `sandbox` | Run code in a sandboxed environment. Languages: JavaScript, TypeScript, Python, shell, Ruby, Go, Rust, PHP, Perl, R, Elixir. |
| `sandbox_file` | Execute a file with its content injected as `FILE_CONTENT`. |
| `sandbox_batch` | Run multiple sandbox execution items in one atomic response. |
| `ctx_execute` | Deprecated alias for `sandbox`. |
| `ctx_execute_file` | Deprecated alias for `sandbox_file`. |
| `ctx_batch_execute` | Deprecated alias for `sandbox_batch`. |
| `compactor_stats` | Agent-readable stats dashboard. |
| `ctx_stats` | Deprecated alias for `compactor_stats`. |
| `compactor_doctor` | Agent-readable diagnostics. |
| `ctx_doctor` | Deprecated alias for `compactor_doctor`. |
| `context_budget` | Uses live Pi context usage when available and returns compaction guidance. |

### Agent skills

| Skill | Purpose |
|---|---|
| `compactor` | Small always-loadable routing skill: when to compact, recall, check budget, or use sandbox. |
| `compactor-detail` | On-demand full tool reference and workflow guidance. |
| `compactor-stats` | Help interpreting compactor stats. |
| `compactor-doctor` | Help diagnosing config/DB/runtime issues. |

---

## How the system works

### Chronological hook flow

Typical session order:

1. **Extension load**
   - Registers compaction hooks immediately with lazy dependencies.
   - Creates in-memory runtime counters/state.

2. **`session_start`**
   - Scaffolds config if needed.
   - Initializes `SessionDB` and sandbox executor.
   - Computes the current session ID, including worktree suffix.
   - Registers agent tools and slash commands.
   - Registers the info-screen Compactor group.
   - Emits UniPi `MODULE_READY`.

3. **`before_agent_start`**
   - Reloads config for the active project.
   - Applies runtime `autoDetect` behavior, such as disabling commit extraction outside git repos.
   - Rebuilds cached recall blocks from Pi's append-only session branch.
   - If a resume snapshot exists from a prior compaction, injects it into session context and marks it consumed.

4. **`input`**
   - Performs advisory security checks for shell/network/file patterns.
   - Can block some known-dangerous network shell commands.

5. **Tool execution → `tool_result`**
   - Extracts file/change/search/sandbox events into the session DB.
   - Updates runtime byte/tool counters.
   - Applies display overrides and width-safe diff clamping before output reaches the TUI.

6. **`turn_end`**
   - If percentage auto-compaction is enabled, reads `ctx.getContextUsage()`.
   - Runs cooldown/repeat-growth safeguards.
   - Calls `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION })` when eligible.

7. **Pi decides to compact**
   - This can be from `/unipi:lossless-compact`, UniPi percentage auto-compaction, or Pi core's reserve-token fallback.

8. **`session_before_compact`**
   - Pi provides `preparation`, `branchEntries`, and optional custom instructions.
   - If compactor should handle it, UniPi:
     1. chooses the safe cut point (`buildOwnCut`),
     2. converts messages to LLM-like input,
     3. runs the zero-LLM compile pipeline,
     4. persists stats/snapshots,
     5. returns `{ compaction: { summary, details, tokensBefore, firstKeptEntryId } }` to Pi.

9. **`session_compact`**
   - Pi commits the compaction entry.
   - UniPi increments compaction counters and persists token/character savings.

10. **Next `before_agent_start` after compaction**
    - UniPi injects the resume snapshot so the agent gets continuity without needing the full old transcript in context.

11. **`session_shutdown`**
    - Cleans old sessions.
    - Cleans sandbox/background processes.
    - Closes DB handles.

### Zero-LLM compile pipeline

When UniPi handles `session_before_compact`, it transforms old messages through these deterministic stages:

1. **Normalize** — flatten user/assistant/tool/thinking messages into normalized blocks.
2. **Filter** — remove noise and apply `customNoisePatterns`.
3. **Build sections** — extract goals, files, commits, outstanding context, preferences, and transcript entries.
4. **Brief** — cap and condense transcript lines.
5. **Format** — emit a structured markdown summary.
6. **Merge** — merge with the previous summary when Pi provides one.

The resulting summary is optimized for continuity, not for perfect archival fidelity. Use `session_recall` when the agent needs details from the raw session branch. Recall is deliberately paginated: request another offset page or narrow the query instead of injecting an unbounded result set. Even with `expand: true`, each hit is capped at 16 KiB to prevent a single historical message or tool result from dominating future cold-cache requests.

---

## Benchmarks

Synthetic compile-only benchmark, run on this repository with Node 24 using `compile()` directly. Token counts use the common `chars / 4` estimate. Real compaction also keeps a recent live tail, so final live-context size can be larger than the summary-only number below.

| Synthetic session | Input chars | Approx input tokens | Summary chars | Approx summary tokens | Reduction | Compile time |
|---:|---:|---:|---:|---:|---:|---:|
| 100 turns / 400 messages | 356,913 | 89,228 | 36,451 | 9,113 | 89.8% | 12.5 ms |
| 250 turns / 1,000 messages | 894,063 | 223,516 | 36,585 | 9,146 | 95.9% | 16.6 ms |
| 500 turns / 2,000 messages | 1,789,313 | 447,328 | 36,605 | 9,151 | 98.0% | 35.8 ms |

Practical interpretation:

- Larger sessions compress better because the structured summary has fixed caps.
- Runtime is local and usually small relative to model/tool latency.
- Actual savings reported to users should come from `/unipi:compact-stats`, because Pi supplies real `tokensBefore` during compaction when available.

---

## Troubleshooting

### "Whatever preset I choose, Pipeline is always off"

That means preset application is not updating `config.pipeline`. The intended behavior is:

- `precise`: Auto Injection off.
- `balanced`: Auto Injection on.
- `thorough`: Auto Injection on.
- `lean`: Auto Injection off.

The five deprecated compatibility fields remain off in every preset.

Make sure you are running a version with the preset pipeline fix, select the preset, and press **Enter** to save.

### "Compaction did not happen"

- For immediate user-triggered compaction, use `/unipi:lossless-compact`.
- For automatic percentage compaction, enable **Auto → Percentage Trigger**.
- Pi core still has its own reserve-token fallback; UniPi's percentage trigger is optional and disabled by default.

### "Stats show zero"

- Stats only increase after compaction or after tracked sandbox/search events.
- Run `/unipi:compact-doctor` to check DB/config health.
- Long sessions may show all-time DB fallbacks if current in-memory counters are zero.

### "Recall cannot find something"

- Use specific terms with `/unipi:session-recall <query>`.
- The recall path prefers Pi's append-only branch and falls back to cached normalized blocks.
- Extra noise filtering can be added with `pipeline.customNoisePatterns`.

## License

MIT

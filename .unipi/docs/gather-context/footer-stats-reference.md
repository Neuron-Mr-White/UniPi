# Footer Stats Reference — Complete Segment Inventory

> **Purpose:** All 37 footer segments with icons (3 styles), function descriptions, and customization slots.
> **Gathered:** 2026-05-01
> **Updated:** 2026-05-01 — Restructured: removed thinking/path/session/hostname/time, added api_state/tool_count
> **Source:** `packages/footer/src/segments/*.ts` + `packages/footer/src/rendering/icons.ts`

---

## CORE GROUP (`core.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 1 | `model` | Model | `󰚩` | 🤖 | `MDL` | Shows active model name. Strips "Claude " prefix. Reads `piContext.model.name/id`. |
| 2 | `api_state` | API State | `󱂛` | 🔄 | `API` | Shows API connection status. TODO: Connect to actual API state when pi exposes it. |
| 3 | `tool_count` | Tool Count | `` | 🔧 | `TLS` | Shows number of active tools. TODO: Connect to actual tool count when pi exposes it. |
| 4 | `git` | Git | ` ` | ⎇ | `GIT` | Current git branch from `footerData.getGitBranch()`. Hidden if no branch. |
| 5 | `context_pct` | Context % | ` ` | 🗄️ | `CTX` | Context usage `XX.X%/XXXk`. Color: normal→warn(>70%)→error(>90%). `?%` post-compaction. |
| 6 | `cost` | Cost | ` ` | 💲 | `CST` | Session cost `$X.XX` or `(sub)` for subscription. Sums `usage.cost.total` from events. |
| 7 | `tokens_total` | Tokens Total | ` ` | ⊛ | `TOK` | Total tokens (in+out+cache). **Hidden by default.** |
| 8 | `tokens_in` | Tokens In | ` ` | → | `TKI` | Input tokens only. **Hidden by default.** |
| 9 | `tokens_out` | Tokens Out | ` ` | ← | `TKO` | Output tokens only. **Hidden by default.** |

---

## COMPACTOR GROUP (`compactor.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 10 | `session_events` | Session Events | `󰲏` | ⚡ | `EVT` | Count of session events from `sessionManager.getBranch()`. Hidden if zero. |
| 11 | `compactions` | Compactions | `󰲏` | ◧ | `CMP` | Count of compaction/compacted events. Hidden if zero. |
| 12 | `tokens_saved` | Tokens Saved | ` ` | 💲 | `SVD` | Sum of `tokensSaved` from compaction events. Hidden if zero. |
| 13 | `compression_ratio` | Compression Ratio | `󰲏` | ⇄ | `RAT` | Last compaction ratio `X.Xx`. Hidden if no ratio. |
| 14 | `indexed_docs` | Indexed Docs | `󰈙` | ☰ | `IDX` | ⚠️ **No data source — always hidden.** Placeholder for future. |
| 15 | `sandbox_runs` | Sandbox Runs | ` ` | ▶ | `SBX` | ⚠️ **No data source — always hidden.** Placeholder for future. |
| 16 | `search_queries` | Search Queries | ` ` | ⊗ | `QRY` | ⚠️ **No data source — always hidden.** Placeholder for future. |

---

## KANBOARD GROUP (`kanboard.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 17 | `docs_count` | Docs Count | `󰈙` | ☰ | `DOC` | Kanboard docs count from `globalThis.__unipi_kanboard_registry.docsCount`. |
| 18 | `tasks_done` | Tasks Done | `` | ✓ | `DNE` | Completed tasks count from registry. |
| 19 | `tasks_total` | Tasks Total | `` | ☐ | `TSK` | Total tasks count from registry. |
| 20 | `task_pct` | Task % | `` | % | `PCT` | Task completion `XX%` (done/total). Hidden if missing data. |

---

## MCP GROUP (`mcp.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 21 | `servers_total` | Servers Total | ` ` | 🖥️ | `SRV` | Total MCP servers from `globalThis.__unipi_mcp_stats.serversTotal`. |
| 22 | `servers_active` | Servers Active | ` ` | ● | `ACT` | Active MCP servers count. |
| 23 | `tools_total` | Tools Total | ` ` | 🔧 | `TLS` | Total MCP tools count. |
| 24 | `servers_failed` | Servers Failed | ` ` | ⚠️ | `ERR` | Failed servers count. Hidden if zero. |

---

## MEMORY GROUP (`memory.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 25 | `project_count` | Project Count | `󰍚` | 🧠 | `mem` | Memory count. Combined `N/M` format when both project+total available. From `__unipi_info_registry`. |
| 26 | `total_count` | Total Count | `` | 🧠 | `MEM` | Total memory count. Usually hidden when project_count shows combined format. |
| 27 | `consolidations` | Consolidations | `󰍚` | 🧠 | `CNS` | Consolidation count `cns:N`. From info registry or event cache. **Hidden by default.** |

---

## NOTIFY GROUP (`notify.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 28 | `platforms_enabled` | Platforms | ` ` | ♮ | `NTF` | Comma-separated notification platforms from event cache. |
| 29 | `last_sent` | Last Sent | ` ` | ⏱ | `LST` | Relative time since last notification ("just now", "Nm ago", "Nh ago"). |

---

## RALPH GROUP (`ralph.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 30 | `active_loops` | Active Loops | `󰼉` | 🔁 | `LPS` | Loop status with green/red dot. Active: iteration stats (e.g. `3/50`). Off: red dot. |
| 31 | `total_iterations` | Total Iterations | `󰼉` | 🔁 | `ITR` | Iteration count with dot. `N/M` if maxIterations known, else `N`. |
| 32 | `loop_status` | Loop Status | `󰼉` | 🔁 | `STS` | Status icon (▶/⏸/✓) + loop name. Green for active/completed, red otherwise. |

---

## WORKFLOW GROUP (`workflow.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 33 | `current_command` | Current Command | ` ` | ▶️ | `CMD` | Active workflow command. ▶=active, ✓=done. Color varies by type (brainstorm/plan/work/review/auto). Shows `-` when none. |
| 34 | `sandbox_level` | Sandbox Level | `󰟾` | 🔒 | `SBX` | "sandbox" or "full" indicator. **Hidden by default.** |
| 35 | `command_duration` | Command Duration | `󱎫` | ⏱ | `DUR` | Elapsed time `XhXm`/`XmXs`/`Xs`. Reads from workflow event cache. |

---

## STATUS EXTENSION (`status-ext.ts`)

| # | Segment ID | Label | Nerd Font | Emoji | Text | Function |
|---|-----------|-------|-----------|-------|------|----------|
| 36 | `extension_statuses` | Extensions | `󱖫` | ▦ | `EXT` | Aggregates all extension status entries. Maps to short names: wf/rl/mem/cmp/mcp/ntf/kb. Clamped to terminal width. |

---

## Summary

- **Total segments:** 37 (down from 39)
- **Groups:** 9 (core, compactor, kanboard, mcp, memory, notify, ralph, workflow, status-ext)
- **Icon styles:** 3 (nerd font, emoji, text)
- **Segments with no data source:** 3 (indexed_docs, sandbox_runs, search_queries) + 2 stubs (api_state, tool_count)
- **Removed segments:** thinking, path, session, hostname, time
- **New segments:** api_state, tool_count

## Changes Made (2026-05-01)

### Removed
- `thinking` — Thinking level display (min/low/med/high/xhigh)
- `path` — Current working directory
- `session` — Session ID (first 8 chars)
- `hostname` — Machine hostname
- `time` — Current time (H:MM)

### Added
- `api_state` — API connection status (stub, needs data source)
- `tool_count` — Number of active tools (stub, needs data source)

### Icon Updates
All 3 icon sets (Nerd Font, Emoji, Text) updated to match user specifications in the filled reference table.

---
name: footer-icons-restructure
status: completed
workbranch: ""
created: 2026-05-01
specs:
  - .unipi/docs/gather-context/footer-stats-reference.md
---

# Footer Icons Restructure Plan

## Overview

Restructure the footer segment system based on the filled-in reference table. This involves:
- Adding new segments (`api_state`, `tool_count`)
- Removing existing segments (`thinking`, `path`, `session`, `hostname`, `time`)
- Updating all 3 icon sets (Nerd Font, Emoji, Text) for remaining segments
- Updating segment display labels

## Scope Analysis

### Segments to ADD
| Segment ID | Label | Nerd Font | Emoji | Text |
|-----------|-------|-----------|-------|------|
| `api_state` | API State | `󱂛` | 🔄 | API |
| `tool_count` | Tool Count | `` | 🔧 | TLS |

### Segments to REMOVE
| Segment ID | Current Label |
|-----------|---------------|
| `thinking` | Thinking |
| `path` | Path |
| `session` | Session |
| `hostname` | Hostname |
| `time` | Time |

### Segments to UPDATE (icons + labels)
| Segment ID | New Label | New Nerd | New Emoji | New Text |
|-----------|-----------|----------|-----------|----------|
| `model` | Model | `󰚩` | 🤖 | MDL |
| `git` | Git | ` ` | ⎇ | GIT |
| `context_pct` | Context % | ` ` | 🗄️ | CTX |
| `cost` | Cost | ` ` | 💲 | CST |
| `tokens_total` | Tokens Total | ` ` | ⊛ | TOK |
| `tokens_in` | Tokens In | ` ` | → | TKI |
| `tokens_out` | Tokens Out | ` ` | ← | TKO |
| `session_events` | Session Events | `󰲏` | ⚡ | EVT |
| `compactions` | Compactions | `󰲏` | ◧ | CMP |
| `tokens_saved` | Tokens Saved | ` ` | 💲 | SVD |
| `compression_ratio` | Compression Ratio | `󰲏` | ⇄ | RAT |
| `indexed_docs` | Indexed Docs | `󰈙` | ☰ | IDX |
| `sandbox_runs` | Sandbox Runs | ` ` | ▶ | SBX |
| `search_queries` | Search Queries | ` ` | ⊗ | QRY |
| `docs_count` | Docs Count | `󰈙` | ☰ | DOC |
| `tasks_done` | Tasks Done | `` | ✓ | DNE |
| `tasks_total` | Tasks Total | `` | ☐ | TSK |
| `task_pct` | Task % | `` | % | PCT |
| `servers_total` | Servers Total | ` ` | 🖥️ | SRV |
| `servers_active` | Servers Active | ` ` | ● | ACT |
| `tools_total` | Tools Total | ` ` | 🔧 | TLS |
| `servers_failed` | Servers Failed | ` ` | ⚠️ | ERR |
| `project_count` | Project Count | `󰍚` | 🧠 | mem |
| `total_count` | Total Count | `` | 🧠 | MEM |
| `consolidations` | Consolidations | `󰍚` | 🧠 | CNS |
| `platforms_enabled` | Platforms | ` ` | ♮ | NTF |
| `last_sent` | Last Sent | ` ` | ⏱ | LST |
| `active_loops` | Active Loops | `󰼉` | 🔁 | LPS |
| `total_iterations` | Total Iterations | `󰼉` | 🔁 | ITR |
| `loop_status` | Loop Status | `󰼉` | 🔁 | STS |
| `current_command` | Current Command | ` ` | ▶️ | CMD |
| `sandbox_level` | Sandbox Level | `󰟾` | 🔒 | SBX |
| `command_duration` | Command Duration | `󱎫` | ⏱ | DUR |
| `extension_statuses` | Extensions | `󱖫` | ▦ | EXT |

---

## Tasks

### Task 1: Update Icon Sets in `icons.ts` [completed]
**File:** `packages/footer/src/rendering/icons.ts`

1. Update `IconSet` interface:
   - Add `apiState: string` and `toolCount: string` fields
   - Remove `thinking: string`, `path: string`, `session: string`, `hostname: string`, `time: string` fields

2. Update `NERD_ICONS`:
   - Add: `apiState: "\uf725"`, `toolCount: "\uf0ad"`
   - Remove: `thinking`, `path`, `session`, `hostname`, `time`
   - Update all icons per table above

3. Update `EMOJI_ICONS`:
   - Add: `apiState: "🔄"`, `toolCount: "🔧"`
   - Remove: `thinking`, `path`, `session`, `hostname`, `time`
   - Update all emojis per table above

4. Update `TEXT_ICONS`:
   - Add: `apiState: "API"`, `toolCount: "TLS"`
   - Remove: `thinking`, `path`, `session`, `hostname`, `time`
   - Update all text labels per table above

### Task 2: Update Core Segments in `core.ts` [completed]
**File:** `packages/footer/src/segments/core.ts`

1. Remove render functions:
   - `renderThinkingSegment`
   - `renderPathSegment`
   - `renderSessionSegment`
   - `renderHostnameSegment`
   - `renderTimeSegment`

2. Add render functions:
   - `renderApiStateSegment` — shows API connection status, color-coded by state
   - `renderToolCountSegment` — shows number of active tools, hidden if zero

3. Update `CORE_SEGMENTS` array:
   - Remove entries for `thinking`, `path`, `session`, `hostname`, `time`
   - Add entries for `api_state`, `tool_count`
   - Update all `label` values to match table

4. Clean up unused imports (`osHostname`, `basename`, `rainbowText`, `rainbowBorder`, `getThinkingLevel` if no longer used)

### Task 3: Update Label Fields in All Segment Files [completed]
**Files:** All segment files in `packages/footer/src/segments/`

Update `label` field in each segment array to match the table:
- `compactor.ts`: Update labels for all COMPACTOR_SEGMENTS
- `kanboard.ts`: Update labels for all KANBOARD_SEGMENTS
- `mcp.ts`: Update labels for all MCP_SEGMENTS
- `memory.ts`: Update labels for all MEMORY_SEGMENTS
- `notify.ts`: Update labels for all NOTIFY_SEGMENTS
- `ralph.ts`: Update labels for all RALPH_SEGMENTS
- `workflow.ts`: Update labels for all WORKFLOW_SEGMENTS
- `status-ext.ts`: Update label for STATUS_EXT_SEGMENTS

### Task 4: Update Status Display Mapping in `status-ext.ts` [completed]
**File:** `packages/footer/src/segments/status-ext.ts`

Update `STATUS_DISPLAY` segmentId references:
- Remove references to deleted segments (`thinking`, `path`, `session`, `hostname`, `time`)
- Add mappings for new segments (`apiState`, `toolCount`)

### Task 5: Verify Build and Tests [completed]
1. Run `pnpm build` in footer package
2. Run `pnpm test` in footer package
3. Fix any compilation errors from removed segments
4. Update any tests that reference deleted segments

---

## Acceptance Criteria
- [ ] All 3 icon sets (Nerd, Emoji, Text) match the filled-in table exactly
- [ ] New segments `api_state` and `tool_count` render correctly
- [ ] Removed segments (`thinking`, `path`, `session`, `hostname`, `time`) no longer exist in code
- [ ] All segment labels match the table
- [ ] Build passes with no errors
- [ ] Tests pass (or updated to match new structure)

## Notes
- The `api_state` segment needs a data source — may need to check if `footerData` exposes API state
- The `tool_count` segment needs a data source — may need to check if `footerData` exposes tool count
- Some emoji icons use actual emoji characters (🤖, 🗄️, 💲, 🧠, 🔁, 🖥️, ⚠️, 🔒, ▶️, 🔧) which may not render in all terminals

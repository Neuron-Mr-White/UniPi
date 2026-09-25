---
name: memory
description: >
  Persistent cross-session memory on a shared MemPalace palace. Store and
  retrieve user preferences, project decisions, code patterns, and summaries
  across sessions — including memories written by other tools (Devin, zcode).
allowed-tools:
  - memory_store
  - memory_search
  - memory_delete
  - memory_list
  - read
---

# Memory

Persistent cross-session memory backed by a shared MemPalace palace. The
markdown files under `~/.unipi/memory/` are the durable tier; the palace is
the searchable tier. Drawers written by other agents (Devin, zcode, diaries)
are searchable alongside pi's own — every result carries its source.

## Files

Each memory is one markdown file:

```
~/.unipi/memory/<project>/<type>/<id>.md
```

with YAML frontmatter (`id, title, tags, project, created, updated, type`)
where `type` ∈ `preference | decision | pattern | summary`, and a per-project
`mempalace.yaml` (wing + the 4 type rooms). `project` = sanitized basename of
the session's cwd — the same rule other MemPalace agents use.

## Tools

| Tool | What it does |
|------|--------------|
| `memory_store` | Write/refresh the md file and file it into the palace via the daemon |
| `memory_search` | Semantic search over the whole palace — pi + foreign drawers |
| `memory_list` | List the current project's memories |
| `memory_delete` | Remove the md and its palace drawer(s) |

`memory_search` covers **all** drawers — results are labeled
`wing › room · source` (`pi`, `devin`, `zcode`, `mempalace`, …) and chunks of
the same file are grouped into one hit. Use `scope: "project"` to restrict to
the current project's wing.

## Store outcomes

`memory_store` always writes the markdown file. The palace write is reported
honestly:

- `filed ✓` — the daemon mine job finished and the drawer exists
- `queued ⧗` — the job was accepted but didn't finish in time (it still lands)
- `markdown only ⚠` — no daemon reachable; journaled to `.pending.json` and
  replayed when a daemon appears

## Switches (`/unipi:settings` → Memory)

| Switch | Off means |
|--------|-----------|
| Recall memory at start | No first-turn reminder / titles / wake-up; search tools stay available |
| Write memory | `memory_store`/`memory_delete` inactive + no save nudge |
| Wake-up summary at start | Skip the `mempalace wake-up` text in the reminder |
| Auto-start daemon | Don't spawn `mempalace daemon start` when needed |
| MemPalace auto-update | Skip the daily PyPI check + `uv` upgrade |

`~/.config/mempalace/agent-hooks.json {enabled:false}` mutes both reminders.
`/unipi:memory status` shows backend/daemon/reader/counts/pending and
migration progress; `/unipi:memory migrate` converts v2 data after a
confirmed plan; `recall on|off` / `write on|off` are session-only.

## Naming Convention

**Format:** `<most_important>_<less_important>_<lesser>` — underscores,
specific, <60 chars (`auth_jwt_prefer_refresh_tokens`, not `auth_tokens`).

| Type | Examples |
|------|----------|
| **Preference** | `style_typescript_prefer_tabs` |
| **Decision** | `db_postgres_chosen_over_mysql` |
| **Pattern** | `api_rest_versioning_v2` |
| **Summary** | `perf_slow_query_root_cause` |

## Guardrails

- Read max 10 results per search.
- Update existing memories — the store tool detects exact titles and lists
  similar ones.
- v2 leftovers are migrated by the user-initiated `/unipi:memory migrate`
  (backups first); check progress via `/unipi:memory status`.

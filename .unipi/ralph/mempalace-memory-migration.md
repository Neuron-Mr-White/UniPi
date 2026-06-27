# Task
Plan and implement a migration path from the existing unipi memory architecture to https://github.com/mempalace/mempalace.

## Goals
- Pull/clone the mempalace repository locally for inspection.
- Deeply understand the current unipi memory storage architecture and APIs.
- Deeply understand mempalace data model, ingestion/import options, CLI/API, persistence, and operational requirements.
- Decide whether direct migration is feasible and document constraints.
- Provide a tested migration script for current memory architecture to mempalace if possible.
- Think before executing destructive or high-impact actions; do not mutate existing memories except via read-only export unless explicitly needed.

## Checklist
- [x] Inspect project layout and existing memory package/files.
- [x] Clone mempalace repository into a safe local external/vendor location.
- [x] Inspect mempalace docs, schema, CLI/API, and tests.
- [x] Locate current project memory storage files/database and schema.
- [x] Design migration mapping from unipi memories to mempalace entities.
- [x] Implement migration script in an appropriate scripts/tools location.
- [x] Test script against a temporary sample/export and, where possible, mempalace dry-run/import path.
- [x] Document usage, limitations, and next steps.
- [x] Save non-obvious findings to memory.

## Notes
- User explicitly requested use of ralph loop and careful testing before execution.
- Current working directory: /home/oi/Projects/Personal/unipi.
- Cloned MemPalace to `/tmp/mempalace` with `git clone --depth 1 https://github.com/mempalace/mempalace /tmp/mempalace`.
- Current UniPi memory architecture: `~/.unipi/memory/<project>/memory.db` plus YAML-frontmatter `*.md`; schema lives in `packages/memory/storage.ts`; valid types are `preference`, `decision`, `pattern`, `summary`.
- Current machine dry-run found 1096 UniPi memories across 14 project directories; current `unipi` project has 7 memories.
- MemPalace migration target should be drawers for verbatim text via public API `mempalace.palace.get_collection(...).upsert(...)`; KG import should be optional provenance-only unless semantic fact extraction is reviewed.
- Implemented `scripts/migrate-unipi-memory-to-mempalace.py` with dry-run default, JSONL export, staging-dir export for `mempalace mine`, direct API import via `--execute`, deterministic IDs, and optional `--kg-metadata` provenance triples.
- Documented plan and usage in `docs/mempalace-memory-migration.md`.
- Tests run: Python compile; dry-run for project `unipi`; JSONL/staging export for project `unipi`; all-project dry-run; fake local MemPalace package exercise of `--execute` and `--kg-metadata`.
- Saved memory `mempalace_memory_migration_plan` with architecture findings, migration mapping, script paths, and test summary.
- Ralph loop complete.

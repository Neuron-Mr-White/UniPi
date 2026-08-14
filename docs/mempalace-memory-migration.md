# UniPi memory → MemPalace migration

> **Status (updated 2026-08-14):** Migration is **built in, automatic, and
> resumable**. The `@pi-unipi/memory` package auto-installs MemPalace via `uv`,
> fingerprints durable SQLite/markdown sources, and runs an idempotent catch-up
> whenever those sources change. It records completion only after all discovered
> records are verified in the palace.
> The standalone `scripts/migrate-unipi-memory-to-mempalace.py` remains as a
> manual/audit tool but is no longer required for normal operation. See
> `packages/memory/README.md` → "MemPalace backend" for the runtime behavior.

This document records the migration approach from UniPi's legacy memory
system to [MemPalace](https://github.com/mempalace/mempalace), plus usage
notes for the manual migration script at
[`scripts/migrate-unipi-memory-to-mempalace.py`](../scripts/migrate-unipi-memory-to-mempalace.py)
and the built-in bridge at
[`packages/memory/bridge/mempalace_bridge.py`](../packages/memory/bridge/mempalace_bridge.py).

## Current UniPi memory architecture

UniPi stores memories under `~/.unipi/memory/<project>/`.

Each project directory contains:

- `memory.db` — SQLite database used by `packages/memory/storage.ts`.
- `*.md` — human-readable memories with YAML frontmatter.
- optional SQLite WAL/SHM files.

The SQLite schema is:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  project TEXT,
  type TEXT,
  created TEXT,
  updated TEXT,
  embedding BLOB
);
```

When `sqlite-vec` is available, UniPi also creates:

```sql
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[<configured dims>]);
```

The markdown file format is:

```markdown
---
title: auth_jwt_prefer_refresh_tokens
tags: [auth, jwt, preferences]
project: my-app
created: 2026-04-26T10:00:00Z
updated: 2026-04-26T15:30:00Z
type: preference
---

Memory body...
```

Valid UniPi memory types are `preference`, `decision`, `pattern`, and `summary`.

Important implementation details:

- `packages/memory/storage.ts` derives project names from the working directory basename.
- `memory_store` generates IDs from normalized titles.
- Markdown is treated as a recoverable human tier: `syncOrphanedFiles()` can recreate DB rows from `*.md` files.
- Search is hybrid when embeddings exist, fuzzy text otherwise.
- The memory tool's “global” behavior currently means “search/list all project directories”; there is no separate `global_memory_store` implementation in the current tool set.

## MemPalace architecture relevant to migration

MemPalace has two memory stores:

1. **Palace drawers** — verbatim documents in a pluggable backend.
   - Default backend: ChromaDB.
   - Other backends: `sqlite_exact`, `qdrant`, `pgvector`.
   - Access API: `mempalace.palace.get_collection(...).upsert(...)`.
2. **Knowledge graph** — structured temporal triples in SQLite.
   - API: `mempalace.knowledge_graph.KnowledgeGraph.add_triple(...)`.
   - Default path is `~/.mempalace/knowledge_graph.sqlite3`, while the MCP server uses `<palace>/knowledge_graph.sqlite3` when `--palace` is provided.

MemPalace does not currently provide a generic JSON/SQLite import command, so direct migration should use the public Python APIs rather than editing backend files directly.

Relevant inspected MemPalace files:

- `/tmp/mempalace/mempalace/palace.py` — collection access and backend resolution.
- `/tmp/mempalace/mempalace/backends/base.py` — backend collection contract (`add`, `upsert`, `query`, `get`, `delete`, `count`).
- `/tmp/mempalace/mempalace/miner.py` — drawer metadata conventions and ID helpers.
- `/tmp/mempalace/mempalace/ids.py` — stable drawer ID helpers.
- `/tmp/mempalace/mempalace/knowledge_graph.py` — KG schema and write API.
- `/tmp/mempalace/mempalace/mcp_server.py` — MCP tools such as `mempalace_add_drawer`, `mempalace_checkpoint`, and `mempalace_kg_add`.

## Migration mapping

The recommended default migration is **lossless drawer import**:

| UniPi field | MemPalace destination |
| --- | --- |
| `project` | `wing` by default |
| `type` | `room` as `unipi_<type>` by default |
| `title`, `tags`, `created`, `updated`, `type`, `project`, `id` | preserved in the drawer document frontmatter |
| original body | drawer document body, verbatim |
| original source | drawer metadata (`unipi_*` fields and `source_file`) |

Default metadata written by the script:

```json
{
  "wing": "<project>",
  "room": "unipi_<type>",
  "source_file": "unipi://memory/<project>/<id>",
  "chunk_index": 0,
  "added_by": "unipi-memory-migration",
  "filed_at": "<migration timestamp>",
  "content_date": "<updated or created>",
  "unipi_project": "<project>",
  "unipi_id": "<id>",
  "unipi_title": "<title>",
  "unipi_type": "<type>",
  "unipi_tags": "comma,separated,tags",
  "unipi_source_kind": "markdown|sqlite",
  "unipi_source_path": "<original file or db path>",
  "normalize_version": 2,
  "id_recipe": "unipi-migration-v1"
}
```

Drawer IDs are deterministic and derived from MemPalace's `make_drawer_id_from_chunk(wing, room, source_uri, 0)`, so repeated runs upsert the same records instead of duplicating them.

## Why KG import is optional

UniPi memories are already curated prose, not normalized triples. Automatically converting all of them to semantic graph facts would require an LLM extraction step and review, otherwise it risks creating false facts.

The script's `--kg-metadata` option only writes provenance triples such as:

- `UniPi memory <project>/<id> --belongs_to_project--> <project>`
- `UniPi memory <project>/<id> --has_type--> <type>`
- `UniPi memory <project>/<id> --has_title--> <title>`
- `UniPi memory <project>/<id> --has_tag--> <tag>`

Use drawers for the actual memory text. Add semantic KG extraction later only with human review or a dedicated LLM extraction workflow.

## Prerequisites

Install MemPalace separately. Recommended:

```bash
uv tool install mempalace
```

Or use an editable/local clone for development:

```bash
git clone https://github.com/mempalace/mempalace /tmp/mempalace
```

The script is Python 3 and uses the standard library plus PyYAML when available. PyYAML is installed in the current environment; the script also has a minimal fallback parser for simple frontmatter.

## Dry run and audit exports

Always start with dry-run:

```bash
scripts/migrate-unipi-memory-to-mempalace.py --dry-run
```

For this machine at the time of planning, the script found 1096 total memories across 14 UniPi project directories, including 7 in project `unipi`.

Export the normalized payload for review:

```bash
scripts/migrate-unipi-memory-to-mempalace.py \
  --export-jsonl /tmp/unipi-memories.jsonl \
  --dry-run
```

Build a staging tree that can be mined by the MemPalace CLI instead of direct API import:

```bash
scripts/migrate-unipi-memory-to-mempalace.py \
  --staging-dir /tmp/unipi-memory-staging \
  --dry-run

mempalace mine /tmp/unipi-memory-staging --wing unipi-migration
```

Note: CLI mining is simpler operationally but less exact: MemPalace may chunk files and source metadata points at the staging files rather than the original UniPi records. Direct API import is the preferred migration path.

## Execute migration

Import all UniPi memories into the default MemPalace palace:

```bash
scripts/migrate-unipi-memory-to-mempalace.py --execute
```

Import only one project:

```bash
scripts/migrate-unipi-memory-to-mempalace.py --project unipi --execute
```

Use a local MemPalace clone:

```bash
scripts/migrate-unipi-memory-to-mempalace.py \
  --mempalace-repo /tmp/mempalace \
  --execute
```

Use an explicit backend:

```bash
scripts/migrate-unipi-memory-to-mempalace.py \
  --backend sqlite_exact \
  --execute
```

Customize placement:

```bash
# Put all memories under one wing/room
scripts/migrate-unipi-memory-to-mempalace.py \
  --wing unipi-import \
  --room memories \
  --execute

# Prefix generated wings and use plain type rooms
scripts/migrate-unipi-memory-to-mempalace.py \
  --wing-prefix unipi_ \
  --plain-type-rooms \
  --execute
```

Optional provenance KG triples:

```bash
scripts/migrate-unipi-memory-to-mempalace.py \
  --execute \
  --kg-metadata
```

## Verification

After import, verify with MemPalace:

```bash
mempalace --palace ~/.mempalace/palace status
mempalace --palace ~/.mempalace/palace search "known memory text" --wing unipi --room unipi_summary --results 5
```

For direct API verification:

```python
from mempalace.palace import get_collection

col = get_collection("~/.mempalace/palace")
print(col.count())
print(col.get(limit=3, include=["documents", "metadatas"]))
```

## Tested during planning

The following checks were run successfully:

```bash
python3 -m py_compile scripts/migrate-unipi-memory-to-mempalace.py
scripts/migrate-unipi-memory-to-mempalace.py --project unipi --dry-run
scripts/migrate-unipi-memory-to-mempalace.py --project unipi \
  --export-jsonl /tmp/unipi-memories-test.jsonl \
  --staging-dir /tmp/unipi-memory-staging-test \
  --dry-run
scripts/migrate-unipi-memory-to-mempalace.py --dry-run
```

A fake local `mempalace` package was also used to test the `--execute` path without writing to a real MemPalace installation. That validated that the script calls `get_collection(...).upsert(...)` with the expected documents, IDs, and metadata, and that `--kg-metadata` calls `KnowledgeGraph.add_triple(...)`.

## Risks and constraints

- The script does not migrate UniPi embedding vectors. MemPalace re-embeds drawer text using its configured embedder.
- MemPalace embedder identity checks can reject writes if an existing palace was created with a different embedding model. If that happens, use MemPalace repair/`palace set-embedder` workflows intentionally rather than bypassing the check.
- Avoid running this migration concurrently with MemPalace MCP/CLI writers against the same palace.
- Default ChromaDB import may download/load local embedding model dependencies. This is MemPalace behavior, not UniPi-specific.
- `sqlite_exact` is useful for deterministic/local testing, but it still needs MemPalace's embedding wrapper and dependencies when used through `get_collection`.
- Metadata is kept scalar/string-only for backend portability.
- Direct KG semantic fact migration is intentionally not automatic.

## Rollback

The migration is additive, idempotent, and verified. It never modifies
`~/.unipi/memory`. The `.mempalace-migrated` file is versioned JSON containing
its source fingerprint and migration counts; failed or partial runs do not
replace it and therefore retry automatically.

Before a large real import, back up MemPalace data:

```bash
cp -a ~/.mempalace ~/.mempalace.backup.$(date +%Y%m%d%H%M%S)
```

To roll back a test palace, remove or restore the target palace directory from backup. If KG metadata was written, also restore/remove the corresponding `knowledge_graph.sqlite3` file.

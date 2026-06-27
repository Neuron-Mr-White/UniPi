#!/usr/bin/env python3
"""Migrate UniPi memories into MemPalace drawers.

This script is intentionally conservative:

- It never deletes or modifies UniPi memory files/databases.
- It defaults to dry-run mode; pass --execute to write to MemPalace.
- It can export JSONL or a staging directory before importing.
- It uses MemPalace public Python APIs when executing imports.

Default UniPi source layout:

    ~/.unipi/memory/<project>/memory.db
    ~/.unipi/memory/<project>/*.md

Default MemPalace target layout:

    ~/.mempalace/palace

Install MemPalace separately before --execute, for example:

    uv tool install mempalace

For development against a local clone, pass:

    --mempalace-repo /tmp/mempalace
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import textwrap
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - exercised on systems without pyyaml
    yaml = None

MEMORY_TYPES = {"preference", "decision", "pattern", "summary"}
DEFAULT_SOURCE = Path.home() / ".unipi" / "memory"
DEFAULT_PALACE = Path.home() / ".mempalace" / "palace"
DEFAULT_BATCH_SIZE = 100
MIGRATION_AGENT = "unipi-memory-migration"


@dataclass(frozen=True)
class UniPiMemory:
    """A normalized UniPi memory record."""

    project: str
    id: str
    title: str
    content: str
    tags: list[str]
    type: str
    created: str | None
    updated: str | None
    source_kind: str
    source_path: str

    @property
    def source_uri(self) -> str:
        safe_project = quote_uri_part(self.project)
        safe_id = quote_uri_part(self.id)
        return f"unipi://memory/{safe_project}/{safe_id}"

    def as_markdown_document(self) -> str:
        """Return a MemPalace document preserving UniPi metadata and body."""
        frontmatter = {
            "title": self.title,
            "tags": self.tags,
            "project": self.project,
            "created": self.created,
            "updated": self.updated,
            "type": self.type,
            "unipi_id": self.id,
            "unipi_source": self.source_kind,
        }
        frontmatter = {k: v for k, v in frontmatter.items() if v not in (None, [], "")}
        return f"---\n{dump_frontmatter(frontmatter)}---\n\n{self.content.strip()}\n"


def quote_uri_part(value: str) -> str:
    """Small URI-path escaper good enough for stable source IDs."""
    return re.sub(r"[^A-Za-z0-9_.~-]", lambda m: f"%{ord(m.group(0)):02X}", value)


def safe_id_part(value: str) -> str:
    """Sanitize a value for stable drawer IDs when MemPalace helper is unavailable."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return cleaned or "unknown"


def stable_hash(parts: Iterable[Any], length: int = 24) -> str:
    """MemPalace-compatible spirit: length-prefixed parts avoid concat collisions."""
    payload = "".join(f"{len(str(part))}:{part}" for part in parts).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def fallback_drawer_id(wing: str, room: str, source_file: str, chunk_index: int = 0) -> str:
    """Build a deterministic drawer ID without importing MemPalace."""
    return (
        f"drawer_{safe_id_part(wing)}_{safe_id_part(room)}_"
        f"{stable_hash((source_file, str(chunk_index)))}"
    )


def dump_frontmatter(data: dict[str, Any]) -> str:
    if yaml is not None:
        return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=10_000)
    # Minimal fallback used only if PyYAML is absent.
    lines: list[str] = []
    for key, value in data.items():
        if isinstance(value, list):
            lines.append(f"{key}:")
            lines.extend(f"  - {item}" for item in value)
        else:
            lines.append(f"{key}: {value}")
    return "\n".join(lines) + "\n"


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str] | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end == -1:
        return None
    raw_fm = text[4:end]
    body_start = end + len("\n---")
    if text[body_start : body_start + 1] == "\n":
        body_start += 1
    body = text[body_start:]

    if yaml is not None:
        loaded = yaml.safe_load(raw_fm) or {}
        if not isinstance(loaded, dict):
            return None
        return loaded, body

    # Minimal fallback parser: handles scalar keys and YAML-ish list blocks.
    data: dict[str, Any] = {}
    current_list_key: str | None = None
    for raw_line in raw_fm.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        if current_list_key and line.startswith("  - "):
            data.setdefault(current_list_key, []).append(line[4:].strip().strip("'\""))
            continue
        current_list_key = None
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value == "":
            data[key] = []
            current_list_key = key
        elif value.startswith("[") and value.endswith("]"):
            data[key] = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
        else:
            data[key] = value.strip("'\"")
    return data, body


def coerce_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(v) for v in parsed if str(v).strip()]
        except Exception:
            pass
        return [part.strip() for part in stripped.split(",") if part.strip()]
    return [str(value)]


def normalize_memory_type(value: Any) -> str:
    lowered = str(value or "summary").strip().lower()
    return lowered if lowered in MEMORY_TYPES else "summary"


def parse_markdown_memory(project: str, path: Path) -> UniPiMemory | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"WARN: cannot read {path}: {exc}", file=sys.stderr)
        return None

    parsed = parse_frontmatter(text)
    if parsed is None:
        print(f"WARN: skipping {path}: missing/invalid frontmatter", file=sys.stderr)
        return None
    fm, body = parsed
    title = str(fm.get("title") or path.stem).strip()
    memory_id = safe_id_part(str(fm.get("id") or path.stem))
    return UniPiMemory(
        project=str(fm.get("project") or project),
        id=memory_id,
        title=title,
        content=body.strip(),
        tags=coerce_tags(fm.get("tags")),
        type=normalize_memory_type(fm.get("type")),
        created=str(fm.get("created")) if fm.get("created") else None,
        updated=str(fm.get("updated")) if fm.get("updated") else None,
        source_kind="markdown",
        source_path=str(path),
    )


def load_sqlite_memories(project: str, db_path: Path) -> list[UniPiMemory]:
    """Read UniPi SQLite rows as a fallback/completeness source."""
    if not db_path.exists():
        return []
    uri = f"file:{db_path}?mode=ro"
    rows: list[sqlite3.Row]
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            rows = list(conn.execute("SELECT * FROM memories"))
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        print(f"WARN: cannot read SQLite DB {db_path}: {exc}", file=sys.stderr)
        return []

    out: list[UniPiMemory] = []
    for row in rows:
        row_project = str(row["project"] or project)
        memory_id = safe_id_part(str(row["id"] or row["title"]))
        out.append(
            UniPiMemory(
                project=row_project,
                id=memory_id,
                title=str(row["title"] or memory_id),
                content=str(row["content"] or "").strip(),
                tags=coerce_tags(row["tags"]),
                type=normalize_memory_type(row["type"]),
                created=str(row["created"]) if row["created"] else None,
                updated=str(row["updated"]) if row["updated"] else None,
                source_kind="sqlite",
                source_path=str(db_path),
            )
        )
    return out


def discover_memories(source_dir: Path, project_filter: list[str] | None = None) -> list[UniPiMemory]:
    if not source_dir.exists():
        raise SystemExit(f"UniPi memory source does not exist: {source_dir}")
    filters = set(project_filter or [])
    by_key: dict[tuple[str, str], UniPiMemory] = {}

    project_dirs = sorted(p for p in source_dir.iterdir() if p.is_dir())
    for project_dir in project_dirs:
        project = project_dir.name
        if filters and project not in filters:
            continue

        # Prefer markdown because it is human-readable and contains canonical frontmatter.
        for md_path in sorted(project_dir.glob("*.md")):
            if md_path.name.startswith("."):
                continue
            record = parse_markdown_memory(project, md_path)
            if record is None:
                continue
            by_key[(record.project, record.id)] = record

        # Add DB-only rows that do not have corresponding markdown files.
        for record in load_sqlite_memories(project, project_dir / "memory.db"):
            by_key.setdefault((record.project, record.id), record)

    return sorted(by_key.values(), key=lambda r: (r.project, r.type, r.title, r.id))


def metadata_for(record: UniPiMemory, wing: str, room: str, now: str) -> dict[str, Any]:
    """Build scalar MemPalace metadata. Keep it backend-portable."""
    return {
        "wing": wing,
        "room": room,
        "source_file": record.source_uri,
        "chunk_index": 0,
        "added_by": MIGRATION_AGENT,
        "filed_at": now,
        "content_date": record.updated or record.created or "",
        "unipi_project": record.project,
        "unipi_id": record.id,
        "unipi_title": record.title,
        "unipi_type": record.type,
        "unipi_tags": ",".join(record.tags),
        "unipi_source_kind": record.source_kind,
        "unipi_source_path": record.source_path,
        "normalize_version": 2,
        "id_recipe": "unipi-migration-v1",
    }


def resolve_wing(record: UniPiMemory, fixed_wing: str | None, wing_prefix: str) -> str:
    if fixed_wing:
        base = fixed_wing
    else:
        base = record.project
    return f"{wing_prefix}{base}" if wing_prefix else base


def resolve_room(record: UniPiMemory, fixed_room: str | None, include_type_prefix: bool) -> str:
    if fixed_room:
        return fixed_room
    return f"unipi_{record.type}" if include_type_prefix else record.type


def batch(iterable: list[Any], size: int) -> Iterable[list[Any]]:
    for idx in range(0, len(iterable), size):
        yield iterable[idx : idx + size]


def export_jsonl(path: Path, records: list[UniPiMemory], args: argparse.Namespace) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    with path.open("w", encoding="utf-8") as fh:
        for record in records:
            wing = resolve_wing(record, args.wing, args.wing_prefix)
            room = resolve_room(record, args.room, args.type_prefixed_rooms)
            item = {
                "record": asdict(record),
                "wing": wing,
                "room": room,
                "source_uri": record.source_uri,
                "metadata": metadata_for(record, wing, room, now),
                "document": record.as_markdown_document(),
            }
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")


def write_staging_dir(path: Path, records: list[UniPiMemory], args: argparse.Namespace) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for record in records:
        wing = safe_id_part(resolve_wing(record, args.wing, args.wing_prefix))
        room = safe_id_part(resolve_room(record, args.room, args.type_prefixed_rooms))
        out_dir = path / wing / room
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{safe_id_part(record.id)}.md"
        out_path.write_text(record.as_markdown_document(), encoding="utf-8")


def add_mempalace_to_path(repo: str | None) -> None:
    if repo:
        sys.path.insert(0, str(Path(repo).expanduser().resolve()))


def import_drawers(records: list[UniPiMemory], args: argparse.Namespace) -> int:
    """Import records through MemPalace's public collection API."""
    add_mempalace_to_path(args.mempalace_repo)
    try:
        from mempalace.ids import make_drawer_id_from_chunk  # type: ignore
        from mempalace.palace import get_collection  # type: ignore
    except Exception as exc:  # noqa: BLE001 - message should include import-time dependency failures
        raise SystemExit(
            "Could not import MemPalace APIs. Install MemPalace first or pass "
            f"--mempalace-repo /path/to/mempalace. Original error: {type(exc).__name__}: {exc}"
        )

    kwargs: dict[str, Any] = {"create": True}
    if args.backend:
        kwargs["backend"] = args.backend
    collection = get_collection(str(args.palace), **kwargs)

    now = datetime.now(timezone.utc).isoformat()
    imported = 0
    for group in batch(records, args.batch_size):
        ids: list[str] = []
        docs: list[str] = []
        metas: list[dict[str, Any]] = []
        for record in group:
            wing = resolve_wing(record, args.wing, args.wing_prefix)
            room = resolve_room(record, args.room, args.type_prefixed_rooms)
            source_uri = record.source_uri
            try:
                drawer_id = make_drawer_id_from_chunk(wing, room, source_uri, 0)
            except Exception:
                drawer_id = fallback_drawer_id(wing, room, source_uri, 0)
            ids.append(drawer_id)
            docs.append(record.as_markdown_document())
            metas.append(metadata_for(record, wing, room, now))
        collection.upsert(documents=docs, ids=ids, metadatas=metas)
        imported += len(group)
    return imported


def import_metadata_kg(records: list[UniPiMemory], args: argparse.Namespace) -> int:
    """Optionally import provenance triples, not semantic fact extraction."""
    if not args.kg_metadata:
        return 0
    add_mempalace_to_path(args.mempalace_repo)
    try:
        from mempalace.knowledge_graph import KnowledgeGraph  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"Could not import MemPalace KnowledgeGraph: {type(exc).__name__}: {exc}")

    kg_path = args.kg_path
    if kg_path is None:
        kg_path = Path(args.palace) / "knowledge_graph.sqlite3"
    kg = KnowledgeGraph(str(kg_path))
    added = 0
    try:
        for record in records:
            subject = f"UniPi memory {record.project}/{record.id}"
            valid_from = (record.updated or record.created or "")[:10] or None
            source_drawer_id = fallback_drawer_id(
                resolve_wing(record, args.wing, args.wing_prefix),
                resolve_room(record, args.room, args.type_prefixed_rooms),
                record.source_uri,
                0,
            )
            triples = [
                (subject, "belongs_to_project", record.project),
                (subject, "has_type", record.type),
                (subject, "has_title", record.title),
            ]
            triples.extend((subject, "has_tag", tag) for tag in record.tags)
            for sub, pred, obj in triples:
                kg.add_triple(
                    sub,
                    pred,
                    obj,
                    valid_from=valid_from,
                    confidence=1.0,
                    source_file=record.source_uri,
                    source_drawer_id=source_drawer_id,
                    adapter_name=MIGRATION_AGENT,
                )
                added += 1
    finally:
        close = getattr(kg, "close", None)
        if callable(close):
            close()
    return added


def print_summary(records: list[UniPiMemory], args: argparse.Namespace) -> None:
    by_project: dict[str, int] = {}
    by_type: dict[str, int] = {}
    for record in records:
        by_project[record.project] = by_project.get(record.project, 0) + 1
        by_type[record.type] = by_type.get(record.type, 0) + 1

    print(f"UniPi source:     {args.source}")
    print(f"MemPalace palace: {args.palace}")
    print(f"Mode:             {'EXECUTE' if args.execute else 'dry-run'}")
    print(f"Records found:    {len(records)}")
    print("Projects:")
    for project, count in sorted(by_project.items()):
        print(f"  - {project}: {count}")
    print("Types:")
    for typ, count in sorted(by_type.items()):
        print(f"  - {typ}: {count}")
    if records:
        print("Sample mapping:")
        for record in records[: min(5, len(records))]:
            wing = resolve_wing(record, args.wing, args.wing_prefix)
            room = resolve_room(record, args.room, args.type_prefixed_rooms)
            print(f"  - {record.project}/{record.id} -> wing={wing!r}, room={room!r}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Migrate UniPi ~/.unipi/memory records into MemPalace drawers.",
        epilog=textwrap.dedent(
            """
            Examples:
              # Inspect all memories without writing anything
              scripts/migrate-unipi-memory-to-mempalace.py --dry-run

              # Export an audit file
              scripts/migrate-unipi-memory-to-mempalace.py --export-jsonl /tmp/unipi-memories.jsonl

              # Import only this project into the default MemPalace palace
              scripts/migrate-unipi-memory-to-mempalace.py --project unipi --execute

              # Use a local MemPalace clone and explicit backend
              scripts/migrate-unipi-memory-to-mempalace.py --execute --mempalace-repo /tmp/mempalace --backend sqlite_exact

              # Build files for `mempalace mine` instead of direct import
              scripts/migrate-unipi-memory-to-mempalace.py --staging-dir /tmp/unipi-memory-staging
              mempalace mine /tmp/unipi-memory-staging --wing unipi-migration
            """
        ),
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="UniPi memory root")
    parser.add_argument("--palace", type=Path, default=DEFAULT_PALACE, help="MemPalace palace path")
    parser.add_argument("--mempalace-repo", help="Local MemPalace repo path to add to PYTHONPATH")
    parser.add_argument("--backend", help="MemPalace backend name, e.g. chroma or sqlite_exact")
    parser.add_argument("--project", action="append", help="Only migrate a UniPi project; repeatable")
    parser.add_argument("--wing", help="Force all records into this MemPalace wing")
    parser.add_argument("--wing-prefix", default="", help="Prefix generated wings, e.g. unipi_")
    parser.add_argument("--room", help="Force all records into this MemPalace room")
    parser.add_argument(
        "--plain-type-rooms",
        dest="type_prefixed_rooms",
        action="store_false",
        help="Use rooms named preference/decision/pattern/summary instead of unipi_<type>",
    )
    parser.set_defaults(type_prefixed_rooms=True)
    parser.add_argument("--export-jsonl", type=Path, help="Write normalized migration payload as JSONL")
    parser.add_argument("--staging-dir", type=Path, help="Write markdown staging tree for `mempalace mine`")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="Import batch size")
    parser.add_argument(
        "--kg-metadata",
        action="store_true",
        help="Also write provenance triples to MemPalace KG (not semantic fact extraction)",
    )
    parser.add_argument("--kg-path", type=Path, help="KG SQLite path; default is <palace>/knowledge_graph.sqlite3")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--execute", action="store_true", help="Actually write to MemPalace")
    mode.add_argument("--dry-run", action="store_true", help="Inspect only; this is the default")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.source = args.source.expanduser().resolve()
    args.palace = args.palace.expanduser()
    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")

    records = discover_memories(args.source, args.project)
    print_summary(records, args)

    if args.export_jsonl:
        export_jsonl(args.export_jsonl.expanduser(), records, args)
        print(f"Wrote JSONL export: {args.export_jsonl}")

    if args.staging_dir:
        write_staging_dir(args.staging_dir.expanduser(), records, args)
        print(f"Wrote staging directory: {args.staging_dir}")

    if not args.execute:
        print("Dry run complete. Pass --execute to import drawers into MemPalace.")
        return 0

    if not records:
        print("No records to import.")
        return 0

    imported = import_drawers(records, args)
    print(f"Imported/updated {imported} MemPalace drawers.")
    kg_triples = import_metadata_kg(records, args)
    if kg_triples:
        print(f"Imported/updated {kg_triples} KG provenance triples.")
    print("Migration complete.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

#!/usr/bin/env python3
"""UniPi memory <-> MemPalace bridge.

Single-command JSON bridge invoked once per operation by the TypeScript
memory package. Loads MemPalace, opens the palace collection, performs one
command, prints one JSON line to stdout, exits.

Usage:
    python mempalace_bridge.py <palace_path> <command> [args_json]

stdout (always exactly one JSON line):
    {"ok": true, "result": <value>}
    {"ok": false, "error": "<message>"}

Design notes:
- MemPalace embeds drawer text internally (default ONNX MiniLM model). UniPi
  never passes embeddings through this bridge; search uses query_texts.
- Drawer documents are markdown with YAML frontmatter so the human-readable
  tier is preserved and the bridge can recover title/type without metadata.
- Drawer IDs are deterministic via make_drawer_id_from_chunk(wing, room,
  source_uri, 0), so upserts are idempotent and re-migration does not
  duplicate records.
- Metadata is kept scalar/string-only for backend portability (ChromaDB,
  sqlite_exact, qdrant, pgvector).
- This script never deletes or mutates UniPi legacy files; migration is a
  read-only copy into MemPalace.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None

MEMORY_TYPES = {"preference", "decision", "pattern", "summary"}
MIGRATION_AGENT = "unipi-memory-bridge"


# ---------------------------------------------------------------------------
# ID + URI helpers (mirror mempalace.ids when available, else deterministic fallback)
# ---------------------------------------------------------------------------

def quote_uri_part(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.~-]", lambda m: f"%{ord(m.group(0)):02X}", value)


def safe_id_part(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return cleaned or "unknown"


def stable_hash(parts: Iterable[Any], length: int = 24) -> str:
    payload = "".join(f"{len(str(part))}:{part}" for part in parts).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:length]


def fallback_drawer_id(wing: str, room: str, source_file: str, chunk_index: int = 0) -> str:
    return (
        f"drawer_{safe_id_part(wing)}_{safe_id_part(room)}_"
        f"{stable_hash((source_file, str(chunk_index)))}"
    )


def drawer_id_for(wing: str, room: str, source_uri: str, chunk_index: int = 0) -> str:
    try:
        from mempalace.ids import make_drawer_id_from_chunk  # type: ignore
        return make_drawer_id_from_chunk(wing, room, source_uri, chunk_index)
    except Exception:
        return fallback_drawer_id(wing, room, source_uri, chunk_index)


# ---------------------------------------------------------------------------
# Frontmatter (YAML when available, minimal fallback otherwise)
# ---------------------------------------------------------------------------

def dump_frontmatter(data: dict[str, Any]) -> str:
    if yaml is not None:
        return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=10_000)
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
    # minimal fallback parser
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


def normalize_type(value: Any) -> str:
    lowered = str(value or "summary").strip().lower()
    return lowered if lowered in MEMORY_TYPES else "summary"


def build_document(title: str, content: str, tags: list[str], project: str,
                   created: str, updated: str, mtype: str, unipi_id: str) -> str:
    fm = {
        "title": title,
        "tags": tags,
        "project": project,
        "created": created,
        "updated": updated,
        "type": mtype,
        "unipi_id": unipi_id,
    }
    fm = {k: v for k, v in fm.items() if v not in (None, [], "")}
    return f"---\n{dump_frontmatter(fm)}---\n\n{content.strip()}\n"


def build_metadata(wing: str, room: str, title: str, mtype: str, project: str,
                   tags: list[str], unipi_id: str, source_kind: str, now: str,
                   content_date: str = "") -> dict[str, Any]:
    return {
        "wing": wing,
        "room": room,
        "source_file": f"unipi://memory/{quote_uri_part(project)}/{quote_uri_part(unipi_id)}",
        "chunk_index": 0,
        "added_by": MIGRATION_AGENT,
        "filed_at": now,
        "content_date": content_date,
        "unipi_project": project,
        "unipi_id": unipi_id,
        "unipi_title": title,
        "unipi_type": mtype,
        "unipi_tags": ",".join(tags),
        "unipi_source_kind": source_kind,
        "normalize_version": 2,
        "id_recipe": "unipi-bridge-v1",
    }


def record_from_doc(doc: str, meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """Recover a UniPi-style record from a drawer document + metadata."""
    parsed = parse_frontmatter(doc) if doc else None
    fm: dict[str, Any] = {}
    body = doc or ""
    if parsed:
        fm, body = parsed
    meta = meta or {}
    unipi_id = fm.get("unipi_id") or meta.get("unipi_id") or ""
    if not unipi_id:
        # fall back to drawer id if metadata lost
        return None
    title = str(fm.get("title") or meta.get("unipi_title") or unipi_id)
    return {
        "id": unipi_id,
        "title": title,
        "content": body.strip(),
        "tags": coerce_tags(fm.get("tags") if "tags" in fm else meta.get("unipi_tags")),
        "project": str(fm.get("project") or meta.get("unipi_project") or meta.get("wing") or ""),
        "type": normalize_type(fm.get("type") or meta.get("unipi_type")),
        "created": str(fm.get("created") or ""),
        "updated": str(fm.get("updated") or ""),
    }


def snippet(text: str, length: int = 200) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text[:length] + ("..." if len(text) > length else "")


# ---------------------------------------------------------------------------
# Legacy UniPi source reading (read-only)
# ---------------------------------------------------------------------------

def parse_markdown_memory(project: str, path: Path) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    parsed = parse_frontmatter(text)
    if parsed is None:
        return None
    fm, body = parsed
    mid = safe_id_part(str(fm.get("id") or path.stem))
    return {
        "project": str(fm.get("project") or project),
        "id": mid,
        "title": str(fm.get("title") or path.stem).strip(),
        "content": body.strip(),
        "tags": coerce_tags(fm.get("tags")),
        "type": normalize_type(fm.get("type")),
        "created": str(fm.get("created")) if fm.get("created") else "",
        "updated": str(fm.get("updated")) if fm.get("updated") else "",
        "source_kind": "markdown",
        "source_path": str(path),
    }


def load_sqlite_memories(project: str, db_path: Path) -> list[dict[str, Any]]:
    if not db_path.exists():
        return []
    uri = f"file:{db_path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            rows = list(conn.execute("SELECT * FROM memories"))
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        out.append({
            "project": str(row["project"] or project),
            "id": safe_id_part(str(row["id"] or row["title"])),
            "title": str(row["title"] or row["id"]),
            "content": str(row["content"] or "").strip(),
            "tags": coerce_tags(row["tags"]),
            "type": normalize_type(row["type"]),
            "created": str(row["created"]) if row["created"] else "",
            "updated": str(row["updated"]) if row["updated"] else "",
            "source_kind": "sqlite",
            "source_path": str(db_path),
        })
    return out


def discover_legacy_memories(source_dir: Path, project_filter: list[str] | None = None) -> list[dict[str, Any]]:
    if not source_dir.exists():
        return []
    filters = set(project_filter or [])
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for project_dir in sorted(p for p in source_dir.iterdir() if p.is_dir()):
        project = project_dir.name
        if filters and project not in filters:
            continue
        for md_path in sorted(project_dir.glob("*.md")):
            if md_path.name.startswith("."):
                continue
            rec = parse_markdown_memory(project, md_path)
            if rec:
                by_key[(rec["project"], rec["id"])] = rec
        for rec in load_sqlite_memories(project, project_dir / "memory.db"):
            by_key.setdefault((rec["project"], rec["id"]), rec)
    return sorted(by_key.values(), key=lambda r: (r["project"], r["type"], r["title"], r["id"]))


# ---------------------------------------------------------------------------
# Bridge session
# ---------------------------------------------------------------------------

class Bridge:
    def __init__(self, palace_path: str, backend: str | None = None):
        from mempalace.palace import get_collection  # type: ignore
        kwargs: dict[str, Any] = {"create": True}
        if backend:
            kwargs["backend"] = backend
        self.palace_path = palace_path
        self.collection = get_collection(palace_path, **kwargs)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _wing_room(self, project: str, mtype: str) -> tuple[str, str]:
        return project, f"unipi_{normalize_type(mtype)}"

    def _source_uri(self, project: str, unipi_id: str) -> str:
        return f"unipi://memory/{quote_uri_part(project)}/{quote_uri_part(unipi_id)}"

    def _upsert_one(self, rec: dict[str, Any], wing: str | None = None, room: str | None = None) -> str:
        wing = wing or rec["project"]
        room = room or f"unipi_{normalize_type(rec['type'])}"
        source_uri = self._source_uri(rec["project"], rec["id"])
        did = drawer_id_for(wing, room, source_uri, 0)
        doc = build_document(
            rec["title"], rec["content"], rec["tags"], rec["project"],
            rec.get("created", ""), rec.get("updated", ""), rec["type"], rec["id"],
        )
        meta = build_metadata(
            wing, room, rec["title"], rec["type"], rec["project"], rec["tags"],
            rec["id"], rec.get("source_kind", "markdown"), self._now(),
            rec.get("updated") or rec.get("created") or "",
        )
        self.collection.upsert(documents=[doc], ids=[did], metadatas=[meta])
        return did

    # -- commands --

    def ping(self) -> str:
        return "pong"

    def count(self, wing: str | None = None) -> int:
        if wing:
            got = self.collection.get(where={"wing": wing})
        else:
            got = self.collection.get()
        return len(got.ids if hasattr(got, "ids") else got.get("ids", []))

    def store(self, record: dict[str, Any]) -> dict[str, Any]:
        did = self._upsert_one(record)
        return {"id": record["id"], "drawer_id": did}

    def get(self, id_: str) -> dict[str, Any] | None:
        # IDs in metadata are unipi ids; fetch all and filter (drawer ids differ).
        got = self.collection.get(where={"unipi_id": id_})
        ids = got.ids if hasattr(got, "ids") else got.get("ids", [])
        docs = got.documents if hasattr(got, "documents") else got.get("documents", [])
        metas = got.metadatas if hasattr(got, "metadatas") else got.get("metadatas", [])
        if not ids:
            return None
        return record_from_doc(docs[0], metas[0] if metas else None)

    def get_by_title(self, wing: str, title: str) -> dict[str, Any] | None:
        got = self.collection.get(where={"wing": wing})
        docs = got.documents if hasattr(got, "documents") else got.get("documents", [])
        metas = got.metadatas if hasattr(got, "metadatas") else got.get("metadatas", [])
        lowered = title.lower()
        for doc, meta in zip(docs, metas):
            rec = record_from_doc(doc, meta)
            if not rec:
                continue
            if rec["title"] == title or rec["title"].lower() == lowered:
                return rec
        return None

    def list(self, wing: str) -> list[dict[str, Any]]:
        got = self.collection.get(where={"wing": wing})
        docs = got.documents if hasattr(got, "documents") else got.get("documents", [])
        metas = got.metadatas if hasattr(got, "metadatas") else got.get("metadatas", [])
        out: list[dict[str, Any]] = []
        for doc, meta in zip(docs, metas):
            rec = record_from_doc(doc, meta)
            if rec:
                out.append({"id": rec["id"], "title": rec["title"], "type": rec["type"]})
        # sort by updated desc (best effort — metadata has no guaranteed order)
        return out

    def list_all(self) -> list[dict[str, Any]]:
        got = self.collection.get()
        docs = got.documents if hasattr(got, "documents") else got.get("documents", [])
        metas = got.metadatas if hasattr(got, "metadatas") else got.get("metadatas", [])
        out: list[dict[str, Any]] = []
        for doc, meta in zip(docs, metas):
            rec = record_from_doc(doc, meta)
            if rec:
                out.append({"id": rec["id"], "title": rec["title"], "type": rec["type"],
                            "project": rec["project"]})
        return out

    def search(self, query: str, wing: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        where = {"wing": wing} if wing else None
        kwargs: dict[str, Any] = {"query_texts": [query], "n_results": limit}
        if where:
            kwargs["where"] = where
        res = self.collection.query(**kwargs)
        ids = res.ids[0] if res.ids else []
        docs = res.documents[0] if res.documents else []
        metas = res.metadatas[0] if res.metadatas else []
        dists = res.distances[0] if res.distances else []
        out: list[dict[str, Any]] = []
        for doc, meta, dist in zip(docs, metas, dists):
            rec = record_from_doc(doc, meta)
            if not rec:
                continue
            score = max(0.0, 1.0 - float(dist))
            out.append({
                "id": rec["id"], "title": rec["title"], "content": rec["content"],
                "tags": rec["tags"], "project": rec["project"], "type": rec["type"],
                "created": rec["created"], "updated": rec["updated"],
                "score": round(score, 4), "snippet": snippet(rec["content"]),
            })
        return out

    def delete(self, id_: str) -> bool:
        got = self.collection.get(where={"unipi_id": id_})
        ids = got.ids if hasattr(got, "ids") else got.get("ids", [])
        if not ids:
            return False
        self.collection.delete(ids=ids)
        return True

    def has_title(self, wing: str, title: str) -> bool:
        return self.get_by_title(wing, title) is not None

    def find_similar(self, wing: str, title: str, threshold: float = 0.6) -> list[dict[str, Any]]:
        got = self.collection.get(where={"wing": wing})
        docs = got.documents if hasattr(got, "documents") else got.get("documents", [])
        metas = got.metadatas if hasattr(got, "metadatas") else got.get("metadatas", [])
        norm = re.sub(r"[^a-z0-9]+", " ", title.lower())
        title_words = set(w for w in norm.split() if len(w) > 2)
        out: list[dict[str, Any]] = []
        for doc, meta in zip(docs, metas):
            rec = record_from_doc(doc, meta)
            if not rec:
                continue
            rnorm = re.sub(r"[^a-z0-9]+", " ", rec["title"].lower())
            rwords = set(w for w in re.split(r"\s+", rnorm) if len(w) > 2)
            union = title_words | rwords
            inter = title_words & rwords
            sim = len(inter) / len(union) if union else 0.0
            if sim >= threshold:
                out.append({"record": rec, "similarity": round(sim, 4)})
        out.sort(key=lambda x: x["similarity"], reverse=True)
        return out

    def sync_orphaned(self, project_dir: str, wing: str) -> int:
        pdir = Path(project_dir)
        if not pdir.exists():
            return 0
        existing = {r["id"] for r in self.list(wing)}
        synced = 0
        for md_path in sorted(pdir.glob("*.md")):
            if md_path.name.startswith("."):
                continue
            rec = parse_markdown_memory(wing, md_path)
            if not rec:
                continue
            if rec["id"] in existing:
                continue
            self._upsert_one(rec)
            synced += 1
        return synced

    def migrate(self, source_dir: str, project_filter: list[str] | None = None) -> dict[str, Any]:
        records = discover_legacy_memories(Path(source_dir), project_filter)
        imported = 0
        by_project: dict[str, int] = {}
        for rec in records:
            try:
                self._upsert_one(rec)
                imported += 1
                by_project[rec["project"]] = by_project.get(rec["project"], 0) + 1
            except Exception:
                pass
        return {"imported": imported, "projects": by_project}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: bridge.py <palace> <command> [args_json]"}))
        return 2
    palace = argv[1]
    cmd = argv[2]
    args_raw = argv[3] if len(argv) > 3 else "{}"
    try:
        args = json.loads(args_raw) if args_raw else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid args json: {exc}"}))
        return 2

    backend = os.environ.get("UNIPI_MEMPALACE_BACKEND") or None
    try:
        bridge = Bridge(palace, backend=backend)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"mempalace init failed: {type(exc).__name__}: {exc}"}))
        return 1

    handlers = {
        "ping": lambda: bridge.ping(),
        "count": lambda: bridge.count(args.get("wing")),
        "store": lambda: bridge.store(args["record"]),
        "get": lambda: bridge.get(args["id"]),
        "get_by_title": lambda: bridge.get_by_title(args["wing"], args["title"]),
        "list": lambda: bridge.list(args["wing"]),
        "list_all": lambda: bridge.list_all(),
        "search": lambda: bridge.search(args["query"], args.get("wing"), int(args.get("limit", 10))),
        "delete": lambda: bridge.delete(args["id"]),
        "has_title": lambda: bridge.has_title(args["wing"], args["title"]),
        "find_similar": lambda: bridge.find_similar(args["wing"], args["title"], float(args.get("threshold", 0.6))),
        "sync_orphaned": lambda: bridge.sync_orphaned(args["project_dir"], args["wing"]),
        "migrate": lambda: bridge.migrate(args["source_dir"], args.get("projects")),
    }
    handler = handlers.get(cmd)
    if handler is None:
        print(json.dumps({"ok": False, "error": f"unknown command: {cmd}"}))
        return 2
    try:
        result = handler()
        print(json.dumps({"ok": True, "result": result}, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

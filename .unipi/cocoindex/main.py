"""
CocoIndex pipeline for unipi
Updated for cocoindex v1.0+ — uses App/fn/mount API.
"""
import pathlib
from dataclasses import dataclass
from typing import AsyncIterator

import cocoindex as coco
from cocoindex.connectors import localfs, lancedb
from cocoindex.resources.file import PatternFilePathMatcher

import os

# ── Configuration ────────────────────────────────────
PROJECT_ROOT = os.environ.get("PROJECT_ROOT", "/home/pi/dev/unipi")

# ── LanceDB context key ──────────────────────────────
# The connection is created in the lifespan and provided to the context.
# Target handlers retrieve it via this key when applying actions.
db_key = coco.ContextKey("lancedb/unipi")


# ── Environment setup (async lifespan) ───────────────
@coco.lifespan
async def coco_lifespan(builder: coco.EnvironmentBuilder) -> AsyncIterator[None]:
    """Configure environment: DB path + LanceDB connection."""
    builder.settings.db_path = pathlib.Path(__file__).parent / "cocoindex.db"

    # Create and provide LanceDB async connection
    db_path = pathlib.Path(__file__).parent / ".lancedb"
    conn = await lancedb.connect_async(str(db_path))
    builder.provide(db_key, conn)

    yield  # environment stays alive until shutdown


# ── Row type for LanceDB ─────────────────────────────
@dataclass
class IndexRow:
    """A single indexed chunk stored in LanceDB."""
    path: str
    chunk_index: int
    content: str


# ── Chunking function ────────────────────────────────
@coco.fn
async def chunk_text(
    content: str,
    *,
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
) -> list[tuple[int, str]]:
    """Split text into overlapping chunks.

    Returns list of (chunk_index, chunk_text) pairs.
    Memoized — only re-runs if content changes.
    """
    if not content.strip():
        return []

    chunks: list[tuple[int, str]] = []
    start = 0
    idx = 0
    while start < len(content):
        end = min(start + chunk_size, len(content))
        chunk = content[start:end].strip()
        if chunk:
            chunks.append((idx, chunk))
            idx += 1
        start += chunk_size - chunk_overlap
        if start < 0:
            start = 0

    return chunks


# ── Process a single file ────────────────────────────
@coco.fn
async def process_file(
    file: localfs.File,
    table: lancedb.TableTarget,
) -> None:
    """Read a file, chunk it, and declare rows in LanceDB."""
    try:
        content = await file.read_text()
    except Exception:
        return

    if not content.strip():
        return

    relative = file.file_path.path.as_posix()
    chunks = await chunk_text(content)

    for chunk_idx, text in chunks:
        table.declare_row(row=IndexRow(
            path=relative,
            chunk_index=chunk_idx,
            content=text,
        ))


# ── Main app function ────────────────────────────────
@coco.fn
async def app_main() -> None:
    """Walk project files → chunk → store in LanceDB."""
    project_root = pathlib.Path(PROJECT_ROOT)

    # 1) Declare LanceDB table target
    table_schema = await lancedb.TableSchema.from_class(
        IndexRow,
        primary_key=["path", "chunk_index"],
    )

    target = await coco.mount_target(
        lancedb.table_target(
            db_key,
            "unipi_index",
            table_schema,
        ),
    )
    table = lancedb.TableTarget(target, table_schema)

    # 2) Walk project files
    walker = localfs.walk_dir(
        project_root,
        recursive=True,
        path_matcher=PatternFilePathMatcher(
            included_patterns=[
                "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
                "**/*.py", "**/*.rs", "**/*.go",
                "**/*.md", "**/*.txt", "**/*.json", "**/*.yaml", "**/*.yml",
                "**/*.sh", "**/*.bash",
            ],
            excluded_patterns=[
                "**/node_modules/**", "**/.git/**", "**/dist/**",
                "**/build/**", "**/.next/**", "**/__pycache__/**",
                "**/.unipi/cocoindex/**",
            ],
        ),
    )

    # 3) Process each file
    async for file in walker:
        await coco.mount(
            coco.component_subpath("process", file.file_path.path.as_posix()),
            process_file,
            file,
            table,
        )


# ── App instance (required by CLI) ───────────────────
app = coco.App(
    coco.AppConfig(name="local_unipi"),
    app_main,
)

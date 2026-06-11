"""
CocoIndex pipeline for unipi
Updated for cocoindex v1.0+ — uses App/fn/mount API.
Embeddings via OpenRouter (httpx, no litellm).
"""

import asyncio
import json
import pathlib
from dataclasses import dataclass
from typing import AsyncIterator

import httpx
import numpy as np
from numpy.typing import NDArray

import cocoindex as coco
from cocoindex.connectors import localfs, lancedb
from cocoindex.resources.file import PatternFilePathMatcher
from cocoindex.resources.schema import VectorSchema, VectorSchemaProvider

import os

# ── Configuration ────────────────────────────────────
PROJECT_ROOT = os.environ.get("PROJECT_ROOT", "/home/pi/dev/unipi")
EMBEDDING_MODEL = os.environ.get("COCO_EMBEDDING_MODEL", "qwen/qwen3-embedding-8b")
EMBEDDING_DIM = int(os.environ.get("COCO_EMBEDDING_DIM", "4096"))
EMBED_BATCH_SIZE = int(os.environ.get("COCO_EMBED_BATCH_SIZE", "64"))
# Safety limit for huge generated/lock files. Set COCO_MAX_FILE_CHARS=0 to disable.
MAX_FILE_CHARS = int(os.environ.get("COCO_MAX_FILE_CHARS", "200000"))

# ── LanceDB context key ──────────────────────────────
db_key = coco.ContextKey("lancedb/unipi")

# ── Async HTTP client (reused across calls) ─────────
_http_client: httpx.AsyncClient | None = None
_embed_semaphore = asyncio.Semaphore(3)  # max 3 concurrent API calls


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Call OpenRouter embeddings API asynchronously via httpx."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    async with _embed_semaphore:
        global _http_client
        if _http_client is None or _http_client.is_closed:
            _http_client = httpx.AsyncClient(timeout=httpx.Timeout(60.0))

        resp = await _http_client.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"model": EMBEDDING_MODEL, "input": texts},
        )
        resp.raise_for_status()
        data = resp.json()

    results = sorted(data["data"], key=lambda d: d["index"])
    return [r["embedding"] for r in results]


# ── Vector schema provider for the embedding column ──
class EmbeddingVector(VectorSchemaProvider):
    """Provides vector schema info for the embedding column."""

    def __init__(self, dim: int = EMBEDDING_DIM):
        self._dim = dim

    async def __coco_vector_schema__(self) -> VectorSchema:
        return VectorSchema(dtype=np.dtype(np.float32), size=self._dim)


# ── Environment setup (async lifespan) ───────────────
@coco.lifespan
async def coco_lifespan(builder: coco.EnvironmentBuilder) -> AsyncIterator[None]:
    """Configure environment: DB path + LanceDB connection."""
    builder.settings.db_path = pathlib.Path(__file__).parent / "cocoindex.db"

    db_path = pathlib.Path(__file__).parent / ".lancedb"
    conn = await lancedb.connect_async(str(db_path))
    builder.provide(db_key, conn)

    yield

    # Cleanup HTTP client on shutdown
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
        _http_client = None


# ── Row type for LanceDB ─────────────────────────────
@dataclass
class IndexRow:
    """A single indexed chunk with embedding stored in LanceDB."""

    path: str
    chunk_index: int
    content: str
    embedding: NDArray[np.float32]  # float32 vector, dim=4096


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
    """Read a file, chunk it, embed chunks, and declare rows in LanceDB."""
    try:
        content = await file.read_text()
    except Exception:
        return

    if not content.strip():
        return
    if MAX_FILE_CHARS > 0 and len(content) > MAX_FILE_CHARS:
        return

    relative = file.file_path.path.as_posix()
    chunks = await chunk_text(content)

    if not chunks:
        return

    # Batch embed all chunks for this file (split into EMBED_BATCH_SIZE chunks)
    texts = [text for _, text in chunks]
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[i : i + EMBED_BATCH_SIZE]
        batch_embs = await embed_texts(batch)
        all_embeddings.extend(batch_embs)

    for (chunk_idx, _text), emb in zip(chunks, all_embeddings):
        table.declare_row(
            row=IndexRow(
                path=relative,
                chunk_index=chunk_idx,
                content=_text,
                embedding=np.array(emb, dtype=np.float32),
            )
        )


# ── Main app function ────────────────────────────────
@coco.fn
async def app_main() -> None:
    """Walk project files → chunk → embed → store in LanceDB."""
    project_root = pathlib.Path(PROJECT_ROOT)

    # 1) Declare LanceDB table target with vector column
    table_schema = await lancedb.TableSchema.from_class(
        IndexRow,
        primary_key=["path", "chunk_index"],
        column_specs={
            "embedding": EmbeddingVector(),
        },
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
                "**/*.ts",
                "**/*.tsx",
                "**/*.js",
                "**/*.jsx",
                "**/*.py",
                "**/*.rs",
                "**/*.go",
                "**/*.md",
                "**/*.txt",
                "**/*.json",
                "**/*.yaml",
                "**/*.yml",
                "**/*.sh",
                "**/*.bash",
            ],
            excluded_patterns=[
                "**/node_modules/**",
                "**/.git/**",
                "**/dist/**",
                "**/build/**",
                "**/.next/**",
                "**/__pycache__/**",
                "**/coverage/**",
                "**/.turbo/**",
                "**/.cache/**",
                "**/.unipi/**",
                "**/*.min.js",
                "**/bundled.js",
                "**/bundle.js",
                "**/*bundle*.js",
                "**/package-lock.json",
                "**/pnpm-lock.yaml",
                "**/yarn.lock",
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

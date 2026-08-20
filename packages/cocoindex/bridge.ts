import { compareVersions } from "@pi-unipi/core";

/**
 * bridge.ts — CocoIndex CLI interaction layer
 *
 * Spawns cocoindex commands and queries LanceDB directly for search.
 * The bridge handles:
 * - CLI detection (is cocoindex installed?)
 * - Pipeline initialization (scaffold main.py)
 * - Project indexing (cocoindex update)
 * - Status reporting (last run, doc count)
 * - Search (query LanceDB directly via Node.js SDK)
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { COCOINDEX_MIN_VERSION } from "@pi-unipi/core";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface IndexResult {
  success: boolean;
  chunksProcessed: number;
  durationMs: number;
  error?: string;
}

export interface StatusInfo {
  indexed: boolean;
  lastRun: string | null;
  docCount: number;
  pipelineConfigured: boolean;
  cliAvailable: boolean;
  targetStore: "lancedb" | "postgres" | "qdrant" | "sqlite" | "unknown";
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer: "vector" | "fulltext" | "hybrid";
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const DEFAULT_PIPELINE_DIR = ".unipi/cocoindex";
const DEFAULT_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────
// CLI Detection
// ─────────────────────────────────────────────────────────

let cachedAvailable: boolean | null = null;

export interface AvailabilityOptions {
  /** Bypass the cached availability result. */
  useCache?: boolean;
}

/** Extract a semver-ish version from `cocoindex --version` output. */
export function parseVersion(versionStr: string): string | null {
  const match = versionStr.match(/(?:^|[^0-9])(\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/);
  return match?.[1] ?? null;
}

/** Compare semver-ish strings. Missing/invalid versions are not acceptable. */
export function isVersionAtLeast(version: string | null | undefined, minimum = COCOINDEX_MIN_VERSION): boolean {
  const parsed = version ? parseVersion(version) : null;
  const parsedMinimum = parseVersion(minimum);
  if (!parsed || !parsedMinimum) return false;
  return compareVersions(parsed, parsedMinimum) >= 0;
}

/** Reset cached availability, used after installer mutations. */
export function resetAvailabilityCache(): void {
  cachedAvailable = null;
}

/** Check if cocoindex CLI is installed and available. */
export async function isAvailable(options: AvailabilityOptions = {}): Promise<boolean> {
  const useCache = options.useCache ?? true;
  if (useCache && cachedAvailable !== null) return cachedAvailable;

  let available = false;
  try {
    const result = execFileSync(getCocoindexBinPath(), ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    available = result.trim().length > 0;
  } catch {
    available = false;
  }

  if (useCache) cachedAvailable = available;
  return available;
}

/** Get cocoindex CLI version string. */
export async function getVersion(): Promise<string | null> {
  try {
    const result = execFileSync(getCocoindexBinPath(), ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/** Resolve cocoindex binary path — checks PATH, uv tool bin path, then common mise locations. */
export function getCocoindexBinPath(): string {
  return resolveCocoindexBin();
}

function resolveCocoindexBin(): string {
  // Try PATH first.
  try {
    const resolved = execFileSync("sh", ["-c", "command -v cocoindex"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (resolved) return resolved;
  } catch {
    // Not on PATH
  }

  // uv tool install exposes binaries here by default.
  const uvToolBin = join(homedir(), ".local", "bin", "cocoindex");
  if (existsSync(uvToolBin)) return uvToolBin;

  // Try mise python installations.
  const miseRoot = join(homedir(), ".local", "share", "mise", "installs", "python");
  try {
    const versions = readdirSync(miseRoot).sort().reverse();
    for (const ver of versions) {
      const binPath = join(miseRoot, ver, "bin", "cocoindex");
      if (existsSync(binPath)) return binPath;
    }
  } catch {
    // mise not installed or no python versions
  }

  return "cocoindex"; // Fall back to PATH resolution
}

// ─────────────────────────────────────────────────────────
// Pipeline Management
// ─────────────────────────────────────────────────────────

/** Get the pipeline directory for a project. */
export function getPipelineDir(projectDir: string): string {
  return join(projectDir, DEFAULT_PIPELINE_DIR);
}

/** Check if a pipeline is already initialized. */
export async function isPipelineInitialized(pipelineDir: string): Promise<boolean> {
  return existsSync(join(pipelineDir, "main.py"));
}

/** Detect the target store from main.py content. */
export function detectTargetStore(pipelineDir: string): StatusInfo["targetStore"] {
  const mainPyPath = join(pipelineDir, "main.py");
  if (!existsSync(mainPyPath)) return "unknown";

  try {
    const content = readFileSync(mainPyPath, "utf-8");
    if (content.includes("LanceDB") || content.includes("lancedb")) return "lancedb";
    if (content.includes("Postgres") || content.includes("postgresql")) return "postgres";
    if (content.includes("Qdrant") || content.includes("qdrant")) return "qdrant";
    if (content.includes("SQLite") || content.includes("sqlite")) return "sqlite";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Initialize a cocoindex pipeline with default LanceDB target. */
export async function initPipeline(projectDir: string): Promise<{ success: boolean; error?: string }> {
  const pipelineDir = getPipelineDir(projectDir);

  // Create directory
  if (!existsSync(pipelineDir)) {
    mkdirSync(pipelineDir, { recursive: true });
  }

  // Don't overwrite existing pipeline
  if (existsSync(join(pipelineDir, "main.py"))) {
    return { success: true };
  }

  // Read embedding config from memory settings
  const embeddingConfig = loadEmbeddingConfig();

  const template = generatePipelineTemplate(projectDir, embeddingConfig);
  writeFileSync(join(pipelineDir, "main.py"), template, "utf-8");

  return { success: true };
}

// ─────────────────────────────────────────────────────────
// Indexing
// ─────────────────────────────────────────────────────────

/** Run cocoindex update to index the project. */
export async function indexProject(projectDir: string): Promise<IndexResult> {
  const available = await isAvailable();
  if (!available) {
    return {
      success: false,
      chunksProcessed: 0,
      durationMs: 0,
      error: "CocoIndex CLI not found. Run /unipi:cocoindex-init to install cocoindex[lancedb]>=1.0.",
    };
  }

  const pipelineDir = getPipelineDir(projectDir);
  if (!existsSync(join(pipelineDir, "main.py"))) {
    return {
      success: false,
      chunksProcessed: 0,
      durationMs: 0,
      error: "Pipeline not initialized. Run /unipi:cocoindex-init first.",
    };
  }

  const start = Date.now();

  const cocoindexBin = resolveCocoindexBin();

  return new Promise<IndexResult>((resolve) => {
    const proc = spawn(cocoindexBin, ["update", "main.py"], {
      cwd: pipelineDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeoutMs = getUpdateTimeoutMs();

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, 5000).unref();
    }, timeoutMs);
    timer.unref();

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const chunksProcessed = parseChunksProcessed(stdout);

      if (code === 0) {
        resolve({ success: true, chunksProcessed, durationMs });
      } else {
        resolve({
          success: false,
          chunksProcessed,
          durationMs,
          error: formatIndexFailure({ code, signal, timedOut, timeoutMs, stdout, stderr }),
        });
      }
    });

    proc.on("error", (err: Error) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        success: false,
        chunksProcessed: 0,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

/** Parse the number of files processed from cocoindex v1.0+ output. */
function getUpdateTimeoutMs(): number {
  const raw = process.env.COCOINDEX_UPDATE_TIMEOUT_MS;
  if (!raw) return DEFAULT_UPDATE_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPDATE_TIMEOUT_MS;
  return parsed;
}

function formatIndexFailure(args: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs: number;
  stdout: string;
  stderr: string;
}): string {
  const parts: string[] = [];

  if (args.timedOut) {
    parts.push(`Timed out after ${(args.timeoutMs / 1000).toFixed(0)}s`);
  } else if (args.signal) {
    parts.push(`Process terminated by ${args.signal}`);
  } else {
    parts.push(`Process exited with code ${args.code ?? "unknown"}`);
  }

  const stderr = tailText(args.stderr.trim(), 4000);
  const stdout = tailText(args.stdout.trim(), 2000);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (stdout) parts.push(`stdout:\n${stdout}`);

  return parts.join("\n\n");
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function parseChunksProcessed(output: string): number {
  // v1.0+ format: "✅ process_file: 604 total | 604 added"
  // Capture the last "added" or "reprocessed" count for process_file
  const lines = output.split("\n");
  let lastProcessLine: string | undefined;
  for (const line of lines) {
    if (line.includes("process_file:") && (line.includes("added") || line.includes("reprocessed"))) {
      lastProcessLine = line;
    }
  }
  if (lastProcessLine) {
    // Prefer completed work counts. Lines can contain multiple counters, e.g.
    // "process_file: 615 total | 8 added, 606 reprocessed".
    const matches = [...lastProcessLine.matchAll(/(\d+)\s+(?:added|reprocessed|skipped|deleted)/g)];
    const completed = matches.reduce((sum, match) => sum + parseInt(match[1], 10), 0);
    if (completed > 0) return completed;

    const total = lastProcessLine.match(/process_file:\s*(\d+)\s+total/);
    if (total) return parseInt(total[1], 10);
  }

  // Fallback: old format "Processed 42 chunks"
  const fallback = output.match(/processed\s+(\d+)\s+chunks?/i)
    ?? output.match(/(\d+)\s+chunks?\s+processed/i)
    ?? output.match(/indexed\s+(\d+)/i);
  return fallback ? parseInt(fallback[1], 10) : 0;
}

// ─────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────

/** Get indexing status for the project. */
export async function status(projectDir: string): Promise<StatusInfo> {
  const pipelineDir = getPipelineDir(projectDir);
  const cliAvailable = await isAvailable();
  const pipelineConfigured = existsSync(join(pipelineDir, "main.py"));
  const targetStore = detectTargetStore(pipelineDir);

  let docCount = 0;
  let lastRun: string | null = null;

  // Check LanceDB data for doc count and freshness
  const lancedbPath = join(pipelineDir, ".lancedb");
  if (existsSync(lancedbPath)) {
    try {
      const stat = statSync(lancedbPath);
      lastRun = stat.mtime.toISOString();
      // Count .lance files as a rough doc estimate
      const files = readdirSync(lancedbPath, { recursive: true });
      docCount = (files as string[]).filter((f) => f.endsWith(".lance")).length;
    } catch {
      // Non-fatal
    }
  }

  return {
    indexed: docCount > 0,
    lastRun,
    docCount,
    pipelineConfigured,
    cliAvailable,
    targetStore,
  };
}

// ─────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────

/** Search indexed content by querying LanceDB directly. */
export async function search(
  projectDir: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  try {
    const lancedbPath = join(getPipelineDir(projectDir), ".lancedb");
    if (!existsSync(lancedbPath)) {
      return [];
    }

    // Dynamic import — LanceDB SDK may not be installed.
    // @ts-ignore — optional dependency, may not be installed
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(lancedbPath);

    const tableNames = await db.tableNames();
    if (tableNames.length === 0) return [];

    const table = await db.openTable(tableNames[0]);

    // Prefer semantic vector search when the pipeline/table provides a vector
    // column. Older generated pipelines only contain path/chunk_index/content;
    // LanceDB throws for those tables, so continue to FTS fallback.
    const queryVector = await generateQueryEmbedding(query);
    if (queryVector) {
      const vectorResults = await vectorSearch(table, queryVector, limit, offset);
      if (vectorResults.length > 0) return vectorResults;
    }

    // Prefer LanceDB's native FTS when an inverted index exists on content.
    return fullTextSearch(table, query, limit, offset);
  } catch (err: any) {
    if (err?.code === "MODULE_NOT_FOUND" || err?.message?.includes("Cannot find module")) {
      return [{
        title: "Search Unavailable",
        content: "LanceDB SDK not installed. Install with: npm install @lancedb/lancedb",
        source: "",
        rank: 0,
        contentType: "prose",
        matchLayer: "fulltext",
      }];
    }
    return [{
      title: "Search Error",
      content: `CocoIndex LanceDB search failed: ${err?.message ?? String(err)}`,
      source: "",
      rank: 0,
      contentType: "prose",
      matchLayer: "fulltext",
    }];
  }
}

async function vectorSearch(table: any, queryVector: number[], limit: number, offset: number): Promise<SearchResult[]> {
  try {
    const results = await table.search(queryVector)
      .limit(limit + offset)
      .toArray();

    return results.slice(offset).map((r: any, i: number) => rowToSearchResult(r, i, "vector"));
  } catch {
    return [];
  }
}

/** Fallback full-text search when vector search isn't available. */
async function fullTextSearch(table: any, query: string, limit: number, offset: number): Promise<SearchResult[]> {
  try {
    const results = await table.search(query, "fts")
      .limit(limit + offset)
      .toArray();

    return results.slice(offset).map((r: any, i: number) => rowToSearchResult(r, i, "fulltext"));
  } catch {
    return [];
  }
}

function rowToSearchResult(r: any, i: number, matchLayer: SearchResult["matchLayer"]): SearchResult {
  const path = r.path ?? r.source ?? "";
  return {
    title: r.title ?? path ?? `Result ${i + 1}`,
    content: r.content ?? r.text ?? String(r),
    source: r.source ?? path ?? "",
    rank: r._distance ?? (1 - (r.score ?? 0)),
    contentType: (r.content_type === "code" || path?.match(/\.(ts|tsx|js|jsx|py|rs|go|sh|bash)$/)) ? "code" : "prose",
    matchLayer,
  };
}

// ─────────────────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────────────────

interface EmbeddingConfig {
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

/** Load embedding config — env var takes priority, then config file, then defaults. */
function loadEmbeddingConfig(): EmbeddingConfig {
  // Env var takes top priority
  const envKey = process.env.OPENROUTER_API_KEY ?? null;

  const configPath = join(homedir(), ".unipi", "memory", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      return {
        apiKey: envKey ?? config.openrouterApiKey ?? config.apiKey ?? null,
        model: config.embeddingModel ?? "qwen/qwen3-embedding-8b",
        baseUrl: config.openrouterBaseUrl ?? "https://openrouter.ai/api/v1",
      };
    }
  } catch {
    // Fall through to defaults
  }
  return {
    apiKey: envKey,
    model: "qwen/qwen3-embedding-8b",
    baseUrl: "https://openrouter.ai/api/v1",
  };
}

/** Generate embedding for a query using OpenRouter API. */
async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  const config = loadEmbeddingConfig();
  if (!config.apiKey) return null;

  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: query,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as any;
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Pipeline Template
// ─────────────────────────────────────────────────────────

/** Generate a cocoindex pipeline main.py template (v1.0+ API). */
function generatePipelineTemplate(projectDir: string, embeddingConfig: EmbeddingConfig): string {
  const projectBasename = projectDir.split("/").pop() ?? "project";
  return `"""
CocoIndex pipeline for ${projectBasename}
Auto-generated by @pi-unipi/cocoindex — customize as needed.
Requires cocoindex >= 1.0.
"""
import pathlib
from dataclasses import dataclass
from typing import AsyncIterator

import cocoindex as coco
from cocoindex.connectors import localfs, lancedb
from cocoindex.resources.file import PatternFilePathMatcher

import os

# ── Configuration ────────────────────────────────────
PROJECT_ROOT = os.environ.get("PROJECT_ROOT", "${projectDir}")
# Safety limit for huge generated/lock files. Set COCO_MAX_FILE_CHARS=0 to disable.
MAX_FILE_CHARS = int(os.environ.get("COCO_MAX_FILE_CHARS", "200000"))

# ── LanceDB context key ──────────────────────────────
db_key = coco.ContextKey("lancedb/${projectBasename}")


# ── Environment setup (async lifespan) ───────────────
@coco.lifespan
async def coco_lifespan(builder: coco.EnvironmentBuilder) -> AsyncIterator[None]:
    """Configure environment: DB path + LanceDB connection."""
    builder.settings.db_path = pathlib.Path(__file__).parent / "cocoindex.db"

    db_path = pathlib.Path(__file__).parent / ".lancedb"
    conn = await lancedb.connect_async(str(db_path))
    builder.provide(db_key, conn)

    yield


# ── Row type for LanceDB ─────────────────────────────
@dataclass
class IndexRow:
    """A single indexed chunk stored in LanceDB."""
    path: str
    chunk_index: int
    content: str


# ── Chunking function (memoized) ─────────────────────
@coco.fn
async def chunk_text(
    content: str,
    *,
    chunk_size: int = 1500,
    chunk_overlap: int = 200,
) -> list[tuple[int, str]]:
    """Split text into overlapping chunks."""
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
    if MAX_FILE_CHARS > 0 and len(content) > MAX_FILE_CHARS:
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
    """Walk project files -> chunk -> store in LanceDB."""
    project_root = pathlib.Path(PROJECT_ROOT)

    # 1) Declare LanceDB table target
    table_schema = await lancedb.TableSchema.from_class(
        IndexRow,
        primary_key=["path", "chunk_index"],
    )

    target = await coco.mount_target(
        lancedb.table_target(
            db_key,
            "${projectBasename}_index",
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
                "**/coverage/**", "**/.turbo/**", "**/.cache/**",
                "**/.unipi/**",
                "**/*.min.js", "**/bundled.js", "**/bundle.js", "**/*bundle*.js",
                "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
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
    coco.AppConfig(name="local_${projectBasename}"),
    app_main,
)
`;
}

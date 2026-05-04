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

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

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
  minScore?: number;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer: "vector" | "fulltext" | "hybrid";
}

export interface CocoindexDeps {
  projectDir: string;
  pipelineDir: string;
  initialized: boolean;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const COCOINDEX_STATE_DIR = ".cocoindex";
const DEFAULT_PIPELINE_DIR = ".unipi/cocoindex";
const DEFAULT_LANCEDB_PATH = ".unipi/cocoindex/.lancedb";

// ─────────────────────────────────────────────────────────
// CLI Detection
// ─────────────────────────────────────────────────────────

let cachedAvailable: boolean | null = null;

/** Check if cocoindex CLI is installed and available. */
export async function isAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    const result = execSync("cocoindex --version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    cachedAvailable = result.trim().length > 0;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** Get cocoindex CLI version string. */
export async function getVersion(): Promise<string | null> {
  try {
    const result = execSync("cocoindex --version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
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
      error: "CocoIndex CLI not found. Install with: pip install cocoindex",
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

  return new Promise<IndexResult>((resolve) => {
    const proc = spawn("cocoindex", ["update", "main.py"], {
      cwd: pipelineDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300000, // 5 min timeout
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      const durationMs = Date.now() - start;
      const chunksProcessed = parseChunksProcessed(stdout);

      if (code === 0) {
        resolve({ success: true, chunksProcessed, durationMs });
      } else {
        resolve({
          success: false,
          chunksProcessed,
          durationMs,
          error: stderr.trim() || `Process exited with code ${code}`,
        });
      }
    });

    proc.on("error", (err: Error) => {
      resolve({
        success: false,
        chunksProcessed: 0,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

/** Parse the number of chunks processed from cocoindex output. */
function parseChunksProcessed(output: string): number {
  // Try to extract number from cocoindex output like "Processed 42 chunks"
  const match = output.match(/processed\s+(\d+)\s+chunks?/i)
    ?? output.match(/(\d+)\s+chunks?\s+processed/i)
    ?? output.match(/indexed\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
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

  // Try LanceDB SDK first
  try {
    const lancedbPath = join(getPipelineDir(projectDir), ".lancedb");
    if (!existsSync(lancedbPath)) {
      return [];
    }

    // Dynamic import — LanceDB SDK may not be installed
    // @ts-ignore — optional dependency, may not be installed
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(lancedbPath);

    // Get table names
    const tableNames = await db.tableNames();
    if (tableNames.length === 0) return [];

    const table = await db.openTable(tableNames[0]);

    // Generate embedding for the query using the same model as indexing
    const queryVector = await generateQueryEmbedding(query);
    if (!queryVector) {
      // Fall back to full-text search if embedding fails
      return fullTextSearch(table, query, limit);
    }

    // Vector search
    const results = await table.search(queryVector)
      .limit(limit)
      .toArray();

    return results.map((r: any, i: number) => ({
      title: r.title ?? r.path ?? `Result ${i + 1}`,
      content: r.content ?? r.text ?? String(r),
      source: r.source ?? r.path ?? "",
      rank: r._distance ?? (1 - (r.score ?? 0)),
      contentType: (r.content_type === "code" || r.path?.match(/\.(ts|js|py|rs|go)$/)) ? "code" as const : "prose" as const,
      matchLayer: "vector" as const,
    }));
  } catch (err: any) {
    // LanceDB not available or search failed — return empty rather than crash
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
    return [];
  }
}

/** Fallback full-text search when vector search isn't available. */
async function fullTextSearch(table: any, query: string, limit: number): Promise<SearchResult[]> {
  try {
    const results = await table.search(query, "fts")
      .limit(limit)
      .toArray();

    return results.map((r: any, i: number) => ({
      title: r.title ?? r.path ?? `Result ${i + 1}`,
      content: r.content ?? r.text ?? String(r),
      source: r.source ?? r.path ?? "",
      rank: r._distance ?? (1 - (r.score ?? 0)),
      contentType: "prose" as const,
      matchLayer: "fulltext" as const,
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────────────────

interface EmbeddingConfig {
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

/** Load embedding config from memory package settings. */
function loadEmbeddingConfig(): EmbeddingConfig {
  const configPath = join(homedir(), ".unipi", "memory", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      return {
        apiKey: config.openrouterApiKey ?? config.apiKey ?? null,
        model: config.embeddingModel ?? "openai/text-embedding-3-small",
        baseUrl: config.openrouterBaseUrl ?? "https://openrouter.ai/api/v1",
      };
    }
  } catch {
    // Fall through to defaults
  }
  return {
    apiKey: null,
    model: "openai/text-embedding-3-small",
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

/** Generate a cocoindex pipeline main.py template. */
function generatePipelineTemplate(projectDir: string, embeddingConfig: EmbeddingConfig): string {
  const projectBasename = projectDir.split("/").pop() ?? "project";
  return `"""
CocoIndex pipeline for ${projectBasename}
Auto-generated by @pi-unipi/cocoindex — customize as needed.
"""
import cocoindex
import os

# ── Source: Local files ────────────────────────────────
@cocoindex.flow_def("local_${projectBasename}")
def local_files_flow(flow_builder: cocoindex.FlowBuilder):
    # Index all text/code files from the project root
    project_root = os.environ.get("PROJECT_ROOT", "${projectDir}")

    source = flow_builder.add_source(
        cocoindex.sources.LocalFile(
            path=project_root,
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
        name="project_files",
    )

    # ── Transform: Extract text + chunk recursively ──────
    content = source.extract_text()  # Extract text from files

    # Chunk with AST-aware recursive splitting
    chunks = content.transform(
        cocoindex.transforms.SplitRecursively(),
        name="chunks",
        params={
            "chunk_size": 1500,
            "chunk_overlap": 200,
            "language": None,  # Auto-detect per file
        },
    )

    # ── Embed: Generate vector embeddings ────────────────
    embedded = chunks.embed(
        cocoindex.functions.EmbedText(
            model="${embeddingConfig.model}",
            api_type="openai",
            api_base_url="${embeddingConfig.baseUrl}",
        ),
        name="embeddings",
    )

    # ── Target: LanceDB (local, zero-config) ─────────────
    embedded.export(
        cocoindex.targets.LanceDB(
            uri=os.path.join(os.path.dirname(__file__), ".lancedb"),
            table_name="${projectBasename}_index",
        ),
        name="lancedb_store",
    )
`;
}

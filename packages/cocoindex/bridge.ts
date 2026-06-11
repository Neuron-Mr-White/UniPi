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
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

const DEFAULT_PIPELINE_DIR = ".unipi/cocoindex";
const DEFAULT_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_LEXICAL_SCAN_LIMIT = 50_000;

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
	const match = versionStr.match(
		/(?:^|[^0-9])(\d+\.\d+(?:\.\d+)?)(?:[^0-9]|$)/,
	);
	return match?.[1] ?? null;
}

/** Compare semver-ish strings. Missing/invalid versions are not acceptable. */
export function isVersionAtLeast(
	version: string | null | undefined,
	minimum = COCOINDEX_MIN_VERSION,
): boolean {
	const parsed = version ? parseVersion(version) : null;
	const parsedMinimum = parseVersion(minimum);
	if (!parsed || !parsedMinimum) return false;

	const actualParts = parsed
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	const minParts = parsedMinimum
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	const len = Math.max(actualParts.length, minParts.length, 3);

	for (let i = 0; i < len; i++) {
		const actual = actualParts[i] ?? 0;
		const min = minParts[i] ?? 0;
		if (!Number.isFinite(actual) || !Number.isFinite(min)) return false;
		if (actual > min) return true;
		if (actual < min) return false;
	}
	return true;
}

/** Reset cached availability, used after installer mutations. */
export function resetAvailabilityCache(): void {
	cachedAvailable = null;
}

/** Check if cocoindex CLI is installed and available. */
export async function isAvailable(
	options: AvailabilityOptions = {},
): Promise<boolean> {
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
	const miseRoot = join(
		homedir(),
		".local",
		"share",
		"mise",
		"installs",
		"python",
	);
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
export async function isPipelineInitialized(
	pipelineDir: string,
): Promise<boolean> {
	return existsSync(join(pipelineDir, "main.py"));
}

/** Detect the target store from main.py content. */
export function detectTargetStore(
	pipelineDir: string,
): StatusInfo["targetStore"] {
	const mainPyPath = join(pipelineDir, "main.py");
	if (!existsSync(mainPyPath)) return "unknown";

	try {
		const content = readFileSync(mainPyPath, "utf-8");
		if (content.includes("LanceDB") || content.includes("lancedb"))
			return "lancedb";
		if (content.includes("Postgres") || content.includes("postgresql"))
			return "postgres";
		if (content.includes("Qdrant") || content.includes("qdrant"))
			return "qdrant";
		if (content.includes("SQLite") || content.includes("sqlite"))
			return "sqlite";
		return "unknown";
	} catch {
		return "unknown";
	}
}

/** Initialize a cocoindex pipeline with default LanceDB target. */
export async function initPipeline(
	projectDir: string,
): Promise<{ success: boolean; error?: string }> {
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
			error:
				"CocoIndex CLI not found. Run /unipi:cocoindex-init to install cocoindex[lancedb]>=1.0.",
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
					error: formatIndexFailure({
						code,
						signal,
						timedOut,
						timeoutMs,
						stdout,
						stderr,
					}),
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
		if (
			line.includes("process_file:") &&
			(line.includes("added") || line.includes("reprocessed"))
		) {
			lastProcessLine = line;
		}
	}
	if (lastProcessLine) {
		// Prefer completed work counts. Lines can contain multiple counters, e.g.
		// "process_file: 615 total | 8 added, 606 reprocessed".
		const matches = [
			...lastProcessLine.matchAll(
				/(\d+)\s+(?:added|reprocessed|skipped|deleted)/g,
			),
		];
		const completed = matches.reduce(
			(sum, match) => sum + parseInt(match[1], 10),
			0,
		);
		if (completed > 0) return completed;

		const total = lastProcessLine.match(/process_file:\s*(\d+)\s+total/);
		if (total) return parseInt(total[1], 10);
	}

	// Fallback: old format "Processed 42 chunks"
	const fallback =
		output.match(/processed\s+(\d+)\s+chunks?/i) ??
		output.match(/(\d+)\s+chunks?\s+processed/i) ??
		output.match(/indexed\s+(\d+)/i);
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
		const lancedb = await import("@lancedb/lancedb");
		const db = await lancedb.connect(lancedbPath);

		const tableNames = await db.tableNames();
		if (tableNames.length === 0) return [];

		const table = await db.openTable(tableNames[0]);

		// Prefer semantic vector search when the pipeline/table provides a vector
		// column. Older generated pipelines only contain path/chunk_index/content;
		// LanceDB throws for those tables, so continue to FTS/lexical fallback.
		const queryVector = await generateQueryEmbedding(query);
		if (queryVector) {
			const vectorResults = await vectorSearch(
				table,
				queryVector,
				limit,
				offset,
			);
			if (vectorResults.length > 0) return vectorResults;
		}

		// Prefer LanceDB's native FTS when an inverted index exists on content.
		const ftsResults = await fullTextSearch(table, query, limit, offset);
		if (ftsResults.length > 0) return ftsResults;

		// Last-resort compatibility path for existing text-only LanceDB tables.
		// This keeps indexed projects searchable immediately instead of returning
		// a misleading "run cocoindex-update" message when no vector/FTS index is
		// available yet.
		return lexicalSearch(table, query, limit, offset);
	} catch (err: any) {
		if (
			err?.code === "MODULE_NOT_FOUND" ||
			err?.message?.includes("Cannot find module")
		) {
			return [
				{
					title: "Search Unavailable",
					content:
						"LanceDB SDK not installed. Install with: npm install @lancedb/lancedb",
					source: "",
					rank: 0,
					contentType: "prose",
					matchLayer: "fulltext",
				},
			];
		}
		return [
			{
				title: "Search Error",
				content: `CocoIndex LanceDB search failed: ${err?.message ?? String(err)}`,
				source: "",
				rank: 0,
				contentType: "prose",
				matchLayer: "fulltext",
			},
		];
	}
}

async function vectorSearch(
	table: any,
	queryVector: number[],
	limit: number,
	offset: number,
): Promise<SearchResult[]> {
	try {
		const results = await table
			.search(queryVector)
			.limit(limit + offset)
			.toArray();

		return results
			.slice(offset)
			.map((r: any, i: number) => rowToSearchResult(r, i, "vector"));
	} catch {
		return [];
	}
}

/** Fallback full-text search when vector search isn't available. */
async function fullTextSearch(
	table: any,
	query: string,
	limit: number,
	offset: number,
): Promise<SearchResult[]> {
	try {
		const results = await table
			.search(query, "fts")
			.limit(limit + offset)
			.toArray();

		return results
			.slice(offset)
			.map((r: any, i: number) => rowToSearchResult(r, i, "fulltext"));
	} catch {
		return [];
	}
}

/**
 * Compatibility fallback for existing LanceDB tables that contain text chunks
 * but no vector column or full-text inverted index.
 */
async function lexicalSearch(
	table: any,
	query: string,
	limit: number,
	offset: number,
): Promise<SearchResult[]> {
	try {
		const terms = tokenize(query);
		if (terms.length === 0) return [];

		const rows = await table
			.query()
			.limit(DEFAULT_LEXICAL_SCAN_LIMIT)
			.toArray();

		const phrase = query.trim().toLowerCase();
		const scored = rows
			.map((row: any) => {
				const content = String(row.content ?? row.text ?? "");
				const path = String(row.path ?? row.source ?? "");
				const haystack = `${path}\n${content}`.toLowerCase();
				let score = 0;

				for (const term of terms) {
					const contentMatches = countOccurrences(content.toLowerCase(), term);
					const pathMatches = countOccurrences(path.toLowerCase(), term);
					score += contentMatches + pathMatches * 3;
				}

				if (phrase && haystack.includes(phrase)) score += terms.length * 4;
				return { row, score };
			})
			.filter((item: { score: number }) => item.score > 0)
			.sort((a: { score: number }, b: { score: number }) => b.score - a.score)
			.slice(offset, offset + limit);

		return scored.map((item: { row: any; score: number }, i: number) => ({
			...rowToSearchResult(item.row, i, "fulltext"),
			rank: item.score,
		}));
	} catch {
		return [];
	}
}

function rowToSearchResult(
	r: any,
	i: number,
	matchLayer: SearchResult["matchLayer"],
): SearchResult {
	const path = r.path ?? r.source ?? "";
	return {
		title: r.title ?? path ?? `Result ${i + 1}`,
		content: r.content ?? r.text ?? String(r),
		source: r.source ?? path ?? "",
		rank: r._distance ?? 1 - (r.score ?? 0),
		contentType:
			r.content_type === "code" ||
			path?.match(/\.(ts|tsx|js|jsx|py|rs|go|sh|bash)$/)
				? "code"
				: "prose",
		matchLayer,
	};
}

function tokenize(query: string): string[] {
	const seen = new Set<string>();
	const stopwords = new Set([
		"a",
		"an",
		"and",
		"are",
		"as",
		"at",
		"for",
		"from",
		"how",
		"in",
		"is",
		"of",
		"on",
		"or",
		"the",
		"to",
		"with",
	]);
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9_+#.-]+/i)
		.map((term) => term.trim())
		.filter((term) => term.length > 1 && !stopwords.has(term));

	return terms.filter((term) => {
		if (seen.has(term)) return false;
		seen.add(term);
		return true;
	});
}

function countOccurrences(value: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = value.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = value.indexOf(needle, index + needle.length);
	}
	return count;
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
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: config.model,
				input: query,
			}),
		});

		if (!response.ok) return null;

		const data = (await response.json()) as any;
		return data.data?.[0]?.embedding ?? null;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────
// Pipeline Template
// ─────────────────────────────────────────────────────────

/** Generate a cocoindex pipeline main.py from the external template. */
function generatePipelineTemplate(
	projectDir: string,
	_embeddingConfig: EmbeddingConfig,
): string {
	const projectBasename = projectDir.split("/").pop() ?? "project";
	const templateUrl = new URL("./pipeline-template.py", import.meta.url);
	let template = readFileSync(templateUrl, "utf-8");

	// Replace template configuration lines with hardcoded values
	template = template.replace(
		/^PROJECT_BASENAME = .+$/m,
		`PROJECT_BASENAME = "${projectBasename}"`,
	);
	template = template.replace(
		/^PROJECT_DIR = .+$/m,
		`PROJECT_DIR = "${projectDir}"`,
	);

	// Replace the docstring to match project name
	template = template.replace(
		/^"""CocoIndex pipeline template\./m,
		`"""CocoIndex pipeline for ${projectBasename}.`,
	);

	return template;
}

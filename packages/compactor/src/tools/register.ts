/**
 * Tool registration — register all compactor tools with Pi's ExtensionAPI
 *
 * Each tool is registered via pi.registerTool() with proper TypeBox schemas
 * so the LLM can discover and invoke them.
 *
 * New naming convention (v0.2.0):
 *   compact, session_recall, sandbox, sandbox_file, sandbox_batch,
 *   content_index, content_search, content_fetch, compactor_stats, compactor_doctor
 *
 * Old names kept as deprecated aliases for backward compatibility:
 *   vcc_recall, ctx_execute, ctx_execute_file, ctx_batch_execute,
 *   ctx_index, ctx_search, ctx_fetch_and_index, ctx_stats, ctx_doctor
 */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { compactTool } from "./compact.js";
import { vccRecall, type RecallInput } from "./vcc-recall.js";
import { ctxExecute, type CtxExecuteInput } from "./ctx-execute.js";
import { ctxExecuteFile, type CtxExecuteFileInput } from "./ctx-execute-file.js";
import { ctxBatchExecute, type BatchItem } from "./ctx-batch-execute.js";
import { ctxIndex, type CtxIndexInput } from "./ctx-index.js";
import { ctxSearch, type CtxSearchInput } from "./ctx-search.js";
import { ctxFetchAndIndex, type CtxFetchAndIndexInput } from "./ctx-fetch-and-index.js";
import { ctxStats, type CtxStatsResult } from "./ctx-stats.js";
import { ctxDoctor, type DoctorResult } from "./ctx-doctor.js";
import { contextBudgetTool } from "./context-budget.js";
import type { SessionDB } from "../session/db.js";
import type { ContentStore } from "../store/index.js";
import type { NormalizedBlock, RuntimeCounters } from "../types.js";

// --- TypeBox Schemas for each tool ---

const LanguageSchema = Type.Union([
  Type.Literal("javascript"),
  Type.Literal("typescript"),
  Type.Literal("python"),
  Type.Literal("shell"),
  Type.Literal("ruby"),
  Type.Literal("go"),
  Type.Literal("rust"),
  Type.Literal("php"),
  Type.Literal("perl"),
  Type.Literal("r"),
  Type.Literal("elixir"),
]);

const CompactParams = Type.Object({
  dryRun: Type.Optional(Type.Boolean({ description: "If true, report what would be compacted without actually compacting" })),
});

const RecallParams = Type.Object({
  query: Type.String({ description: "Search query for session history" }),
  mode: Type.Optional(Type.Union([Type.Literal("bm25"), Type.Literal("regex")], {
    description: "Search mode: bm25 (default) or regex fallback",
  })),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)", minimum: 1 })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset", minimum: 0 })),
  expand: Type.Optional(Type.Boolean({ description: "Return full message content for hits" })),
});

const SandboxParams = Type.Object({
  language: LanguageSchema,
  code: Type.String({ description: "Code to execute in the sandbox" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)", minimum: 1000 })),
});

const SandboxFileParams = Type.Object({
  language: LanguageSchema,
  path: Type.String({ description: "Path to file to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)", minimum: 1000 })),
});

const SandboxBatchParams = Type.Object({
  items: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("execute"),
        language: LanguageSchema,
        code: Type.String(),
        timeout: Type.Optional(Type.Number()),
      }),
      Type.Object({
        type: Type.Literal("search"),
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
    ]),
    { description: "Array of execute or search commands to run atomically" },
  ),
});

const ContentIndexParams = Type.Object({
  label: Type.String({ description: "Label for the indexed content" }),
  content: Type.Optional(Type.String({ description: "Content to index (or use filePath)" })),
  filePath: Type.Optional(Type.String({ description: "Path to file to index" })),
  contentType: Type.Optional(Type.Union([
    Type.Literal("markdown"),
    Type.Literal("json"),
    Type.Literal("plain"),
  ], { description: "Content type for chunking strategy" })),
  chunkSize: Type.Optional(Type.Number({ description: "Chunk size in characters", minimum: 100 })),
});

const ContentSearchParams = Type.Object({
  query: Type.String({ description: "Search query against indexed content" }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1 })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset", minimum: 0 })),
});

const ContentFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch, convert to markdown, and index" }),
  label: Type.Optional(Type.String({ description: "Label for the indexed content" })),
  chunkSize: Type.Optional(Type.Number({ description: "Chunk size in characters", minimum: 100 })),
});

const StatsParams = Type.Object({});

const DoctorParams = Type.Object({});

// --- Helpers ---

function textResult(text: string, details?: Record<string, unknown>): any {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function jsonResult(data: unknown, label?: string): any {
  const text = label ? `${label}:\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    details: data as Record<string, unknown>,
  };
}

/** Log a deprecation warning when old tool names are used. */
function deprecationLog(oldName: string, newName: string): void {
  console.error(`[compactor] DEPRECATED: Tool "${oldName}" used — use "${newName}" instead.`);
}

// --- Old schema names for backward compat aliases ---

const VccRecallParams = RecallParams;
const CtxExecuteParams = SandboxParams;
const CtxExecuteFileParams = SandboxFileParams;
const CtxBatchExecuteParams = SandboxBatchParams;
const CtxIndexParams = ContentIndexParams;
const CtxSearchParams = ContentSearchParams;
const CtxFetchAndIndexParams = ContentFetchParams;
const CtxStatsParams = StatsParams;
const CtxDoctorParams = DoctorParams;

// --- Registration ---

export interface CompactorToolDeps {
  sessionDB: SessionDB;
  contentStore: ContentStore | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
}

/** Helper to register a tool under a new name and an old deprecated alias. */
function registerToolWithAlias(
  pi: ExtensionAPI,
  newName: string,
  oldName: string,
  definition: Parameters<ExtensionAPI["registerTool"]>[0],
): void {
  // Register under new (primary) name
  pi.registerTool({ ...definition, name: newName });

  // Also register under old name as deprecated alias
  pi.registerTool({
    ...definition,
    name: oldName,
    description: `${definition.description} (DEPRECATED: use "${newName}" instead)`,
    execute: async (_toolCallId?: string, ...args: any[]) => {
      deprecationLog(oldName, newName);
      return (definition as any).execute(_toolCallId, ...args);
    },
  });
}

/**
 * Register all compactor tools with Pi's ExtensionAPI.
 * Call this during session_start after services are initialized.
 */
export function registerCompactorTools(pi: ExtensionAPI, deps: CompactorToolDeps): void {
  // 1. compact — trigger manual compaction (with optional dryRun)
  pi.registerTool({
    name: "compact",
    label: "Compact",
    description: "Trigger manual context compaction. Reduces session history while preserving continuity. Use dryRun:true to preview without compacting.",
    parameters: CompactParams,
    async execute(_toolCallId, params: Static<typeof CompactParams>): Promise<any> {
      if (params.dryRun) {
        const blocks = deps.getBlocks();
        const totalMessages = blocks.length;
        const estimated = Math.round(totalMessages * 0.15); // ~15% kept is typical
        return jsonResult({
          dryRun: true,
          wouldCompact: totalMessages,
          estimatedKept: estimated,
          message: `Would compact ${totalMessages} messages → ~${estimated} kept.`,
        }, "Dry run — no compaction performed");
      }
      const c = deps.getCounters?.();
      if (c) { c.compactions++; }
      const result = compactTool();
      return jsonResult(result, "Compaction triggered");
    },
  });

  // 2. session_recall (new) / vcc_recall (deprecated) — search session history
  const recallDefinition = {
    label: "Session Recall",
    description:
      "Search session history using BM25 or regex. Find previous goals, files, commits, and context.",
    parameters: RecallParams,
    async execute(_toolCallId: string, params: Static<typeof RecallParams>): Promise<any> {
      const c = deps.getCounters?.();
      if (c) { c.recallQueries++; }
      const blocks = deps.getBlocks();
      const input: RecallInput = {
        query: params.query,
        mode: params.mode,
        limit: params.limit,
        offset: params.offset,
        expand: params.expand,
      };
      const result = vccRecall(blocks, input);
      if (result.hits.length === 0) {
        return textResult(`No results found for "${result.query}".`);
      }
      const lines = result.hits.map(
        (h, i) =>
          `[${i + 1}/${result.total}] score=${h.score.toFixed(2)} kind=${h.kind}\n${h.text}`,
      );
      return textResult(
        `Found ${result.total} results for "${result.query}":\n\n${lines.join("\n\n")}`,
        result as unknown as Record<string, unknown>,
      );
    },
  };
  registerToolWithAlias(pi, "session_recall", "vcc_recall", recallDefinition);

  // 3. sandbox (new) / ctx_execute (deprecated) — run code in sandbox
  const sandboxDefinition = {
    label: "Sandbox",
    description:
      "Run code in a sandboxed environment. Supports 11 languages. Only stdout enters context.",
    parameters: SandboxParams,
    async execute(_toolCallId: string, params: Static<typeof SandboxParams>): Promise<any> {
      try {
        const c = deps.getCounters?.();
        if (c) { c.sandboxRuns++; }
        const result = await ctxExecute(params as CtxExecuteInput);
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
        if (result.timedOut) parts.push("[timed out]");
        if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
        return textResult(parts.join("\n") || "(no output)", result as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`Execution error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "sandbox", "ctx_execute", sandboxDefinition);

  // 4. sandbox_file (new) / ctx_execute_file (deprecated) — execute file
  const sandboxFileDefinition = {
    label: "Sandbox File",
    description: "Execute a file in the sandbox. File content is injected as FILE_CONTENT variable.",
    parameters: SandboxFileParams,
    async execute(_toolCallId: string, params: Static<typeof SandboxFileParams>): Promise<any> {
      try {
        const c = deps.getCounters?.();
        if (c) { c.sandboxRuns++; }
        const result = await ctxExecuteFile(params as CtxExecuteFileInput);
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
        if (result.timedOut) parts.push("[timed out]");
        return textResult(parts.join("\n") || "(no output)", result as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`Execution error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "sandbox_file", "ctx_execute_file", sandboxFileDefinition);

  // 5. sandbox_batch (new) / ctx_batch_execute (deprecated) — atomic batch
  const sandboxBatchDefinition = {
    label: "Sandbox Batch",
    description: "Run multiple code executions and searches atomically as a batch.",
    parameters: SandboxBatchParams,
    async execute(_toolCallId: string, params: Static<typeof SandboxBatchParams>): Promise<any> {
      try {
        const c = deps.getCounters?.();
        if (c) { c.sandboxRuns++; c.searchQueries++; }
        const result = await ctxBatchExecute(deps.contentStore!, params.items as BatchItem[]);
        const summaries = result.results.map((r, i) => {
          if (r.type === "execute") {
            const s = r.result.stdout?.slice(0, 200) || "(no output)";
            return `[${i}] execute → ${r.result.exitCode === 0 ? "ok" : "fail"}: ${s}`;
          }
          return `[${i}] search → ${r.results.length} results`;
        });
        return textResult(`Batch results (${result.results.length} items):\n${summaries.join("\n")}`, result as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`Batch error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "sandbox_batch", "ctx_batch_execute", sandboxBatchDefinition);

  // 6. content_index (new) / ctx_index (deprecated) — index content into FTS5
  const contentIndexDefinition = {
    label: "Content Index",
    description: "Chunk content or a file and index into FTS5 for fast search.",
    parameters: ContentIndexParams,
    async execute(_toolCallId: string, params: Static<typeof ContentIndexParams>): Promise<any> {
      try {
        const result = await ctxIndex(deps.contentStore!, params as CtxIndexInput);
        return textResult(
          `Indexed "${result.label}": ${result.totalChunks} chunks (${result.codeChunks} code)`,
          result as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return textResult(`Index error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "content_index", "ctx_index", contentIndexDefinition);

  // 7. content_search (new) / ctx_search (deprecated) — query FTS5 content store
  const contentSearchDefinition = {
    label: "Content Search",
    description: "Search indexed content using FTS5 full-text search.",
    parameters: ContentSearchParams,
    async execute(_toolCallId: string, params: Static<typeof ContentSearchParams>): Promise<any> {
      try {
        const c = deps.getCounters?.();
        if (c) { c.searchQueries++; }
        const results = await ctxSearch(deps.contentStore!, params as CtxSearchInput);
        if (results.length === 0) {
          return textResult(`No results for "${params.query}".`);
        }
        const lines = results.map(
          (r, i) =>
            `[${i + 1}] ${r.title} (rank: ${r.rank.toFixed(3)})\n${r.content.slice(0, 300)}`,
        );
        return textResult(
          `Found ${results.length} results:\n\n${lines.join("\n\n")}`,
          { results } as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return textResult(`Search error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "content_search", "ctx_search", contentSearchDefinition);

  // 8. content_fetch (new) / ctx_fetch_and_index (deprecated) — fetch URL
  const contentFetchDefinition = {
    label: "Content Fetch",
    description: "Fetch a URL, convert to markdown, and index into FTS5 content store.",
    parameters: ContentFetchParams,
    async execute(_toolCallId: string, params: Static<typeof ContentFetchParams>): Promise<any> {
      try {
        const result = await ctxFetchAndIndex(deps.contentStore!, params as CtxFetchAndIndexInput);
        return textResult(
          `Fetched and indexed "${result.label}": ${result.totalChunks} chunks`,
          result as unknown as Record<string, unknown>,
        );
      } catch (err) {
        return textResult(`Fetch error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "content_fetch", "ctx_fetch_and_index", contentFetchDefinition);

  // 9. compactor_stats (new) / ctx_stats (deprecated) — context savings dashboard
  const statsDefinition = {
    label: "Compactor Stats",
    description: "Show context savings dashboard — session events, compactions, indexed content.",
    parameters: StatsParams,
    async execute(): Promise<any> {
      try {
        const result = await ctxStats(deps.sessionDB, deps.contentStore!, deps.getSessionId(), deps.getCounters?.());
        const lines = [
          `📊 Compactor Stats`,
          `Session events: ${result.sessionEvents}`,
          `Compactions: ${result.compactions}`,
          `Tokens saved: ${result.tokensSaved}`,
          `Indexed docs: ${result.indexedDocs} (${result.indexedChunks} chunks)`,
          `Sandbox runs: ${result.sandboxRuns}`,
          `Search queries: ${result.searchQueries}`,
        ];
        return textResult(lines.join("\n"), result as unknown as Record<string, unknown>);
      } catch (err) {
        return textResult(`Stats error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "compactor_stats", "ctx_stats", statsDefinition);

  // 10. compactor_doctor (new) / ctx_doctor (deprecated) — diagnostics checklist
  const doctorDefinition = {
    label: "Compactor Doctor",
    description: "Run diagnostics checklist — validate config, DB, FTS5, runtimes.",
    parameters: DoctorParams,
    async execute(): Promise<any> {
      try {
        const result = await ctxDoctor(deps.sessionDB, deps.contentStore!);
        const icon = (s: string) => (s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌");
        const lines = [
          result.healthy ? "🩺 All checks passed" : "🩺 Issues found",
          "",
          ...result.checks.map((c) => `${icon(c.status)} ${c.name}: ${c.message}`),
        ];
        return jsonResult(result, lines.join("\n"));
      } catch (err) {
        return textResult(`Doctor error: ${err}`, { error: true });
      }
    },
  };
  registerToolWithAlias(pi, "compactor_doctor", "ctx_doctor", doctorDefinition);

  // 11. context_budget — estimate remaining context window
  pi.registerTool({
    name: "context_budget",
    label: "Context Budget",
    description: "Estimate remaining context window (% full, tokens left) and get advice on whether to compact.",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      // TokensBefore is not directly available here from the tool deps.
      // The tool provides a best-effort estimate based on session blocks.
      const blocks = deps.getBlocks();
      const estimatedTokens = blocks.reduce((sum, b) => {
        const text = b.kind === "tool_call"
          ? `${b.name} ${JSON.stringify((b as any).args ?? {})}`
          : b.kind === "tool_result"
            ? `${b.name} ${(b as any).text ?? ""}`
            : (b as any).text ?? "";
        return sum + Math.ceil(text.length / 4);
      }, 0);
      const message = contextBudgetTool(estimatedTokens);
      return textResult(message);
    },
  });
}

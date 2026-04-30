/**
 * Tool registration — register all compactor tools with Pi's ExtensionAPI
 *
 * Each tool is registered via pi.registerTool() with proper TypeBox schemas
 * so the LLM can discover and invoke them.
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

const CompactParams = Type.Object({});

const VccRecallParams = Type.Object({
  query: Type.String({ description: "Search query for session history" }),
  mode: Type.Optional(Type.Union([Type.Literal("bm25"), Type.Literal("regex")], {
    description: "Search mode: bm25 (default) or regex fallback",
  })),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)", minimum: 1 })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset", minimum: 0 })),
  expand: Type.Optional(Type.Boolean({ description: "Return full message content for hits" })),
});

const CtxExecuteParams = Type.Object({
  language: LanguageSchema,
  code: Type.String({ description: "Code to execute in the sandbox" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)", minimum: 1000 })),
});

const CtxExecuteFileParams = Type.Object({
  language: LanguageSchema,
  path: Type.String({ description: "Path to file to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)", minimum: 1000 })),
});

const CtxBatchExecuteParams = Type.Object({
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

const CtxIndexParams = Type.Object({
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

const CtxSearchParams = Type.Object({
  query: Type.String({ description: "Search query against indexed content" }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)", minimum: 1 })),
  offset: Type.Optional(Type.Number({ description: "Pagination offset", minimum: 0 })),
});

const CtxFetchAndIndexParams = Type.Object({
  url: Type.String({ description: "URL to fetch, convert to markdown, and index" }),
  label: Type.Optional(Type.String({ description: "Label for the indexed content" })),
  chunkSize: Type.Optional(Type.Number({ description: "Chunk size in characters", minimum: 100 })),
});

const CtxStatsParams = Type.Object({});

const CtxDoctorParams = Type.Object({});

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

// --- Registration ---

export interface CompactorToolDeps {
  sessionDB: SessionDB;
  contentStore: ContentStore | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
}

/**
 * Register all compactor tools with Pi's ExtensionAPI.
 * Call this during session_start after services are initialized.
 */
export function registerCompactorTools(pi: ExtensionAPI, deps: CompactorToolDeps): void {
  // 1. compact — trigger manual compaction
  pi.registerTool({
    name: "compact",
    label: "Compact",
    description: "Trigger manual context compaction. Reduces session history while preserving continuity.",
    parameters: CompactParams,
    async execute(): Promise<any> {
      const c = deps.getCounters?.();
      if (c) { c.compactions++; }
      const result = compactTool();
      return jsonResult(result, "Compaction triggered");
    },
  });

  // 2. vcc_recall — search session history
  pi.registerTool({
    name: "vcc_recall",
    label: "Recall",
    description:
      "Search session history using BM25 or regex. Find previous goals, files, commits, and context.",
    parameters: VccRecallParams,
    async execute(_toolCallId, params: Static<typeof VccRecallParams>): Promise<any> {
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
  });

  // 3. ctx_execute — run code in sandbox
  pi.registerTool({
    name: "ctx_execute",
    label: "Execute",
    description:
      "Run code in a sandboxed environment. Supports 11 languages. Only stdout enters context.",
    parameters: CtxExecuteParams,
    async execute(_toolCallId, params: Static<typeof CtxExecuteParams>): Promise<any> {
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
  });

  // 4. ctx_execute_file — execute file with FILE_CONTENT
  pi.registerTool({
    name: "ctx_execute_file",
    label: "Execute File",
    description: "Execute a file in the sandbox. File content is injected as FILE_CONTENT variable.",
    parameters: CtxExecuteFileParams,
    async execute(_toolCallId, params: Static<typeof CtxExecuteFileParams>): Promise<any> {
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
  });

  // 5. ctx_batch_execute — atomic batch
  pi.registerTool({
    name: "ctx_batch_execute",
    label: "Batch Execute",
    description: "Run multiple code executions and searches atomically as a batch.",
    parameters: CtxBatchExecuteParams,
    async execute(_toolCallId, params: Static<typeof CtxBatchExecuteParams>): Promise<any> {
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
  });

  // 6. ctx_index — index content into FTS5
  pi.registerTool({
    name: "ctx_index",
    label: "Index",
    description: "Chunk content or a file and index into FTS5 for fast search.",
    parameters: CtxIndexParams,
    async execute(_toolCallId, params: Static<typeof CtxIndexParams>): Promise<any> {
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
  });

  // 7. ctx_search — query FTS5 content store
  pi.registerTool({
    name: "ctx_search",
    label: "Search",
    description: "Search indexed content using FTS5 full-text search.",
    parameters: CtxSearchParams,
    async execute(_toolCallId, params: Static<typeof CtxSearchParams>): Promise<any> {
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
  });

  // 8. ctx_fetch_and_index — fetch URL → markdown → index
  pi.registerTool({
    name: "ctx_fetch_and_index",
    label: "Fetch & Index",
    description: "Fetch a URL, convert to markdown, and index into FTS5 content store.",
    parameters: CtxFetchAndIndexParams,
    async execute(_toolCallId, params: Static<typeof CtxFetchAndIndexParams>): Promise<any> {
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
  });

  // 9. ctx_stats — context savings dashboard
  pi.registerTool({
    name: "ctx_stats",
    label: "Stats",
    description: "Show context savings dashboard — session events, compactions, indexed content.",
    parameters: CtxStatsParams,
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
  });

  // 10. ctx_doctor — diagnostics checklist
  pi.registerTool({
    name: "ctx_doctor",
    label: "Doctor",
    description: "Run diagnostics checklist — validate config, DB, FTS5, runtimes.",
    parameters: CtxDoctorParams,
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
  });
}

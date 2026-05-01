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
function deprecationLog(_oldName: string, _newName: string): void {
  // Deprecation logging disabled — was writing to stdout causing TUI rendering issues.
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

/**
 * Register all compactor tools with Pi's ExtensionAPI.
 * Call this during session_start after services are initialized.
 */
export function registerCompactorTools(pi: ExtensionAPI, deps: CompactorToolDeps): void {
  // 1. compact — trigger manual compaction (with optional dryRun)
  pi.registerTool(({
    name: "compact",
    label: "Compact",
    description: "Trigger manual context compaction. Reduces session history while preserving continuity. Use dryRun:true to preview without compacting.",
    parameters: CompactParams,
    async execute(_toolCallId: string, params: any): Promise<any> {
      if (params.dryRun) {
        const blocks = deps.getBlocks();
        const totalMessages = blocks.length;
        const estimated = Math.round(totalMessages * 0.15);
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
  } as any));

  // 2. session_recall (new) / vcc_recall (deprecated) — search session history
  const recallExec = async (_toolCallId: string, params: any): Promise<any> => {
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
  };
  pi.registerTool({ name: "session_recall", label: "Session Recall", description: "Search session history using BM25 or regex. Find previous goals, files, commits, and context.", parameters: RecallParams, execute: recallExec } as any);
  pi.registerTool({ name: "vcc_recall", label: "Session Recall", description: "Search session history using BM25 or regex. (DEPRECATED: use session_recall instead)", parameters: VccRecallParams, async execute(tcId: string, p: any) { deprecationLog("vcc_recall", "session_recall"); return recallExec(tcId, p); } } as any);

  // 3. sandbox (new) / ctx_execute (deprecated) — run code in sandbox
  const sandboxExec = async (_toolCallId: string, params: any): Promise<any> => {
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
  };
  pi.registerTool({ name: "sandbox", label: "Sandbox", description: "Run code in a sandboxed environment. Supports 11 languages. Only stdout enters context.", parameters: SandboxParams, execute: sandboxExec } as any);
  pi.registerTool({ name: "ctx_execute", label: "Sandbox", description: "Run code in sandbox. (DEPRECATED: use sandbox instead)", parameters: CtxExecuteParams, async execute(tcId: string, p: any) { deprecationLog("ctx_execute", "sandbox"); return sandboxExec(tcId, p); } } as any);

  // 4. sandbox_file (new) / ctx_execute_file (deprecated) — execute file
  const sandboxFileExec = async (_toolCallId: string, params: any): Promise<any> => {
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
  };
  pi.registerTool({ name: "sandbox_file", label: "Sandbox File", description: "Execute a file in the sandbox. File content is injected as FILE_CONTENT variable.", parameters: SandboxFileParams, execute: sandboxFileExec } as any);
  pi.registerTool({ name: "ctx_execute_file", label: "Sandbox File", description: "Execute file in sandbox. (DEPRECATED: use sandbox_file instead)", parameters: CtxExecuteFileParams, async execute(tcId: string, p: any) { deprecationLog("ctx_execute_file", "sandbox_file"); return sandboxFileExec(tcId, p); } } as any);

  // 5. sandbox_batch (new) / ctx_batch_execute (deprecated) — atomic batch
  const sandboxBatchExec = async (_toolCallId: string, params: any): Promise<any> => {
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
  };
  pi.registerTool({ name: "sandbox_batch", label: "Sandbox Batch", description: "Run multiple code executions and searches atomically as a batch.", parameters: SandboxBatchParams, execute: sandboxBatchExec } as any);
  pi.registerTool({ name: "ctx_batch_execute", label: "Sandbox Batch", description: "Run batch operations. (DEPRECATED: use sandbox_batch instead)", parameters: CtxBatchExecuteParams, async execute(tcId: string, p: any) { deprecationLog("ctx_batch_execute", "sandbox_batch"); return sandboxBatchExec(tcId, p); } } as any);

  // 6. content_index (new) / ctx_index (deprecated) — index content into FTS5
  const contentIndexExec = async (_toolCallId: string, params: any): Promise<any> => {
    try {
      const result = await ctxIndex(deps.contentStore!, params as CtxIndexInput);
      return textResult(
        `Indexed "${result.label}": ${result.totalChunks} chunks (${result.codeChunks} code)`,
        result as unknown as Record<string, unknown>,
      );
    } catch (err) {
      return textResult(`Index error: ${err}`, { error: true });
    }
  };
  pi.registerTool({ name: "content_index", label: "Content Index", description: "Chunk content or a file and index into FTS5 for fast search.", parameters: ContentIndexParams, execute: contentIndexExec } as any);
  pi.registerTool({ name: "ctx_index", label: "Content Index", description: "Index content into FTS5. (DEPRECATED: use content_index instead)", parameters: CtxIndexParams, async execute(tcId: string, p: any) { deprecationLog("ctx_index", "content_index"); return contentIndexExec(tcId, p); } } as any);

  // 7. content_search (new) / ctx_search (deprecated) — query FTS5 content store
  const contentSearchExec = async (_toolCallId: string, params: any): Promise<any> => {
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
  };
  pi.registerTool({ name: "content_search", label: "Content Search", description: "Search indexed content using FTS5 full-text search.", parameters: ContentSearchParams, execute: contentSearchExec } as any);
  pi.registerTool({ name: "ctx_search", label: "Content Search", description: "Search indexed content. (DEPRECATED: use content_search instead)", parameters: CtxSearchParams, async execute(tcId: string, p: any) { deprecationLog("ctx_search", "content_search"); return contentSearchExec(tcId, p); } } as any);

  // 8. content_fetch (new) / ctx_fetch_and_index (deprecated) — fetch URL
  const contentFetchExec = async (_toolCallId: string, params: any): Promise<any> => {
    try {
      const result = await ctxFetchAndIndex(deps.contentStore!, params as CtxFetchAndIndexInput);
      return textResult(
        `Fetched and indexed "${result.label}": ${result.totalChunks} chunks`,
        result as unknown as Record<string, unknown>,
      );
    } catch (err) {
      return textResult(`Fetch error: ${err}`, { error: true });
    }
  };
  pi.registerTool({ name: "content_fetch", label: "Content Fetch", description: "Fetch a URL, convert to markdown, and index into FTS5 content store.", parameters: ContentFetchParams, execute: contentFetchExec } as any);
  pi.registerTool({ name: "ctx_fetch_and_index", label: "Content Fetch", description: "Fetch URL and index. (DEPRECATED: use content_fetch instead)", parameters: CtxFetchAndIndexParams, async execute(tcId: string, p: any) { deprecationLog("ctx_fetch_and_index", "content_fetch"); return contentFetchExec(tcId, p); } } as any);

  // 9. compactor_stats (new) / ctx_stats (deprecated) — context savings dashboard
  const statsExec = async (): Promise<any> => {
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
  };
  pi.registerTool({ name: "compactor_stats", label: "Compactor Stats", description: "Show context savings dashboard — session events, compactions, indexed content.", parameters: StatsParams, execute: statsExec } as any);
  pi.registerTool({ name: "ctx_stats", label: "Compactor Stats", description: "Show stats dashboard. (DEPRECATED: use compactor_stats instead)", parameters: CtxStatsParams, async execute() { deprecationLog("ctx_stats", "compactor_stats"); return statsExec(); } } as any);

  // 10. compactor_doctor (new) / ctx_doctor (deprecated) — diagnostics checklist
  const doctorExec = async (): Promise<any> => {
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
  };
  pi.registerTool({ name: "compactor_doctor", label: "Compactor Doctor", description: "Run diagnostics checklist — validate config, DB, FTS5, runtimes.", parameters: DoctorParams, execute: doctorExec } as any);
  pi.registerTool({ name: "ctx_doctor", label: "Compactor Doctor", description: "Run diagnostics. (DEPRECATED: use compactor_doctor instead)", parameters: CtxDoctorParams, async execute() { deprecationLog("ctx_doctor", "compactor_doctor"); return doctorExec(); } } as any);

  // 11. context_budget — estimate remaining context window
  pi.registerTool(({
    name: "context_budget",
    label: "Context Budget",
    description: "Estimate remaining context window (% full, tokens left) and get advice on whether to compact.",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
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
  } as any));
}

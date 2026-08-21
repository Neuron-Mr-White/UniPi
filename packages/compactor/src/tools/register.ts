/**
 * Tool registration — register all compactor tools with Pi's ExtensionAPI
 *
 * Each tool is registered via pi.registerTool() with proper TypeBox schemas
 * so the LLM can discover and invoke them.
 *
 * Tool names:
 *   compact, session_recall, sandbox, sandbox_file, sandbox_batch,
 *   compactor_stats, compactor_doctor, context_budget
 *
 * Deprecated aliases for backward compatibility:
 *   vcc_recall, ctx_execute, ctx_execute_file, ctx_batch_execute,
 *   ctx_stats, ctx_doctor
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vccRecall } from "./vcc-recall.js";
import { ctxExecute, type CtxExecuteInput } from "./ctx-execute.js";
import { ctxExecuteFile, type CtxExecuteFileInput } from "./ctx-execute-file.js";
import { ctxBatchExecute, type BatchItem } from "./ctx-batch-execute.js";
import { ctxStats, type CtxStatsResult } from "./ctx-stats.js";
import { ctxDoctor, type DoctorResult } from "./ctx-doctor.js";
import { contextBudgetTool } from "./context-budget.js";
import { recallBlocksFromContext } from "../session/recall-blocks.js";
import { filterNoise } from "../compaction/filter-noise.js";
import { loadConfig } from "../config/manager.js";
import type { SessionDB } from "../session/db.js";
import type { Language, NormalizedBlock, RuntimeCounters } from "../types.js";
import type { PolyglotExecutor } from "../executor/executor.js";

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
  query: Type.Optional(Type.String({ description: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. #N:path drills into a file's content from an entry." })),
  expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" })),
  page: Type.Optional(Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1.", minimum: 1 })),
  scope: Type.Optional(Type.Union([Type.Literal("lineage"), Type.Literal("all")], {
    description: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
  })),
  mode: Type.Optional(Type.Union([Type.Literal("hybrid"), Type.Literal("touched")], {
    description: "What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.",
  })),
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
    ]),
    { description: "Array of execute commands to run atomically" },
  ),
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

// --- Registration ---

export interface CompactorToolDeps {
  sessionDB: SessionDB;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
  sandbox?: {
    executor: PolyglotExecutor;
    allowedLanguages: Language[];
  };
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
    async execute(_toolCallId: string, params: any): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> {
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
      return jsonResult({ success: true, message: "Compaction triggered. Stats will be available after next compact event." }, "Compaction triggered");
    },
  } as any));

  // 2. session_recall (new) / vcc_recall (deprecated) — search session history
  const recallExec = async (_toolCallId: string, params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    const c = deps.getCounters?.();
    if (c) { c.recallQueries++; }
    const config = loadConfig(ctx?.cwd ?? process.cwd());
    const liveBlocks = ctx ? filterNoise(recallBlocksFromContext(ctx), config.pipeline?.customNoisePatterns) : [];
    const blocks = liveBlocks.length > 0 ? liveBlocks : deps.getBlocks();
    const result = vccRecall(blocks, {
      query: params.query,
      scope: params.scope,
      mode: params.mode,
      page: params.page,
      expand: params.expand,
    });
    return textResult(result.text, { query: params.query ?? null });
  };
  pi.registerTool({
    name: "session_recall",
    label: "Session Recall",
    description:
      "Search session history using keyword or regex search. Find previous goals, files, commits, decisions, and context — " +
      "including anything dropped by compaction. Reach for this before telling the user you no longer have the context. " +
      "Plain keywords work best; a regex pattern is also accepted. Results are paged (page); pass expand with entry indices " +
      "to read full untruncated content. Use mode:'touched' to list files worked on in this session with their entry indices, " +
      "and #N:path to drill into a file's content from an entry (#N:path:full for all lines). Only the current session is " +
      "searchable — earlier sessions are not.",
    parameters: RecallParams,
    execute: recallExec,
  } as any);

  // Sandbox tools are session-scoped and only registered when enabled.
  if (deps.sandbox) {
  const { executor, allowedLanguages } = deps.sandbox;
  const assertAllowedLanguage = (language: Language): void => {
    if (!allowedLanguages.includes(language)) {
      throw new Error(`Language "${language}" is disabled by Compactor sandbox settings. Allowed: ${allowedLanguages.join(", ") || "none"}`);
    }
  };

  // 3. sandbox (new) / ctx_execute (deprecated) — run code in sandbox
  const sandboxExec = async (_toolCallId: string, params: any): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    try {
      const c = deps.getCounters?.();
      if (c) { c.sandboxRuns++; }
      deps.sessionDB.incrementSandboxRuns(deps.getSessionId());
      assertAllowedLanguage(params.language as Language);
      const result = await ctxExecute(params as CtxExecuteInput, executor);
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

  // 4. sandbox_file (new) / ctx_execute_file (deprecated) — execute file
  const sandboxFileExec = async (_toolCallId: string, params: any): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    try {
      const c = deps.getCounters?.();
      if (c) { c.sandboxRuns++; }
      deps.sessionDB.incrementSandboxRuns(deps.getSessionId());
      assertAllowedLanguage(params.language as Language);
      const result = await ctxExecuteFile(params as CtxExecuteFileInput, executor);
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

  // 5. sandbox_batch (new) / ctx_batch_execute (deprecated) — atomic batch (execute only)
  const sandboxBatchExec = async (_toolCallId: string, params: any): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    try {
      const c = deps.getCounters?.();
      if (c) { c.sandboxRuns++; }
      deps.sessionDB.incrementSandboxRuns(deps.getSessionId());
      for (const item of params.items as BatchItem[]) assertAllowedLanguage(item.language);
      const result = await ctxBatchExecute(params.items as BatchItem[], executor);
      const summaries = result.results.map((r, i) => {
        const s = r.result.stdout?.slice(0, 200) || "(no output)";
        return `[${i}] execute → ${r.result.exitCode === 0 ? "ok" : "fail"}: ${s}`;
      });
      return textResult(`Batch results (${result.results.length} items):\n${summaries.join("\n")}`, result as unknown as Record<string, unknown>);
    } catch (err) {
      return textResult(`Batch error: ${err}`, { error: true });
    }
  };
  pi.registerTool({ name: "sandbox_batch", label: "Sandbox Batch", description: "Run multiple code executions atomically as a batch.", parameters: SandboxBatchParams, execute: sandboxBatchExec } as any);
  }

  // 6. compactor_stats (new) / ctx_stats (deprecated) — context savings dashboard
  const statsExec = async (): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    try {
      const result = await ctxStats(deps.sessionDB, deps.getSessionId(), deps.getCounters?.());
      const lines = [
        `📊 Compactor Stats`,
        `Session events: ${result.sessionEvents}`,
        `Compactions: ${result.compactions}`,
        `Tokens saved: ${result.tokensSaved}`,
        `Sandbox runs: ${result.sandboxRuns}`,
        `Search queries: ${result.searchQueries}`,
      ];
      return textResult(lines.join("\n"), result as unknown as Record<string, unknown>);
    } catch (err) {
      return textResult(`Stats error: ${err}`, { error: true });
    }
  };
  pi.registerTool({ name: "compactor_stats", label: "Compactor Stats", description: "Show context savings dashboard — session events, compactions, tool usage.", parameters: StatsParams, execute: statsExec } as any);

  // 7. compactor_doctor (new) / ctx_doctor (deprecated) — diagnostics checklist
  const doctorExec = async (): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> => {
    try {
      const result = await ctxDoctor(deps.sessionDB);
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
  pi.registerTool({ name: "compactor_doctor", label: "Compactor Doctor", description: "Run diagnostics checklist — validate config, DB, runtimes.", parameters: DoctorParams, execute: doctorExec } as any);

  // 8. context_budget — estimate remaining context window
  pi.registerTool(({
    name: "context_budget",
    label: "Context Budget",
    description: "Estimate remaining context window (% full, tokens left) and get advice on whether to compact.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>> {
      const config = loadConfig(ctx?.cwd ?? process.cwd());
      const liveUsage = ctx?.getContextUsage?.();
      let estimatedTokens: number | undefined = liveUsage?.tokens ?? undefined;
      let contextWindow = liveUsage?.contextWindow;

      if (estimatedTokens === undefined) {
        const blocks = deps.getBlocks();
        estimatedTokens = blocks.reduce((sum, b) => {
          const text = b.kind === "tool_call"
            ? `${b.name} ${JSON.stringify((b as any).args ?? {})}`
            : b.kind === "tool_result"
              ? `${b.name} ${(b as any).text ?? ""}`
              : (b as any).text ?? "";
          return sum + Math.ceil(text.length / 4);
        }, 0);
      }

      const message = contextBudgetTool(estimatedTokens, contextWindow, config.autoCompaction);
      return textResult(message);
    },
  } as any));
}
